/**
 * 临时调试脚本：测试 checkExpirations 是否能找到过期放养记录
 */
'use strict';
require('dotenv').config();

const sequelize = require('../config/database');
const SpiritBeastPasture = require('../models/spiritBeastPasture');
const SpiritBeast = require('../models/spiritBeast');
const { Op } = require('sequelize');

(async () => {
    await sequelize.authenticate();
    await sequelize.query('USE xiuxian');
    console.log('=== 测试 checkExpirations ===');

    // 先清理
    await SpiritBeastPasture.destroy({ where: { player_id: 1 } });
    await SpiritBeast.update({ is_pasturing: false }, { where: { player_id: 1 } });

    // 找一只未出战的灵兽
    const beast = await SpiritBeast.findOne({ where: { player_id: 1, is_active: false, is_pasturing: false } });
    if (!beast) {
        console.log('没找到灵兽');
        process.exit(1);
    }
    console.log('使用灵兽:', beast.id, beast.beast_key);

    // 创建放养记录（end_time 设为5小时前，超过2小时宽限期）
    const now = new Date();
    const pasture = await SpiritBeastPasture.create({
        player_id: 1,
        beast_id: beast.id,
        beast_snapshot: { beast_name: 'test', element: 'wood', star_level: 1, level: 1, hp_max: '100', atk: 10, def: 5, speed: 10, loyalty: 50 },
        location_key: 'qingyun_mountain',
        location_name: '青云山',
        start_time: new Date(now.getTime() - 6 * 3600 * 1000),
        end_time: new Date(now.getTime() - 5 * 3600 * 1000),
        status: 'active',
        yield_discount: 1.0
    });
    console.log('创建放养记录:', pasture.id, 'end_time=', pasture.end_time);
    await SpiritBeast.update({ is_pasturing: true }, { where: { id: beast.id } });

    // 调用 checkExpirations
    const BeastPastureService = require('../game/services/BeastPastureService');
    // ConfigLoader 是单例导出，直接获取并加载配置
    const configLoader = require('../modules').infrastructure.ConfigLoader;
    if (configLoader.getLoadedConfigNames().length === 0) {
        await configLoader.loadAllConfigs();
    }
    BeastPastureService.config = configLoader.getConfig('spirit_beast_pasture_data');
    BeastPastureService.initialized = true;

    // 先直接查询过期放养
    const graceHours = BeastPastureService.config.pasture.auto_recall_grace_hours;
    const overdueTime = new Date(now.getTime() - graceHours * 3600 * 1000);
    console.log('graceHours=', graceHours, 'overdueTime=', overdueTime);
    const expiredFound = await SpiritBeastPasture.findAll({
        where: {
            status: 'active',
            end_time: { [Op.lt]: overdueTime }
        }
    });
    console.log('找到过期放养记录数:', expiredFound.length);
    for (const p of expiredFound) {
        console.log('  -', { id: p.id, status: p.status, end_time: p.end_time });
    }

    console.log('调用 checkExpirations...');
    try {
        await BeastPastureService.checkExpirations();
        console.log('checkExpirations 调用成功');
    } catch (e) {
        console.error('checkExpirations 调用出错:', e.message);
        console.error(e.stack);
    }

    const settled = await SpiritBeastPasture.findByPk(pasture.id);
    console.log('调用后: status=', settled.status, 'recall_type=', settled.recall_type, 'yield_discount=', settled.yield_discount);
    const beastAfter = await SpiritBeast.findByPk(beast.id);
    console.log('beast.is_pasturing=', beastAfter.is_pasturing);

    // 清理
    await SpiritBeastPasture.destroy({ where: { id: pasture.id } });
    await SpiritBeast.update({ is_pasturing: false }, { where: { id: beast.id } });
    console.log('清理完成');
    process.exit(0);
})().catch(e => {
    console.error('ERROR:', e.message);
    console.error(e.stack);
    process.exit(1);
});
