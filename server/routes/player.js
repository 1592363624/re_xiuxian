/**
 * 玩家相关路由
 */
const express = require('express');
const router = express.Router();
const Player = require('../models/player');
const Realm = require('../models/realm');
const auth = require('../middleware/auth'); // 假设有认证中间件

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

// 获取当前玩家信息
router.get('/me', auth, async (req, res) => {
    try {
        const player = await Player.findByPk(req.user.id);
        
        if (!player) {
            return res.status(404).json({ message: '玩家不存在' });
        }

        const playerData = player.toJSON();
        const attributes = typeof playerData.attributes === 'string' ? JSON.parse(playerData.attributes) : playerData.attributes;

        const realm = await Realm.findByPk(player.realm);
        const expCap = getRealmExpCap(realm);
        const nextRealm = realm ? await Realm.findOne({ where: { rank: realm.rank + 1 } }) : null;
        const currentExp = BigInt(player.exp || 0);
        const canBreakthrough = !!nextRealm && currentExp >= expCap;

        const hpMax = attributes?.hp_max ?? realm?.base_hp ?? 100;
        const mpMax = attributes?.mp_max ?? realm?.base_mp ?? 0;

        // 合并计算属性
        const responseData = {
            ...playerData,
            hp_current: playerData.hp_current, // 使用数据库中的真实气血
            hp_max: hpMax,
            mp_current: playerData.mp_current, // 使用数据库中的真实灵力
            mp_max: mpMax,
            exp_next: expCap.toString(),
            exp_cap: expCap.toString(),
            exp_progress: expCap > 0n ? Number(currentExp * 10000n / expCap) / 10000 : 0,
            can_breakthrough: canBreakthrough,
            next_realm: nextRealm?.name || null,
            attributes
        };

        res.json(responseData);
    } catch (error) {
        console.error('获取玩家信息失败:', error);
        res.status(500).json({ message: '服务器错误' });
    }
});

// 更新玩家信息 (存档)
router.put('/me', auth, async (req, res) => {
    try {
        const { id } = req.user;
        const updates = req.body;
        
        const player = await Player.findByPk(id);
        if (!player) {
            return res.status(404).json({ message: '玩家不存在' });
        }

        // 允许更新的字段白名单
        const allowedUpdates = [
            'nickname', 'realm', 'exp', 'spirit_stones', 
            'lifespan_current', 'lifespan_max', 'attributes',
            'hp_current', 'mp_current', 'toxicity'
        ];
        
        allowedUpdates.forEach(key => {
            if (updates[key] !== undefined) {
                player[key] = updates[key];
            }
        });

        await player.save();
        
        res.json({ message: '存档成功', player });
    } catch (error) {
        console.error('存档失败:', error);
        res.status(500).json({ message: '存档失败' });
    }
});

module.exports = router;
