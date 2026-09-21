/**
 * 融资负债两表对账（只读，不写任何行）
 *
 * 背景：强平与 GM 强平原先在"卖出所得刚好覆盖本次偿还额"这一支里把 players.stock_margin_debt 直接写成 0，
 * 而 stock_margin_accounts.debt 只减去了实际偿还额 —— 现金为 0 时这一支必然成立，于是资不抵债越深、
 * 被抹掉的债越多（探针 scripts/smoke_stock_market.js K8/K8b 已把这条钉住）。
 * 代码已修，但**存量还在库里**：这一版之前被强平平掉的账户，两表仍可能不一致。
 *
 * 用法：cd server && node --env-file=.env scripts/audit_margin_debt_split.js
 *      线上改跑 .env_pord 那份（只读，不写；但请先确认连的是哪个库）。
 * 输出：不一致的账户清单 + 被抹掉的负债总额，供业主决定是否补记。
 */
'use strict';

const sequelize = require('../config/database');
const Player = require('../models/player');
const StockMarginAccount = require('../models/stockMarginAccount');

const B = v => { try { return BigInt(v == null ? 0 : v); } catch (e) { return 0n; } };

(async () => {
    let code = 0;
    try {
        const accounts = await StockMarginAccount.findAll({ raw: true });
        const byId = new Map((await Player.findAll({
            attributes: ['id', 'username', 'nickname', 'stock_margin_debt'],
            raw: true
        })).map(p => [Number(p.id), p]));

        const split = [];
        for (const acc of accounts) {
            const p = byId.get(Number(acc.player_id));
            if (!p) { split.push({ pid: acc.player_id, name: '(玩家已不存在)', acc: B(acc.debt), col: 0n }); continue; }
            const col = B(p.stock_margin_debt);
            const accDebt = B(acc.debt);
            if (col !== accDebt) split.push({ pid: acc.player_id, name: p.username, acc: accDebt, col });
        }
        const gap = split.reduce((s, r) => s + (r.acc - r.col), 0n);
        console.log(`融资账户 ${accounts.length} 个，两表不一致 ${split.length} 个，players 比 accounts 少记合计 ${gap.toString()} 灵石`);
        for (const r of split.slice(0, 50)) {
            console.log(`  玩家 ${r.pid} ${r.name}: accounts.debt=${r.acc.toString()} players.stock_margin_debt=${r.col.toString()}`
                + ` 差=${(r.acc - r.col).toString()}`);
        }
        if (split.length > 50) console.log(`  …另有 ${split.length - 50} 个`);
        console.log(split.length === 0 ? '结论：两表一致，无需补记。' : '结论：需要业主拍板是否按 accounts 补记 players（本脚本不改数据）。');
    } catch (e) {
        code = 1;
        console.error('对账失败：', e.message);
    } finally {
        await sequelize.close().catch(() => {});
        process.exit(code);
    }
})();
