const express = require('express');
const router = express.Router();
const sequelize = require('../config/database');
const Player = require('../models/player');
const Realm = require('../models/realm');
const auth = require('../middleware/auth');
const { Transaction } = require('sequelize');

const calcExpCapByRank = (rank) => {
    const r = Math.max(1, Number(rank) || 1);
    return BigInt(Math.floor(1000 * Math.pow(r, 3)));
};

const getRealmExpCap = (realm) => {
    if (realm && realm.exp_cap !== undefined && realm.exp_cap !== null) {
        try {
            return BigInt(realm.exp_cap);
        } catch (e) {
            return calcExpCapByRank(realm.rank);
        }
    }
    return calcExpCapByRank(realm?.rank);
};

const calcSuccessChance = (rank, toxicity) => {
    const r = Math.max(1, Number(rank) || 1);
    const tox = Math.max(0, Number(toxicity) || 0);
    const base = 0.9 - (r - 1) * 0.01;
    const toxPenalty = Math.min(0.3, tox * 0.001);
    return Math.max(0.2, Math.min(0.9, base - toxPenalty));
};

router.post('/try', auth, async (req, res) => {
    const t = await sequelize.transaction();
    try {
        const player = await Player.findByPk(req.user.id, { transaction: t, lock: Transaction.LOCK.UPDATE });
        if (!player) {
            await t.rollback();
            return res.status(404).json({ message: '玩家不存在' });
        }

        const currentRealm = await Realm.findByPk(player.realm, { transaction: t });
        if (!currentRealm) {
            await t.rollback();
            return res.status(400).json({ message: '当前境界数据异常，无法突破' });
        }

        const nextRealm = await Realm.findOne({ where: { rank: currentRealm.rank + 1 }, transaction: t });
        if (!nextRealm) {
            await t.rollback();
            return res.status(400).json({ message: '已是最高境界，无法继续突破' });
        }

        const expCap = getRealmExpCap(currentRealm);
        const currentExp = BigInt(player.exp || 0);

        if (currentExp < expCap) {
            await t.rollback();
            return res.status(400).json({
                message: `修为未达上限，无法突破（${currentExp.toString()} / ${expCap.toString()}）`
            });
        }

        const chance = calcSuccessChance(currentRealm.rank, player.toxicity);
        const roll = Math.random();
        const success = roll < chance;

        if (!success) {
            await t.commit();
            return res.json({
                success: false,
                message: `突破失败，道心不稳（成功率 ${(chance * 100).toFixed(0)}%），再行打磨修为。`,
                data: {
                    realm: player.realm,
                    exp: player.exp,
                    exp_cap: expCap.toString(),
                    next_realm: nextRealm.name
                }
            });
        }

        const oldRealm = player.realm;
        player.realm = nextRealm.name;
        // 突破成功，保留全部修为（累计修为模式）
        // const remainingExp = currentExp - expCap;
        // player.exp = remainingExp > 0n ? remainingExp.toString() : '0';
        // 保持当前修为不变，仅提升境界和上限
        player.exp = currentExp.toString();
        player.lifespan_max = nextRealm.base_lifespan ?? player.lifespan_max;

        const nextAttrs = {
            ...(player.attributes || {}),
            hp_max: nextRealm.base_hp,
            mp_max: nextRealm.base_mp,
            atk: nextRealm.base_atk,
            def: nextRealm.base_def,
            speed: nextRealm.base_speed,
            sense: nextRealm.base_sense,
            mp_regen_rate: nextRealm.mp_regen_rate,
            toxicity_decay: nextRealm.toxicity_decay
        };
        player.attributes = nextAttrs;

        player.hp_current = nextAttrs.hp_max ?? player.hp_current;
        player.mp_current = nextAttrs.mp_max ?? player.mp_current;

        await player.save({ transaction: t });
        await t.commit();

        return res.json({
            success: true,
            message: `突破成功！境界提升至「${nextRealm.name}」。`,
            data: {
                old_realm: oldRealm,
                new_realm: nextRealm.name,
                exp: player.exp,
                exp_cap: getRealmExpCap(nextRealm).toString(),
                unlocked: {
                    mp_regen_rate: nextRealm.mp_regen_rate,
                    toxicity_decay: nextRealm.toxicity_decay
                }
            }
        });
    } catch (error) {
        await t.rollback();
        console.error('突破失败:', error);
        return res.status(500).json({ message: '服务器错误' });
    }
});

module.exports = router;
