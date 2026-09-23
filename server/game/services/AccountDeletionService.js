/**
 * 账号数据清除编排（清档留号 / 注销删号 两档）。
 *
 * 为什么单独一层，而不是让路由自己拼：
 *   玩家自助 `POST /api/account/delete` 与 GM `DELETE /api/admin/players/:id` 必须是同一套语义
 *   （同一个预览、同一个级联、同一个事务边界）。路由各自写一遍 = 两套口径迟早分叉，
 *   而"删一半"在本库没有任何外键兜底。
 *
 * 两档（account_mode）：
 *   keep   — 清玩法数据（含未来新表，走 PlayerCascadePurge），保留 username/password/id/QQ 绑定，
 *            players 行按 PlayerService.buildFreshPlayerState 重开；token_version+1 强制重登。
 *   delete — 归属+关系全清，players 行删除，QQ 绑定随号走；引用档（他人历史）只报告不删。
 *
 * 聊天：业主拍板「保留原文」，本服务不碰 chats。
 */
'use strict';

const sequelize = require('../../config/database');
const Player = require('../../models/player');
const AdminLog = require('../../models/admin_log');
const PlayerCascadePurge = require('../persistence/PlayerCascadePurge');
const PlayerService = require('../core/PlayerService');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');

const ACCOUNT_MODES = ['keep', 'delete'];
const CONFIRM_PHRASES = {
    keep: '清空数据',
    delete: '删除账号'
};

/** keep 模式下跳过的归属表：登录身份，不属玩法数据 */
const KEEP_SKIP_TABLES = [...PlayerCascadePurge.ACCOUNT_IDENTITY_TABLES];

function assertMode(accountMode) {
    if (!ACCOUNT_MODES.includes(accountMode)) {
        throw new AppError(
            `account_mode 必须是 ${ACCOUNT_MODES.join(' / ')}，收到 ${JSON.stringify(accountMode)}`,
            400,
            ErrorCodes.VALIDATION_ERROR
        );
    }
    return accountMode;
}

/**
 * 前置收口：清数据前把"卡在半中间"的进行中状态收干净，避免删挂单让对方钱货两空。
 * 尽力而为 —— 单个收口失败会记进 settled.errors，不阻断删除（这些行反正会被级联清掉）；
 * 真正阻断的是"收口后仍有结构性冲突"（目前没有，预留 409 通道）。
 */
async function settleInFlight(playerId, { transaction = null } = {}) {
    const settled = {
        auctions_cancelled: 0,
        market_listings_cancelled: 0,
        dao_companion_dissolved: 0,
        multi_dungeon_left: 0,
        errors: []
    };
    const id = PlayerCascadePurge.assertPlayerId(playerId);
    const q = (sql, options = {}) => sequelize.query(sql, { transaction, ...options });

    try {
        // 进行中道侣：整行会在关系档被删；这里先通知对方（尽力而为）
        const [pairs] = await q(
            `SELECT id, player_a_id, player_b_id FROM dao_companions
             WHERE (player_a_id = ${id} OR player_b_id = ${id})
               AND status IN ('pending', 'accepted')`
        );
        for (const row of pairs) {
            const partnerId = Number(row.player_a_id) === id ? Number(row.player_b_id) : Number(row.player_a_id);
            try {
                const WebSocketNotificationService = require('./WebSocketNotificationService');
                WebSocketNotificationService.notifyPlayerUpdate(partnerId, 'dao_companion_dissolved', {
                    reason: '对方清除了账号数据'
                });
            } catch (e) {
                settled.errors.push(`dao_companion notify: ${e.message}`);
            }
            settled.dao_companion_dissolved += 1;
        }

        // 进行中拍卖挂单：调用业务撤销（退押金/退物），失败则行仍会被级联删掉
        const [openAuctions] = await q(
            `SELECT id FROM auctions WHERE seller_id = ${id} AND status = 'open'`
        );
        if (openAuctions.length) {
            try {
                const AuctionService = require('./AuctionService');
                for (const row of openAuctions) {
                    await AuctionService.cancelAuction(id, Number(row.id), '账号数据清除');
                    settled.auctions_cancelled += 1;
                }
            } catch (e) {
                settled.errors.push(`auction cancel: ${e.message}`);
            }
        }

        // 坊市上架中挂单
        const [openListings] = await q(
            `SELECT id FROM market_listings WHERE seller_id = ${id} AND status = 'active'`
        );
        if (openListings.length) {
            try {
                const MarketService = require('./MarketService');
                for (const row of openListings) {
                    await MarketService.cancelListing(id, Number(row.id));
                    settled.market_listings_cancelled += 1;
                }
            } catch (e) {
                settled.errors.push(`market cancel: ${e.message}`);
            }
        }

        // 多人副本进行中：队长走 dissolve（与玩家主动解散同一条路径），成员行会被归属档清掉
        const [leaderRows] = await q(
            `SELECT i.id FROM multi_dungeon_instance i
             JOIN multi_dungeon_member m ON m.instance_id = i.id AND m.player_id = ${id}
             WHERE i.status IN ('waiting', 'running') AND m.role = 'leader'`
        );
        if (leaderRows.length) {
            try {
                const MultiDungeonService = require('./MultiDungeonService');
                await MultiDungeonService.dissolve(id);
                settled.multi_dungeon_left += leaderRows.length;
            } catch (e) {
                settled.errors.push(`multi_dungeon dissolve: ${e.message}`);
            }
        }
    } catch (e) {
        settled.errors.push(`settle query: ${e.message}`);
    }

    return settled;
}

/**
 * keep 模式：清完派生行后，把 players 行整行重开。
 *
 * 为什么走裸 SQL 而不是 instance.save()：
 *   清档语义就是"全量覆盖"，而 blobWriteGuard 禁止事务外整块写 JSON 列（防旧快照覆盖）。
 *   这里是有意的整行重置，不是"读-改-写某一键"；走 UPDATE 一次写完，并手动 +state_version，
 *   语义上等价于 GM 重置，且不会被守卫误拦。
 */
async function rewritePlayersRow(playerId, { nickname, transaction }) {
    const fresh = PlayerService.buildFreshPlayerState(nickname);
    const sets = [];
    for (const [key, value] of Object.entries(fresh)) {
        const col = key;
        if (value === null) {
            sets.push(`\`${col}\` = NULL`);
        } else if (typeof value === 'number' || typeof value === 'bigint') {
            sets.push(`\`${col}\` = ${Number(value)}`);
        } else if (typeof value === 'boolean') {
            sets.push(`\`${col}\` = ${value ? 1 : 0}`);
        } else if (typeof value === 'object') {
            // buildFreshPlayerState 里对象字段（attributes / spirit_roots）尚未 stringify
            sets.push(`\`${col}\` = ${sequelize.escape(JSON.stringify(value))}`);
        } else {
            sets.push(`\`${col}\` = ${sequelize.escape(String(value))}`);
        }
    }
    // 强制全端重登：token_version 对不上 JWT 里的 v，auth 中间件会 401
    sets.push('`token_version` = `token_version` + 1');
    sets.push('`state_version` = `state_version` + 1');
    sets.push('`database_version` = 1');

    await sequelize.query(
        `UPDATE players SET ${sets.join(', ')} WHERE id = ${PlayerCascadePurge.assertPlayerId(playerId)}`,
        { transaction }
    );
}

/**
 * 只读预览：将删多少、引用留多少。
 * @returns {Promise<{tables,total,references,account_mode_options,notes}>}
 */
async function preview(playerId, options = {}) {
    const id = PlayerCascadePurge.assertPlayerId(playerId);
    const skipTables = options.accountMode === 'keep' ? KEEP_SKIP_TABLES : [];
    const result = await PlayerCascadePurge.preview(id, {
        transaction: options.transaction,
        skipTables
    });
    return {
        ...result,
        account_mode_options: ACCOUNT_MODES,
        confirm_phrases: CONFIRM_PHRASES,
        notes: [
            '引用档（他人历史）不会删除，仅解除与你的玩法数据关联',
            '聊天记录保留原文（业主拍板）',
            '进行中的道侣/挂单会先收口'
        ]
    };
}

/**
 * 执行清除。整个「级联 + 账号处置」在一个事务里，失败整笔回滚。
 *
 * @param {number} playerId
 * @param {{accountMode:'keep'|'delete', newNickname?:string, actorId?:number, reason?:string, includeAdmin?:boolean, transaction?:Object}} options
 * @returns {Promise<Object>} 与 preview 同构 + settled / account_mode
 */
async function execute(playerId, options = {}) {
    const id = PlayerCascadePurge.assertPlayerId(playerId);
    const accountMode = assertMode(options.accountMode);
    const externalTx = options.transaction || null;

    // 前置收口在主事务外：业务撤销各自带事务，失败只记 errors，不把主事务拖死
    const settled = await settleInFlight(id);

    const t = externalTx || await sequelize.transaction();
    const ownTx = !externalTx;
    try {
        const skipTables = accountMode === 'keep' ? KEEP_SKIP_TABLES : [];
        const purged = await PlayerCascadePurge.purge(id, { transaction: t, skipTables });
        const references = await PlayerCascadePurge.countReferences(id, { transaction: t });

        // AdminLog.admin_id 是引用档（审计必须活过被删的号）—— 但"我是操作者"的那批
        // 在 delete 模式下若不处理会留下指向已删 id 的审计。按现网 GM 删号口径：
        // 目标自己的 admin 操作记录随号走（admin_id = 被删者曾是管理员的情况极罕见，
        // 而 target_id 指向被删者的记录保留，供审计）。这里只清"被删者当管理员时写下的日志"。
        if (accountMode === 'delete') {
            await AdminLog.destroy({ where: { admin_id: id }, transaction: t });
        }

        let username = null;
        let nickname = null;
        const [rows] = await sequelize.query(
            `SELECT username, nickname FROM players WHERE id = ${id}`,
            { transaction: t }
        );
        if (!rows.length) {
            throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
        }
        username = rows[0].username;
        nickname = rows[0].nickname;

        if (accountMode === 'keep') {
            let nextNickname = nickname;
            if (options.newNickname) {
                const wanted = String(options.newNickname).trim();
                if (!wanted) {
                    throw new AppError('new_nickname 不能为空', 400, ErrorCodes.VALIDATION_ERROR);
                }
                const [taken] = await sequelize.query(
                    `SELECT id FROM players WHERE nickname = ${sequelize.escape(wanted)} AND id <> ${id}`,
                    { transaction: t }
                );
                if (taken.length) {
                    throw new AppError('该道号已被使用，请选择其他道号', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
                }
                nextNickname = wanted;
            }
            await rewritePlayersRow(id, { nickname: nextNickname, transaction: t });
            nickname = nextNickname;
        } else {
            await sequelize.query(`DELETE FROM players WHERE id = ${id}`, { transaction: t });
        }

        // 审计：自助时 actorId=本人；GM 时 actorId=管理员
        await AdminLog.create({
            admin_id: options.actorId || id,
            action: accountMode === 'keep' ? 'account_wipe' : 'account_delete',
            target_id: id,
            details: JSON.stringify({
                account_mode: accountMode,
                username,
                nickname,
                purged_total: purged.total,
                purged_tables: purged.tables.length,
                kept_references: references.map(r => `${r.table}.${r.column}=${r.rows}`),
                settled,
                reason: options.reason || null
            }),
            ip: options.ip || null
        }, { transaction: t });

        if (ownTx) await t.commit();

        return {
            account_mode: accountMode,
            player_id: id,
            username,
            nickname,
            purged_total: purged.total,
            purged_tables: purged.tables,
            kept_references: references,
            settled,
            relogin_required: true
        };
    } catch (error) {
        if (ownTx && !t.finished) await t.rollback();
        throw error;
    }
}

module.exports = {
    ACCOUNT_MODES,
    CONFIRM_PHRASES,
    KEEP_SKIP_TABLES,
    assertMode,
    preview,
    execute,
    settleInFlight,
    rewritePlayersRow
};
