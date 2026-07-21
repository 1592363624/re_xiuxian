/**
 * 世界BOSS伤害异常低诊断脚本
 *
 * 目的：排查化神初期玩家攻击青元子BOSS仅造成62点伤害的原因
 *
 * 诊断维度：
 *   1. 玩家实际属性（ATK/DEF/HP）通过 AttributeService.calculateFullAttributesAsync 获取
 *   2. BOSS静态数据（base_atk/def/element）从 world_boss_data.json 读取
 *   3. game_balance.world_boss 配置（single_player_damage_ratio/crit_rate 等）
 *   4. 模拟伤害计算公式，逐步打印中间值
 *
 * 运行：node scripts/diagnose_world_boss_damage.js
 */
'use strict';

const path = require('path');
const fs = require('fs');

// 加载环境变量
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const sequelize = require('../config/database');
const Player = require('../models/player');
// 使用 game/index.js 统一导出的 AttributeService（已被 initialize 初始化）
const game = require('../game');
const AttributeService = game.AttributeService;
const { infrastructure } = require('../modules');
const configLoader = infrastructure.ConfigLoader;

/**
 * 主诊断函数
 */
async function main() {
    try {
        await sequelize.authenticate();
        console.log('=== 数据库连接成功 ===\n');

        // 初始化配置加载器
        if (typeof configLoader.loadAllConfigs === 'function') {
            await configLoader.loadAllConfigs();
        } else if (typeof configLoader.load === 'function') {
            await configLoader.load();
        }

        // 初始化游戏服务（与服务器启动一致）
        await game.initializeGameServices(configLoader);
        console.log('=== 游戏服务初始化完成 ===\n');

        // 1. 查询玩家
        const PLAYER_ID = 1;
        const player = await Player.findByPk(PLAYER_ID);
        if (!player) {
            console.error('未找到玩家 ID=1');
            process.exit(1);
        }
        console.log('=== 玩家信息 ===');
        console.log(`昵称: ${player.nickname}`);
        console.log(`境界: ${player.realm} (rank=${player.realm_rank})`);
        console.log(`灵根: ${player.spirit_root}`);
        console.log(`天赋ID: ${player.talent_id}`);
        console.log(`装备称号: ${player.equipped_title_id}`);
        console.log(`灵石: ${player.spirit_stones}, 修为: ${player.exp}`);
        const attrs = typeof player.attributes === 'string' ? JSON.parse(player.attributes) : (player.attributes || {});
        console.log(`attributes.atk: ${attrs.atk}, attributes.def: ${attrs.def}, attributes.hp_max: ${attrs.hp_max}`);
        console.log(`attributes.atk_bonus: ${attrs.atk_bonus}, attributes.def_bonus: ${attrs.def_bonus}, attributes.hp_bonus: ${attrs.hp_bonus}`);
        console.log();

        // 2. 计算最终属性（含装备+灵兽加成）
        console.log('=== 计算最终属性 ===');
        console.log('AttributeService.configLoader 是否初始化:', !!AttributeService.configLoader);
        const attrResult = await AttributeService.calculateFullAttributesAsync(player);
        const finalAttrs = attrResult?.final || {};
        console.log(`最终 ATK: ${finalAttrs.atk}`);
        console.log(`最终 DEF: ${finalAttrs.def}`);
        console.log(`最终 HP_MAX: ${finalAttrs.hp_max}`);
        console.log(`最终 SPEED: ${finalAttrs.speed}`);

        // 打印属性加成 breakdown
        const breakdown = attrResult?.breakdown || {};
        console.log('\n--- 属性加成分解 ---');
        console.log(`基础(base): atk=${breakdown.base?.atk}, def=${breakdown.base?.def}, hp_max=${breakdown.base?.hp_max}, speed=${breakdown.base?.speed}`);
        console.log(`灵根(spirit_root): atk=${breakdown.spirit_root?.atk || 0}, def=${breakdown.spirit_root?.def || 0}`);
        console.log(`分配(allocated): atk=${breakdown.allocated?.atk || 0}, def=${breakdown.allocated?.def || 0}, hp_max=${breakdown.allocated?.hp_max || 0}`);
        console.log(`天赋(talent): atk=${breakdown.talent?.atk || 0}, def=${breakdown.talent?.def || 0}`);
        console.log(`称号(title): atk=${breakdown.title?.atk || 0}, def=${breakdown.title?.def || 0}`);
        console.log(`装备(equipment): atk=${breakdown.equipment?.atk || 0}, def=${breakdown.equipment?.def || 0}, hp_max=${breakdown.equipment?.hp_max || 0}`);
        console.log(`灵兽(spirit_beast): atk=${breakdown.spirit_beast?.atk || 0}, def=${breakdown.spirit_beast?.def || 0}, hp_max=${breakdown.spirit_beast?.hp_max || 0}`);
        console.log(`灵兽信息:`, attrResult?.info?.spirit_beast || '无出战灵兽');
        console.log();

        // 3. 查询BOSS静态数据
        console.log('=== BOSS静态数据 ===');
        const bossData = configLoader.getConfig('world_boss_data');
        const qingyuanzi = bossData?.bosses?.find(b => b.boss_key === 'qingyuanzi');
        if (qingyuanzi) {
            console.log(`Boss名称: ${qingyuanzi.boss_name}`);
            console.log(`base_hp: ${qingyuanzi.base_hp}`);
            console.log(`base_atk: ${qingyuanzi.base_atk}`);
            console.log(`def: ${qingyuanzi.def}`);
            console.log(`speed: ${qingyuanzi.speed}`);
            console.log(`element: ${qingyuanzi.element}`);
            console.log(`realm_rank_min: ${qingyuanzi.realm_rank_min}`);
            console.log(`spawn_schedule: ${JSON.stringify(qingyuanzi.spawn_schedule)}`);
        }
        console.log();

        // 4. 查询world_boss平衡配置
        console.log('=== world_boss 平衡配置 ===');
        const balance = configLoader.getConfig('game_balance');
        const wbCfg = balance?.world_boss || {};
        console.log(`enabled: ${wbCfg.enabled}`);
        console.log(`attack_cooldown_seconds: ${wbCfg.attack_cooldown_seconds}`);
        console.log(`single_player_damage_ratio: ${wbCfg.single_player_damage_ratio}`);
        console.log(`crit_rate: ${wbCfg.crit_rate}`);
        console.log(`crit_multiplier: ${wbCfg.crit_multiplier}`);
        console.log(`damage_random_range: ${wbCfg.damage_random_range}`);
        console.log(`phase_multipliers: ${JSON.stringify(wbCfg.phase_multipliers)}`);
        console.log(`spirit_beast_assist: ${JSON.stringify(wbCfg.spirit_beast_assist)}`);
        console.log();

        // 5. 模拟伤害计算（不实际攻击）
        console.log('=== 模拟伤害计算（10次） ===');
        const bossDef = qingyuanzi?.def || 800;
        const playerAtk = Number(finalAttrs.atk) || 0;
        const soloRatio = wbCfg.single_player_damage_ratio || 0.4;
        const critRate = wbCfg.crit_rate || 0.05;
        const critMultiplier = wbCfg.crit_multiplier || 1.5;
        const randomRange = wbCfg.damage_random_range || 0.15;
        const skillMultiplier = 1.0; // basic

        console.log(`基础参数: playerAtk=${playerAtk}, bossDef=${bossDef}, soloRatio=${soloRatio}, skillMultiplier=${skillMultiplier}`);
        console.log();

        for (let i = 1; i <= 10; i++) {
            const baseDamage = Math.max(1, playerAtk * skillMultiplier - bossDef * 0.5);
            const isCrit = Math.random() < critRate;
            const critFactor = isCrit ? critMultiplier : 1.0;
            const randomFactor = 1 + (Math.random() * 2 - 1) * randomRange;
            const elementalFactor = 1.0; // 中性
            const finalDamage = Math.floor(baseDamage * critFactor * randomFactor * soloRatio * elementalFactor);

            console.log(`第${i}次: baseDamage=${baseDamage.toFixed(2)}, crit=${isCrit}, randomFactor=${randomFactor.toFixed(3)}, finalDamage=${finalDamage}`);
        }

        console.log();
        console.log('=== 诊断结论 ===');
        const baseDamage = Math.max(1, playerAtk * skillMultiplier - bossDef * 0.5);
        const expectedDamage = Math.floor(baseDamage * 1.0 * 1.0 * soloRatio * 1.0);
        console.log(`理论平均伤害: ${expectedDamage}`);
        console.log(`理论10次攻击总伤害: ${expectedDamage * 10}`);
        console.log(`击杀所需次数: ${Math.ceil(5000000 / expectedDamage)}`);

        if (playerAtk < bossDef * 0.5) {
            console.log(`\n⚠️ 问题诊断: 玩家ATK(${playerAtk}) < BOSS DEF*0.5(${bossDef * 0.5})`);
            console.log(`   baseDamage 被 max(1, ...) 兜底为 1，最终伤害 = floor(1 * ${soloRatio}) = ${Math.floor(soloRatio)}`);
            console.log(`   建议: 1) 提高 single_player_damage_ratio; 2) 调整 boss.def 数值; 3) 改进伤害公式`);
        } else if (expectedDamage < 100) {
            console.log(`\n⚠️ 问题诊断: 伤害过低，玩家ATK(${playerAtk}) 与 BOSS DEF(${bossDef}) 接近`);
            console.log(`   baseDamage = ${baseDamage}, 乘 soloRatio=${soloRatio} 后 = ${baseDamage * soloRatio}`);
            console.log(`   建议: 1) 调整 single_player_damage_ratio 至 1.0 或更高; 2) 调整伤害公式`);
        }

        process.exit(0);
    } catch (err) {
        console.error('诊断失败:', err);
        console.error(err.stack);
        process.exit(1);
    }
}

main();
