/**
 * 通天灵宝炼制链：青竹蜂云剑（基础→神雷→庚金）与三焰扇→七焰扇
 *
 * 成功率加成：天/异灵根对应属性、太一 BUFF、元婴宗地脉。
 * 失败惩罚：毁材料、损修为，低概率跌境。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');

function cfg() {
    try {
        const { infrastructure } = require('../../modules');
        const c = infrastructure.ConfigLoader.getConfig?.('legendary_weapons')?.legendary_weapons
            || infrastructure.ConfigLoader.getConfig?.('legendary_weapons');
        if (c && c.qingzhu_sword) return c;
    } catch (_) { /* fallthrough */ }
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'config', 'legendary_weapons.json'), 'utf8')).legendary_weapons;
}

class LegendaryWeaponsService {
    static config() { return cfg(); }

    /** 炼制成功率（含资质/秘术加成） */
    static successRate(base, { goldRoot = false, thunderRoot = false, fireRoot = false, metalSense = false, fireSense = false, yuanyingSect = false } = {}) {
        const c = cfg();
        let rate = Number(base) || 0;
        const q = c.qingzhu_sword;
        const f = c.seven_flame_fan;
        if (goldRoot) rate += Number(q.bonus_gold_root) || 0;
        if (thunderRoot) rate += Number(q.bonus_thunder_root) || 0;
        if (fireRoot) rate += Number(f.bonus_fire_root) || 0;
        if (metalSense) rate += Number(q.bonus_metal_sense_buff) || 0;
        if (fireSense) rate += Number(f.bonus_fire_sense_buff) || 0;
        if (yuanyingSect) rate += Number(f.bonus_yuanying_sect) || 0;
        return Math.min(0.95, Math.max(0.01, rate));
    }

    /**
     * 炼制一次
     * @param {'qingzhu_base'|'qingzhu_thunder'|'qingzhu_gold'|'three_flame'|'seven_flame'} recipe
     */
    static async craft(playerId, recipe, bonuses = {}) {
        const Player = require('../../models/player');
        const InventoryService = require('./InventoryService');
        const sequelize = require('../../config/database');
        const c = cfg();
        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, { lock: t.LOCK.UPDATE, transaction: t });
            if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);

            let materials;
            let outputKey;
            let baseRate;
            let failExpRate = 0;
            let destroyMaterials = true;
            let realmFallChance = 0;

            if (recipe === 'qingzhu_base') {
                materials = c.qingzhu_sword.base_materials;
                outputKey = c.qingzhu_sword.base_item_key;
                baseRate = 0.45;
            } else if (recipe === 'qingzhu_thunder') {
                materials = c.qingzhu_sword.thunder_materials;
                outputKey = c.qingzhu_sword.thunder_item_key;
                baseRate = c.qingzhu_sword.thunder_success_rate;
            } else if (recipe === 'qingzhu_gold') {
                materials = c.qingzhu_sword.gold_materials;
                outputKey = c.qingzhu_sword.gold_item_key;
                baseRate = c.qingzhu_sword.gold_success_rate;
                failExpRate = c.qingzhu_sword.gold_fail_exp_loss_rate;
                realmFallChance = c.qingzhu_sword.gold_fail_realm_fall_chance;
            } else if (recipe === 'three_flame') {
                materials = c.seven_flame_fan.replica_materials;
                outputKey = c.seven_flame_fan.replica_item_key;
                baseRate = c.seven_flame_fan.replica_success_rate;
                failExpRate = c.seven_flame_fan.replica_fail_exp_loss_rate;
            } else if (recipe === 'seven_flame') {
                materials = c.seven_flame_fan.true_materials;
                outputKey = c.seven_flame_fan.true_item_key;
                baseRate = c.seven_flame_fan.true_success_rate;
                failExpRate = c.seven_flame_fan.true_fail_exp_loss_rate;
                destroyMaterials = true;
            } else {
                await t.rollback();
                throw new AppError('未知炼制配方', 400, ErrorCodes.VALIDATION_ERROR);
            }

            // 扣材料（含灵石 special key）
            for (const [key, qty] of Object.entries(materials)) {
                if (key === 'spirit_stones') {
                    // 灵石特殊处理
                    continue;
                }
                const ok = await InventoryService.removeItem(playerId, key, qty, t);
                if (!ok) {
                    await t.rollback();
                    throw new AppError(`材料不足：${key} x${qty}`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
                }
            }
            if (materials.spirit_stones) {
                const need = BigInt(materials.spirit_stones);
                const have = BigInt(player.spirit_stones ?? 0);
                if (have < need) {
                    await t.rollback();
                    throw new AppError('灵石不足', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
                }
                player.spirit_stones = have - need;
            }

            const rate = this.successRate(baseRate, bonuses);
            const win = Math.random() < rate;

            if (win) {
                await InventoryService.addItem(playerId, outputKey, 1, t);
                await player.save({ transaction: t });
                await t.commit();
                return { win: true, recipe, item_key: outputKey, rate, message: `炼制成功！获得 ${outputKey}` };
            }

            // 失败：材料已扣（炸炉）
            let expLoss = 0;
            let realmFell = false;
            if (failExpRate > 0) {
                expLoss = Math.floor((Number(player.exp) || 0) * failExpRate);
                player.exp = Math.max(0, (Number(player.exp) || 0) - expLoss);
            }
            if (realmFallChance > 0 && Math.random() < realmFallChance) {
                player.realm_rank = Math.max(1, (Number(player.realm_rank) || 1) - 1);
                realmFell = true;
            }
            await player.save({ transaction: t });
            await t.commit();
            return {
                win: false,
                recipe,
                rate,
                exp_loss: expLoss,
                realm_fell: realmFell,
                message: realmFell ? '炼制失败，遭庚金之气反噬，境界跌落！' : `炼制失败，材料尽毁${expLoss ? `，损失修为 ${expLoss}` : ''}`
            };
        } catch (e) {
            if (t && !t.finished) await t.rollback().catch(() => {});
            throw e;
        }
    }
}

module.exports = LegendaryWeaponsService;
