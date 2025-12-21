const sequelize = require('../config/database');
const Realm = require('../models/realm');

const calcExpCapByRank = (rank) => {
    const r = Math.max(1, Number(rank) || 1);
    return Math.floor(1000 * Math.pow(r, 3));
};

const realmData = [
    { name: "凡人", rank: 1, base_hp: 100, base_atk: 10, base_def: 5, base_speed: 10, base_mp: 0, base_sense: 10, base_lifespan: 60, mp_regen_rate: 0, toxicity_decay: 0 },
    { name: "炼气期1层", rank: 2, base_hp: 200, base_atk: 20, base_def: 10, base_speed: 15, base_mp: 100, base_sense: 20, base_lifespan: 80, mp_regen_rate: 20, toxicity_decay: 1 },
    { name: "炼气期2层", rank: 3, base_hp: 250, base_atk: 25, base_def: 13, base_speed: 17, base_mp: 150, base_sense: 25, base_lifespan: 83, mp_regen_rate: 23, toxicity_decay: 1 },
    { name: "炼气期3层", rank: 4, base_hp: 300, base_atk: 30, base_def: 16, base_speed: 19, base_mp: 200, base_sense: 30, base_lifespan: 86, mp_regen_rate: 26, toxicity_decay: 1 },
    { name: "炼气期4层", rank: 5, base_hp: 350, base_atk: 35, base_def: 19, base_speed: 21, base_mp: 250, base_sense: 35, base_lifespan: 89, mp_regen_rate: 29, toxicity_decay: 1 },
    { name: "炼气期5层", rank: 6, base_hp: 400, base_atk: 40, base_def: 22, base_speed: 23, base_mp: 300, base_sense: 40, base_lifespan: 92, mp_regen_rate: 32, toxicity_decay: 1 },
    { name: "炼气期6层", rank: 7, base_hp: 450, base_atk: 45, base_def: 26, base_speed: 24, base_mp: 350, base_sense: 45, base_lifespan: 95, mp_regen_rate: 35, toxicity_decay: 2 },
    { name: "炼气期7层", rank: 8, base_hp: 500, base_atk: 50, base_def: 30, base_speed: 25, base_mp: 400, base_sense: 50, base_lifespan: 100, mp_regen_rate: 40, toxicity_decay: 2 },
    { name: "炼气期8层", rank: 9, base_hp: 550, base_atk: 55, base_def: 33, base_speed: 27, base_mp: 450, base_sense: 55, base_lifespan: 103, mp_regen_rate: 43, toxicity_decay: 2 },
    { name: "炼气期9层", rank: 10, base_hp: 600, base_atk: 60, base_def: 36, base_speed: 29, base_mp: 500, base_sense: 60, base_lifespan: 106, mp_regen_rate: 46, toxicity_decay: 2 },
    { name: "炼气期10层", rank: 11, base_hp: 650, base_atk: 65, base_def: 39, base_speed: 31, base_mp: 550, base_sense: 65, base_lifespan: 109, mp_regen_rate: 49, toxicity_decay: 2 },
    { name: "炼气期11层", rank: 12, base_hp: 700, base_atk: 70, base_def: 42, base_speed: 33, base_mp: 600, base_sense: 70, base_lifespan: 112, mp_regen_rate: 52, toxicity_decay: 3 },
    { name: "炼气期12层", rank: 13, base_hp: 750, base_atk: 75, base_def: 46, base_speed: 34, base_mp: 650, base_sense: 75, base_lifespan: 115, mp_regen_rate: 55, toxicity_decay: 3 },
    { name: "炼气期13层", rank: 14, base_hp: 800, base_atk: 80, base_def: 50, base_speed: 35, base_mp: 800, base_sense: 80, base_lifespan: 120, mp_regen_rate: 60, toxicity_decay: 3 },
    { name: "筑基初期", rank: 15, base_hp: 1500, base_atk: 150, base_def: 100, base_speed: 50, base_mp: 1500, base_sense: 150, base_lifespan: 150, mp_regen_rate: 100, toxicity_decay: 5 },
    { name: "筑基中期", rank: 16, base_hp: 2000, base_atk: 200, base_def: 150, base_speed: 60, base_mp: 2000, base_sense: 200, base_lifespan: 170, mp_regen_rate: 120, toxicity_decay: 6 },
    { name: "筑基后期", rank: 17, base_hp: 2500, base_atk: 250, base_def: 200, base_speed: 70, base_mp: 2500, base_sense: 250, base_lifespan: 190, mp_regen_rate: 140, toxicity_decay: 7 },
    { name: "筑基大圆满", rank: 18, base_hp: 3000, base_atk: 300, base_def: 250, base_speed: 80, base_mp: 3000, base_sense: 300, base_lifespan: 200, mp_regen_rate: 160, toxicity_decay: 8 },
    { name: "结丹初期", rank: 19, base_hp: 5000, base_atk: 500, base_def: 400, base_speed: 100, base_mp: 5000, base_sense: 500, base_lifespan: 400, mp_regen_rate: 200, toxicity_decay: 10 },
    { name: "结丹中期", rank: 20, base_hp: 7000, base_atk: 700, base_def: 500, base_speed: 120, base_mp: 7000, base_sense: 700, base_lifespan: 450, mp_regen_rate: 240, toxicity_decay: 12 },
    { name: "结丹后期", rank: 21, base_hp: 9000, base_atk: 900, base_def: 600, base_speed: 140, base_mp: 9000, base_sense: 900, base_lifespan: 500, mp_regen_rate: 280, toxicity_decay: 14 },
    { name: "结丹大圆满", rank: 22, base_hp: 12000, base_atk: 1200, base_def: 800, base_speed: 160, base_mp: 12000, base_sense: 1200, base_lifespan: 600, mp_regen_rate: 320, toxicity_decay: 16 },
    { name: "元婴初期", rank: 23, base_hp: 20000, base_atk: 2000, base_def: 1500, base_speed: 200, base_mp: 20000, base_sense: 2000, base_lifespan: 800, mp_regen_rate: 400, toxicity_decay: 20 },
    { name: "元婴中期", rank: 24, base_hp: 25000, base_atk: 2500, base_def: 1800, base_speed: 220, base_mp: 25000, base_sense: 2500, base_lifespan: 900, mp_regen_rate: 450, toxicity_decay: 22 },
    { name: "元婴后期", rank: 25, base_hp: 30000, base_atk: 3000, base_def: 2100, base_speed: 240, base_mp: 30000, base_sense: 3000, base_lifespan: 1000, mp_regen_rate: 500, toxicity_decay: 24 },
    { name: "元婴大圆满", rank: 26, base_hp: 40000, base_atk: 4000, base_def: 2500, base_speed: 260, base_mp: 40000, base_sense: 4000, base_lifespan: 1200, mp_regen_rate: 550, toxicity_decay: 26 },
    { name: "化神初期", rank: 27, base_hp: 60000, base_atk: 6000, base_def: 3500, base_speed: 300, base_mp: 60000, base_sense: 6000, base_lifespan: 1500, mp_regen_rate: 600, toxicity_decay: 30 },
    { name: "化神中期", rank: 28, base_hp: 75000, base_atk: 7500, base_def: 4000, base_speed: 320, base_mp: 75000, base_sense: 7500, base_lifespan: 1700, mp_regen_rate: 650, toxicity_decay: 32 },
    { name: "化神后期", rank: 29, base_hp: 90000, base_atk: 9000, base_def: 4500, base_speed: 340, base_mp: 90000, base_sense: 9000, base_lifespan: 1900, mp_regen_rate: 700, toxicity_decay: 34 },
    { name: "化神大圆满", rank: 30, base_hp: 120000, base_atk: 12000, base_def: 5000, base_speed: 360, base_mp: 120000, base_sense: 12000, base_lifespan: 2000, mp_regen_rate: 750, toxicity_decay: 36 },
    { name: "炼虚初期", rank: 31, base_hp: 200000, base_atk: 20000, base_def: 10000, base_speed: 400, base_mp: 200000, base_sense: 20000, base_lifespan: 8000, mp_regen_rate: 800, toxicity_decay: 40 },
    { name: "炼虚中期", rank: 32, base_hp: 250000, base_atk: 25000, base_def: 12000, base_speed: 420, base_mp: 250000, base_sense: 25000, base_lifespan: 9000, mp_regen_rate: 850, toxicity_decay: 42 },
    { name: "炼虚后期", rank: 33, base_hp: 300000, base_atk: 30000, base_def: 14000, base_speed: 440, base_mp: 300000, base_sense: 30000, base_lifespan: 10000, mp_regen_rate: 900, toxicity_decay: 44 },
    { name: "炼虚大圆满", rank: 34, base_hp: 400000, base_atk: 40000, base_def: 16000, base_speed: 460, base_mp: 400000, base_sense: 40000, base_lifespan: 12000, mp_regen_rate: 950, toxicity_decay: 46 },
    { name: "合体初期", rank: 35, base_hp: 600000, base_atk: 60000, base_def: 30000, base_speed: 500, base_mp: 600000, base_sense: 60000, base_lifespan: 50000, mp_regen_rate: 1000, toxicity_decay: 50 },
    { name: "合体中期", rank: 36, base_hp: 750000, base_atk: 75000, base_def: 35000, base_speed: 520, base_mp: 750000, base_sense: 75000, base_lifespan: 60000, mp_regen_rate: 1050, toxicity_decay: 52 },
    { name: "合体后期", rank: 37, base_hp: 900000, base_atk: 90000, base_def: 40000, base_speed: 540, base_mp: 900000, base_sense: 90000, base_lifespan: 70000, mp_regen_rate: 1100, toxicity_decay: 54 },
    { name: "合体大圆满", rank: 38, base_hp: 1200000, base_atk: 120000, base_def: 45000, base_speed: 560, base_mp: 1200000, base_sense: 120000, base_lifespan: 80000, mp_regen_rate: 1150, toxicity_decay: 56 },
    { name: "大乘初期", rank: 39, base_hp: 2000000, base_atk: 200000, base_def: 100000, base_speed: 600, base_mp: 2000000, base_sense: 200000, base_lifespan: 200000, mp_regen_rate: 1200, toxicity_decay: 60 },
    { name: "大乘中期", rank: 40, base_hp: 2500000, base_atk: 250000, base_def: 120000, base_speed: 620, base_mp: 2500000, base_sense: 250000, base_lifespan: 300000, mp_regen_rate: 1250, toxicity_decay: 62 },
    { name: "大乘后期", rank: 41, base_hp: 3000000, base_atk: 300000, base_def: 140000, base_speed: 640, base_mp: 3000000, base_sense: 300000, base_lifespan: 400000, mp_regen_rate: 1300, toxicity_decay: 64 },
    { name: "大乘大圆满", rank: 42, base_hp: 4000000, base_atk: 400000, base_def: 160000, base_speed: 660, base_mp: 4000000, base_sense: 400000, base_lifespan: 500000, mp_regen_rate: 1350, toxicity_decay: 66 },
    { name: "真仙初期", rank: 43, base_hp: 6000000, base_atk: 600000, base_def: 300000, base_speed: 700, base_mp: 6000000, base_sense: 600000, base_lifespan: 1000000, mp_regen_rate: 1400, toxicity_decay: 70 },
    { name: "金仙初期", rank: 44, base_hp: 20000000, base_atk: 2000000, base_def: 1000000, base_speed: 800, base_mp: 20000000, base_sense: 2000000, base_lifespan: 5000000, mp_regen_rate: 1500, toxicity_decay: 80 },
    { name: "太乙初期", rank: 45, base_hp: 60000000, base_atk: 6000000, base_def: 3000000, base_speed: 900, base_mp: 60000000, base_sense: 6000000, base_lifespan: 10000000, mp_regen_rate: 1600, toxicity_decay: 90 },
    { name: "大罗初期", rank: 46, base_hp: 200000000, base_atk: 20000000, base_def: 10000000, base_speed: 1000, base_mp: 200000000, base_sense: 20000000, base_lifespan: 50000000, mp_regen_rate: 1700, toxicity_decay: 100 },
    { name: "道祖", rank: 47, base_hp: 600000000, base_atk: 60000000, base_def: 30000000, base_speed: 1200, base_mp: 600000000, base_sense: 60000000, base_lifespan: 100000000, mp_regen_rate: 1800, toxicity_decay: 120 }
].map((r) => ({
    ...r,
    exp_cap: calcExpCapByRank(r.rank)
}));

async function initRealms() {
    try {
        console.log('正在连接数据库...');
        await sequelize.authenticate();
        console.log('数据库连接成功。');

        console.log('正在同步 Realm 表结构...');
        await Realm.sync({ alter: true });

        console.log('正在导入/更新境界数据...');
        for (const data of realmData) {
            await Realm.upsert(data);
        }

        console.log('境界数据导入完成！共导入 ' + realmData.length + ' 条数据。');
        process.exit(0);
    } catch (error) {
        console.error('导入失败:', error);
        process.exit(1);
    }
}

initRealms();
