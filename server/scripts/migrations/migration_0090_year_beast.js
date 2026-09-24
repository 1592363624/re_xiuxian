/**
 * 迁移脚本 0090：年兽讨伐队伍表
 * 与 0089 同约定：Model.sync() 幂等。
 */
const YearBeastParty = require('../../models/yearBeastParty');
const YearBeastMember = require('../../models/yearBeastMember');

const migrationInfo = {
    description: '创建年兽讨伐队伍与队员表 year_beast_parties / year_beast_members',
    version: '1.0.0'
};

async function up() {
    await YearBeastParty.sync();
    await YearBeastMember.sync();
    console.log('[Migration 0090] year_beast 表已就绪');
}

async function down() {
    await YearBeastMember.getQueryInterface().dropTable('year_beast_members');
    await YearBeastParty.getQueryInterface().dropTable('year_beast_parties');
    console.log('[Migration 0090] 已回滚');
}

module.exports = { up, down, migrationInfo };
