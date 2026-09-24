/**
 * 迁移脚本 0090：年兽讨伐队伍表 + 玲珑骰对赌表
 * 与 0089 同约定：Model.sync() 幂等。
 */
const YearBeastParty = require('../../models/yearBeastParty');
const YearBeastMember = require('../../models/yearBeastMember');
const GhostDiceMatch = require('../../models/ghostDiceMatch');

const migrationInfo = {
    description: '创建年兽讨伐与玲珑骰对赌表 year_beast_* / ghost_dice_matches',
    version: '1.0.0'
};

async function up() {
    await YearBeastParty.sync();
    await YearBeastMember.sync();
    await GhostDiceMatch.sync();
    console.log('[Migration 0090] year_beast / ghost_dice 表已就绪');
}

async function down() {
    await YearBeastMember.getQueryInterface().dropTable('year_beast_members');
    await YearBeastParty.getQueryInterface().dropTable('year_beast_parties');
    await GhostDiceMatch.getQueryInterface().dropTable('ghost_dice_matches');
    console.log('[Migration 0090] 已回滚');
}

module.exports = { up, down, migrationInfo };
