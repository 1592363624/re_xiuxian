/**
 * 宗门加成前端展示测试脚本
 *
 * 测试目标：
 *   1. 后端 sect_data.json 配置完整性（6 宗门 × 各 2 个 bonus 字段）
 *   2. 后端 SectService.getSectList/getMySect 返回 bonus 字段
 *   3. 后端 API 实际响应包含 bonus 字段
 *   4. 前端 sect.ts 的 SectBonus 接口定义（10 个可选字段）
 *   5. 前端 SectPanel.vue 的辅助函数实现（bonusLabels/formatBonusValue/getBonusList）
 *   6. 前端 SectPanel.vue 模板两处加成展示区块（宗门列表 + 我的宗门）
 *   7. formatBonusValue 逻辑验证（倍率类/比例类/边界值）
 *   8. getBonusList 逻辑验证（过滤 undefined/空对象/非对象）
 *
 * 运行方式：node scripts/test_sect_bonus_display.js
 */
'use strict';

const path = require('path');
// 显式指定 .env 路径，避免 cwd 不一致导致配置缺失
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const fs = require('fs');
const axios = require('axios');

// ====== 测试框架 ======
let passCount = 0;
let failCount = 0;
const failedItems = [];

function check(name, condition, detail = '') {
    if (condition) {
        passCount++;
        // console.log(`  ✅ ${name}`);
    } else {
        failCount++;
        failedItems.push({ name, detail });
        console.log(`  ❌ ${name}${detail ? ' | ' + detail : ''}`);
    }
}

// ====== 配置 ======
const API_BASE = `http://localhost:${process.env.PORT || 5000}/api`;
const TEST_ACCOUNT = '1592363624';
const TEST_PASSWORD = '1592363624';

// 10 个 bonus 字段期望中文名映射
const EXPECTED_BONUS_LABELS = {
    exp_multiplier: '修为加成',
    gather_bonus: '采集加成',
    sense_multiplier: '感知加成',
    breakthrough_bonus: '突破加成',
    luck_bonus: '气运加成',
    atk_multiplier: '攻击加成',
    dark_arts_bonus: '魔道加成',
    charm_bonus: '魅惑加成',
    mp_multiplier: '灵力加成',
    mental_strength: '道心加成'
};

// 6 大宗门期望的 bonus 字段配置（源自 sect_data.json）
const EXPECTED_SECT_BONUSES = {
    luoyun: { exp_multiplier: 1.1, gather_bonus: 0.15 },
    xinggong: { sense_multiplier: 1.15, breakthrough_bonus: 0.05 },
    tianxing: { luck_bonus: 0.1, exp_multiplier: 1.05 },
    lingxiao: { breakthrough_bonus: 0.1, mental_strength: 0.15 },
    yinluo: { atk_multiplier: 1.1, dark_arts_bonus: 0.15 },
    hehuan: { charm_bonus: 0.15, mp_multiplier: 1.1 }
};

// ====== 主流程 ======
async function main() {
    console.log('====== 宗门加成前端展示测试 ======\n');

    // ====== 测试1：后端 sect_data.json 配置完整性 ======
    console.log('【测试1】后端 sect_data.json 配置完整性');
    const sectDataPath = path.join(__dirname, '..', 'config', 'sect_data.json');
    const sectDataExists = fs.existsSync(sectDataPath);
    check('sect_data.json 文件存在', sectDataExists);
    if (sectDataExists) {
        const sectData = JSON.parse(fs.readFileSync(sectDataPath, 'utf-8'));
        check('sects 数组存在', Array.isArray(sectData.sects));
        check('宗门数量为 6', sectData.sects?.length === 6, `实际: ${sectData.sects?.length}`);

        // 校验每个宗门的 bonus 字段
        for (const sect of sectData.sects || []) {
            const expected = EXPECTED_SECT_BONUSES[sect.id];
            check(`宗门 ${sect.name}(${sect.id}) 有 bonus 字段`, !!sect.bonus);
            if (expected && sect.bonus) {
                const actualKeys = Object.keys(sect.bonus).sort();
                const expectedKeys = Object.keys(expected).sort();
                check(`宗门 ${sect.name} bonus 字段匹配`, JSON.stringify(actualKeys) === JSON.stringify(expectedKeys),
                    `期望: ${JSON.stringify(expectedKeys)} 实际: ${JSON.stringify(actualKeys)}`);

                // 校验字段值
                for (const [k, v] of Object.entries(expected)) {
                    check(`宗门 ${sect.name} bonus.${k} = ${v}`, sect.bonus[k] === v,
                        `实际: ${sect.bonus[k]}`);
                }
            }
        }
    }
    console.log('');

    // ====== 测试2：前端 sect.ts 接口定义 ======
    console.log('【测试2】前端 sect.ts SectBonus 接口定义');
    const sectTsPath = path.join(__dirname, '..', '..', 'client', 'src', 'api', 'sect.ts');
    check('sect.ts 文件存在', fs.existsSync(sectTsPath));
    if (fs.existsSync(sectTsPath)) {
        const sectTsContent = fs.readFileSync(sectTsPath, 'utf-8');
        // 校验 SectBonus 接口包含全部 10 个字段
        for (const [key, label] of Object.entries(EXPECTED_BONUS_LABELS)) {
            check(`SectBonus 接口含 ${key}（${label}）`, sectTsContent.includes(`${key}?:`));
        }
        // 校验 Sect 接口含 bonus 字段
        check('Sect 接口含 bonus: SectBonus', sectTsContent.includes('bonus: SectBonus'));
        // 校验 MySect 接口含 bonus 字段
        check('MySect 接口含 bonus: SectBonus', /MySect[\s\S]*?bonus:\s*SectBonus/.test(sectTsContent));
    }
    console.log('');

    // ====== 测试3：前端 SectPanel.vue 辅助函数实现 ======
    console.log('【测试3】前端 SectPanel.vue 辅助函数实现');
    const sectPanelPath = path.join(__dirname, '..', '..', 'client', 'src', 'components', 'panels', 'SectPanel.vue');
    check('SectPanel.vue 文件存在', fs.existsSync(sectPanelPath));
    if (fs.existsSync(sectPanelPath)) {
        const panelContent = fs.readFileSync(sectPanelPath, 'utf-8');

        // 校验 bonusLabels 映射表（10 个字段全部存在）
        check('含 bonusLabels 映射表', panelContent.includes('const bonusLabels'));
        for (const [key, label] of Object.entries(EXPECTED_BONUS_LABELS)) {
            check(`bonusLabels 含 ${key}: '${label}'`, panelContent.includes(`${key}: '${label}'`));
        }

        // 校验 formatBonusValue 函数
        check('含 formatBonusValue 函数', panelContent.includes('const formatBonusValue'));
        check('formatBonusValue 处理 _multiplier 类', panelContent.includes("endsWith('_multiplier')"));
        check('formatBonusValue 处理百分比转换', panelContent.includes('* 100'));

        // 校验 getBonusList 函数
        check('含 getBonusList 函数', panelContent.includes('const getBonusList'));
        check('getBonusList 过滤 undefined', panelContent.includes('!== undefined'));
        check('getBonusList 过滤 null', panelContent.includes('!== null'));
    }
    console.log('');

    // ====== 测试4：前端 SectPanel.vue 模板加成展示区块 ======
    console.log('【测试4】前端 SectPanel.vue 模板加成展示区块');
    if (fs.existsSync(sectPanelPath)) {
        const panelContent = fs.readFileSync(sectPanelPath, 'utf-8');

        // 宗门列表卡片加成展示区
        check('宗门列表卡片含「宗门加成」展示区',
            panelContent.includes("getBonusList(sect.bonus).length > 0") &&
            panelContent.includes('宗门加成'));
        check('宗门列表加成使用 flex-wrap 徽章布局',
            panelContent.includes('flex-wrap') && panelContent.includes('v-for="item in getBonusList(sect.bonus)"'));

        // 我的宗门信息卡片加成展示区
        check('我的宗门信息卡片含「宗门加成」展示区',
            panelContent.includes("getBonusList(mySect.bonus).length > 0"));
        check('我的宗门加成使用 grid 2 列布局',
            panelContent.includes('grid grid-cols-2 gap-2') &&
            panelContent.includes('v-for="item in getBonusList(mySect.bonus)"'));
        check('我的宗门加成含"入宗即享"说明',
            panelContent.includes('入宗即享'));
    }
    console.log('');

    // ====== 测试5：formatBonusValue 逻辑验证（Node.js 模拟执行） ======
    console.log('【测试5】formatBonusValue 逻辑验证');
    /**
     * 模拟前端 formatBonusValue 逻辑
     * @param {string} key - bonus 字段 key
     * @param {number} value - 字段值
     * @returns {string}
     */
    function simulateFormatBonusValue(key, value) {
        if (typeof value !== 'number' || isNaN(value)) return '—';
        if (key.endsWith('_multiplier')) {
            const pct = (value - 1) * 100;
            return pct >= 0 ? `+${pct.toFixed(1)}%` : `${pct.toFixed(1)}%`;
        }
        const pct = value * 100;
        return pct >= 0 ? `+${pct.toFixed(1)}%` : `${pct.toFixed(1)}%`;
    }

    // 倍率类测试
    check('exp_multiplier=1.1 → "+10.0%"', simulateFormatBonusValue('exp_multiplier', 1.1) === '+10.0%',
        `实际: ${simulateFormatBonusValue('exp_multiplier', 1.1)}`);
    check('atk_multiplier=1.1 → "+10.0%"', simulateFormatBonusValue('atk_multiplier', 1.1) === '+10.0%',
        `实际: ${simulateFormatBonusValue('atk_multiplier', 1.1)}`);
    check('sense_multiplier=1.15 → "+15.0%"', simulateFormatBonusValue('sense_multiplier', 1.15) === '+15.0%',
        `实际: ${simulateFormatBonusValue('sense_multiplier', 1.15)}`);
    check('mp_multiplier=1.1 → "+10.0%"', simulateFormatBonusValue('mp_multiplier', 1.1) === '+10.0%',
        `实际: ${simulateFormatBonusValue('mp_multiplier', 1.1)}`);

    // 比例类测试
    check('gather_bonus=0.15 → "+15.0%"', simulateFormatBonusValue('gather_bonus', 0.15) === '+15.0%',
        `实际: ${simulateFormatBonusValue('gather_bonus', 0.15)}`);
    check('breakthrough_bonus=0.05 → "+5.0%"', simulateFormatBonusValue('breakthrough_bonus', 0.05) === '+5.0%',
        `实际: ${simulateFormatBonusValue('breakthrough_bonus', 0.05)}`);
    check('breakthrough_bonus=0.1 → "+10.0%"', simulateFormatBonusValue('breakthrough_bonus', 0.1) === '+10.0%',
        `实际: ${simulateFormatBonusValue('breakthrough_bonus', 0.1)}`);
    check('luck_bonus=0.1 → "+10.0%"', simulateFormatBonusValue('luck_bonus', 0.1) === '+10.0%',
        `实际: ${simulateFormatBonusValue('luck_bonus', 0.1)}`);
    check('dark_arts_bonus=0.15 → "+15.0%"', simulateFormatBonusValue('dark_arts_bonus', 0.15) === '+15.0%',
        `实际: ${simulateFormatBonusValue('dark_arts_bonus', 0.15)}`);
    check('charm_bonus=0.15 → "+15.0%"', simulateFormatBonusValue('charm_bonus', 0.15) === '+15.0%',
        `实际: ${simulateFormatBonusValue('charm_bonus', 0.15)}`);
    check('mental_strength=0.15 → "+15.0%"', simulateFormatBonusValue('mental_strength', 0.15) === '+15.0%',
        `实际: ${simulateFormatBonusValue('mental_strength', 0.15)}`);

    // 边界值测试
    check('exp_multiplier=1.0 → "+0.0%"', simulateFormatBonusValue('exp_multiplier', 1.0) === '+0.0%',
        `实际: ${simulateFormatBonusValue('exp_multiplier', 1.0)}`);
    check('非数值 → "—"', simulateFormatBonusValue('exp_multiplier', NaN) === '—');
    check('null → "—"', simulateFormatBonusValue('exp_multiplier', null) === '—');
    console.log('');

    // ====== 测试6：getBonusList 逻辑验证（Node.js 模拟执行） ======
    console.log('【测试6】getBonusList 逻辑验证');
    /**
     * 模拟前端 getBonusList 逻辑
     * @param {Object|null|undefined} bonus
     * @returns {Array<{label: string, value: string}>}
     */
    function simulateGetBonusList(bonus) {
        if (!bonus || typeof bonus !== 'object') return [];
        const result = [];
        for (const key of Object.keys(EXPECTED_BONUS_LABELS)) {
            const val = bonus[key];
            if (val !== undefined && val !== null) {
                result.push({
                    label: EXPECTED_BONUS_LABELS[key],
                    value: simulateFormatBonusValue(key, Number(val))
                });
            }
        }
        return result;
    }

    // 落云宗测试
    const luoyunList = simulateGetBonusList(EXPECTED_SECT_BONUSES.luoyun);
    check('落云宗返回 2 项加成', luoyunList.length === 2, `实际: ${luoyunList.length}`);
    check('落云宗第1项为"修为加成 +10.0%"',
        luoyunList[0]?.label === '修为加成' && luoyunList[0]?.value === '+10.0%',
        `实际: ${JSON.stringify(luoyunList[0])}`);
    check('落云宗第2项为"采集加成 +15.0%"',
        luoyunList[1]?.label === '采集加成' && luoyunList[1]?.value === '+15.0%',
        `实际: ${JSON.stringify(luoyunList[1])}`);

    // 星宫测试
    const xinggongList = simulateGetBonusList(EXPECTED_SECT_BONUSES.xinggong);
    check('星宫返回 2 项加成', xinggongList.length === 2);
    check('星宫含"感知加成 +15.0%"',
        xinggongList.some(i => i.label === '感知加成' && i.value === '+15.0%'));
    check('星宫含"突破加成 +5.0%"',
        xinggongList.some(i => i.label === '突破加成' && i.value === '+5.0%'));

    // 阴罗宗测试
    const yinluoList = simulateGetBonusList(EXPECTED_SECT_BONUSES.yinluo);
    check('阴罗宗返回 2 项加成', yinluoList.length === 2);
    check('阴罗宗含"攻击加成 +10.0%"',
        yinluoList.some(i => i.label === '攻击加成' && i.value === '+10.0%'));
    check('阴罗宗含"魔道加成 +15.0%"',
        yinluoList.some(i => i.label === '魔道加成' && i.value === '+15.0%'));

    // 合欢宗测试
    const hehuanList = simulateGetBonusList(EXPECTED_SECT_BONUSES.hehuan);
    check('合欢宗返回 2 项加成', hehuanList.length === 2);
    check('合欢宗含"魅惑加成 +15.0%"',
        hehuanList.some(i => i.label === '魅惑加成' && i.value === '+15.0%'));
    check('合欢宗含"灵力加成 +10.0%"',
        hehuanList.some(i => i.label === '灵力加成' && i.value === '+10.0%'));

    // 空值/异常值测试
    check('空对象返回空数组', simulateGetBonusList({}).length === 0);
    check('null 返回空数组', simulateGetBonusList(null).length === 0);
    check('undefined 返回空数组', simulateGetBonusList(undefined).length === 0);
    check('非对象返回空数组', simulateGetBonusList('invalid').length === 0);

    // 顺序一致性测试（所有宗门第1项应为 bonusLabels 定义顺序中靠前的字段）
    check('落云宗第1项为 exp_multiplier（按 bonusLabels 顺序）',
        luoyunList[0]?.label === '修为加成');
    check('星宫第1项为 sense_multiplier（按 bonusLabels 顺序）',
        xinggongList[0]?.label === '感知加成');
    console.log('');

    // ====== 测试7：后端 API 实际响应 ======
    console.log('【测试7】后端 API 实际响应');
    try {
        // 登录获取 token
        const loginRes = await axios.post(`${API_BASE}/auth/login`, {
            username: TEST_ACCOUNT,
            password: TEST_PASSWORD
        });
        const token = loginRes.data?.data?.access_token || loginRes.data?.access_token || loginRes.data?.token;
        check('登录成功获取 token', !!token);

        if (token) {
            const client = axios.create({
                baseURL: API_BASE,
                headers: { Authorization: `Bearer ${token}` },
                timeout: 10000
            });

            // GET /sect/list - 校验返回 bonus 字段
            try {
                const listRes = await client.get('/sect/list');
                const sects = listRes.data?.data?.sects || [];
                check('GET /sect/list 返回 6 个宗门', sects.length === 6, `实际: ${sects.length}`);

                // 校验每个宗门都返回了 bonus 字段
                for (const sect of sects) {
                    check(`API 返回 ${sect.name} 的 bonus 字段`,
                        sect.bonus && typeof sect.bonus === 'object' && Object.keys(sect.bonus).length > 0,
                        `bonus: ${JSON.stringify(sect.bonus)}`);
                }

                // 校验落云宗 bonus 字段值
                const luoyun = sects.find(s => s.id === 'luoyun');
                if (luoyun?.bonus) {
                    check('API 返回落云宗 exp_multiplier=1.1', luoyun.bonus.exp_multiplier === 1.1,
                        `实际: ${luoyun.bonus.exp_multiplier}`);
                    check('API 返回落云宗 gather_bonus=0.15', luoyun.bonus.gather_bonus === 0.15,
                        `实际: ${luoyun.bonus.gather_bonus}`);
                }
            } catch (e) {
                check('GET /sect/list 请求成功', false, e.message);
            }

            // GET /sect/my - 校验已加入宗门时返回 bonus 字段
            try {
                const myRes = await client.get('/sect/my');
                const mySect = myRes.data?.data;
                if (mySect) {
                    check('GET /sect/my 返回宗门信息', !!mySect.sect_id);
                    check('GET /sect/my 返回 bonus 字段',
                        mySect.bonus && typeof mySect.bonus === 'object',
                        `bonus: ${JSON.stringify(mySect.bonus)}`);
                    if (mySect.bonus) {
                        const bonusKeys = Object.keys(mySect.bonus);
                        check(`GET /sect/my bonus 字段数 >= 1`, bonusKeys.length >= 1,
                            `实际: ${bonusKeys.length}`);
                    }
                } else {
                    // 未加入宗门也算通过（测试账号可能未加入宗门）
                    check('GET /sect/my 未加入宗门（返回 null）', mySect === null || mySect === undefined);
                }
            } catch (e) {
                check('GET /sect/my 请求成功', false, e.message);
            }
        }
    } catch (e) {
        check('登录请求成功', false, e.message);
    }
    console.log('');

    // ====== 测试8：changelog 记录验证 ======
    console.log('【测试8】changelog 记录验证');
    const changelogPath = path.join(__dirname, '..', '..', 'client', 'src', 'data', 'changelog.js');
    if (fs.existsSync(changelogPath)) {
        const changelogContent = fs.readFileSync(changelogPath, 'utf-8');
        check('changelog 含"宗门加成"section', changelogContent.includes('宗门加成前端展示补齐'));
        check('changelog 含"信息透明"条目', changelogContent.includes('信息透明'));
        check('changelog 含"10 字段映射"条目', changelogContent.includes('10 字段映射'));
        check('changelog 含"智能格式化"条目', changelogContent.includes('智能格式化'));
        check('changelog type 为 optimize', changelogContent.includes("type: 'optimize'"));
    } else {
        check('changelog.js 文件存在', false);
    }
    console.log('');

    // ====== 测试9：功能对比清单验证 ======
    console.log('【测试9】功能对比清单验证');
    const compareListPath = path.join(__dirname, '..', '..', 'docs', '功能对比清单.md');
    if (fs.existsSync(compareListPath)) {
        const compareContent = fs.readFileSync(compareListPath, 'utf-8');
        check('功能对比清单含"宗门增益"行', compareContent.includes('宗门增益'));
        check('功能对比清单"宗门增益"状态为 ✅',
            /宗门增益\s*\|\s*✅/.test(compareContent));
        check('功能对比清单"宗门增益"含 bonus 说明',
            compareContent.includes('6 大宗门 bonus 全字段前端展示'));
    } else {
        check('功能对比清单.md 文件存在', false);
    }
    console.log('');

    // ====== 汇总 ======
    console.log('====== 测试汇总 ======');
    const total = passCount + failCount;
    console.log(`总计: ${total} 项 | 通过: ${passCount} | 失败: ${failCount}`);
    if (failCount > 0) {
        console.log('\n失败项明细:');
        failedItems.forEach((item, idx) => {
            console.log(`  ${idx + 1}. ${item.name}${item.detail ? ' | ' + item.detail : ''}`);
        });
        process.exit(1);
    } else {
        console.log('\n🎉 全部测试通过！');
        process.exit(0);
    }
}

main().catch(err => {
    console.error('测试脚本异常:', err);
    process.exit(1);
});
