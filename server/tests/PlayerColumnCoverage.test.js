/**
 * 玩家指向列的分档覆盖闸（L3）：新模型加了"像玩家 id"的列却没进三档任何一档，这里就红。
 *
 * 为什么需要：L1 约定列名 + L2 information_schema 现查，盖得住 `player_id` / `*_player_id`。
 * 但现网真实存在 `player_a_id`、`attacker_id`、`sender_id` 这类短名 —— 2026-09 扩档前它们
 * 全部掉进 uncovered，删号时**一动不动**。新增玩法表若再起一个 `uid` / `from_id`，
 * 同样会静默漏删。本闸扫 models/*.js 的字段名，逼开发者在 PlayerCascadePurge 登记分档。
 *
 * 判据用合成输入证伪（控制跑），不往真实模型里注入。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const PlayerCascadePurge = require('../game/persistence/PlayerCascadePurge');

const MODELS = path.join(__dirname, '..', 'models');

/**
 * 纯函数：从模型源码里抠出"像玩家指向列"的字段名，返回未分档的那些。
 *
 * 只盯玩家指向列，不误伤 beast/sect/item 等其它实体：
 *   · `*_player_id`（长名引用，如 killer_player_id）
 *   · 恰好是「角色短名 + _id」（attacker_id / seller_id / uid …）
 * 不匹配 attacker_beast_id / winner_sect_id —— 那是灵兽/宗门，不是玩家。
 */
function isPlayerPointingColumn(name) {
    if (/_player_ids?$/.test(name)) return true;
    // uid 是完整列名（没有 _id 后缀），必须单独认。
    // open_id / union_id 是第三方身份键（QQ openid），不是指向 players.id 的列，不进本闸。
    if (/^uid$/.test(name)) return true;
    return /^(player|owner|user|sender|receiver|seller|buyer|bidder|admin|attacker|defender|winner|loser|killer|challenger|acceptor|appreciator)_id$/.test(name);
}

function findUncoveredPlayerColumns(fieldNames) {
    const uncovered = [];
    for (const name of fieldNames) {
        // `uid`/`openid` 不带下划线前缀也要盯（它们正是最容易漏删的新列名）
        if (!/(_id|^uid|^openid)$/.test(name)) continue;
        if (!isPlayerPointingColumn(name)) continue;
        // 复数列（defender_player_ids）等值匹配不了 —— 允许 uncovered，但必须是复数
        if (/_ids$/.test(name)) continue;
        const { purge, relation, references } = PlayerCascadePurge.classify([
            { table: 'probe', column: name }
        ]);
        if (!purge.length && !relation.length && !references.length) {
            uncovered.push(name);
        }
    }
    return uncovered.sort();
}

/** 从 sequelize.define 字段块里抠出 `field_name: {` 形状的键 */
function extractFieldNames(source) {
    const names = [];
    const re = /^\s{4}([a-z][a-z0-9_]*)\s*:\s*\{/gim;
    let m;
    while ((m = re.exec(source))) names.push(m[1]);
    return names;
}

describe('模型里的玩家指向列必须进三档之一（未来新表的安全网）', () => {
    test('现网 models/ 全部已分档', () => {
        const files = fs.readdirSync(MODELS).filter(f => f.endsWith('.js'));
        expect(files.length).toBeGreaterThan(50);   // 扫描器空跑的底线

        const allFields = [];
        for (const f of files) {
            const src = fs.readFileSync(path.join(MODELS, f), 'utf8');
            for (const name of extractFieldNames(src)) {
                allFields.push(name);
            }
        }
        // 底线：必须真的抠出了玩家列，否则下面的 uncovered 断言是空跑
        expect(allFields).toEqual(expect.arrayContaining(['player_id', 'sender_id', 'player_a_id', 'attacker_id']));

        const uncovered = findUncoveredPlayerColumns([...new Set(allFields)]);
        expect(uncovered).toEqual([]);
    });

    test('控制跑：合成一个未登记列名会被点名；已登记的不会', () => {
        expect(findUncoveredPlayerColumns(['player_id', 'item_id', 'instance_id'])).toEqual([]);
        // 新玩法表起名 uid —— 既非归属也非引用，必须红
        expect(findUncoveredPlayerColumns(['uid'])).toEqual(['uid']);
        // 第三方身份键不是玩家指向列，不进本闸
        expect(findUncoveredPlayerColumns(['open_id', 'union_id'])).toEqual([]);
        // 短名引用列扩档后应进引用
        expect(findUncoveredPlayerColumns(['winner_id', 'buyer_id'])).toEqual([]);
        // 复数列刻意 uncovered，但本闸按设计跳过（等值匹配不了，另有 countReferences 点名）
        expect(findUncoveredPlayerColumns(['defender_player_ids'])).toEqual([]);
    });
});
