/**
 * OpenAPI 文档补丁脚本：扩展多人副本系统支持昆吾山(kunwu)与虚天殿(xutian)
 *
 * 作用：在已有"多人副本系统"接口的基础上，扩展 dungeon_key 枚举、
 *      更新 /advance 接口描述（覆盖 kunwu 第四幕 + xutian 第六幕自动决战）、
 *      追加虚天殿专属变量字段到 Schema。
 *
 * 具体变更：
 *   1. 全量扫描 paths.* 中所有 dungeon_key 枚举数组，
 *      将 ["yanyue", "duanwu"] 或 ["yanyue", "duanwu", "kunwu"]
 *      统一扩展为 ["yanyue", "duanwu", "kunwu", "xutian"]
 *   2. reset-cooldown 接口的 dungeon_key 枚举扩展为
 *      ["yanyue", "duanwu", "kunwu", "xutian", "all"]
 *   3. 更新 /api/multi-dungeon/advance 接口 summary 与 description，
 *      说明同时支持 kunwu（玲珑封魔塔5回合）与 xutian（虚天主魂6回合）
 *   4. 在 components.schemas.MultiDungeonInstanceResponse 与
 *      MultiDungeonStatusResponse 的 dungeon_key enum 中追加 xutian
 *   5. 在 MultiDungeonStatusResponse.variables 中追加虚天殿专属变量字段
 *      path_choice / formation_power / void_soul_hp
 *   6. 新增 schema: MultiDungeonXutianVariables（虚天殿专属变量集合）
 *
 * 运行方式：node server/scripts/openapi_patch_multi_dungeon_kunwu_xutian.js
 * 幂等性：可重复执行，重复运行不会产生重复定义
 */
'use strict';

const fs = require('fs');
const path = require('path');

// 目标文件路径
const OPENAPI_PATH = path.resolve(__dirname, '../../docs/openapi.json');

// 副本键全集（不含 all）
const ALL_DUNGEON_KEYS = ['yanyue', 'duanwu', 'kunwu', 'xutian'];
// 含 all 的全集（reset-cooldown 使用）
const ALL_DUNGEON_KEYS_WITH_ALL = ['yanyue', 'duanwu', 'kunwu', 'xutian', 'all'];

try {
    console.log('[openapi_patch_kunwu_xutian] 开始更新 docs/openapi.json');

    // 1. 读取原文件
    const rawContent = fs.readFileSync(OPENAPI_PATH, 'utf8');
    const spec = JSON.parse(rawContent);
    console.log('[openapi_patch_kunwu_xutian] 原始文件已加载，paths 数量:', Object.keys(spec.paths || {}).length);

    // ============ 2. 扫描所有 paths，扩展 dungeon_key 枚举 ============
    // 收集所有需要更新的 dungeon_key 枚举位置
    let updatedEnums = 0;

    /**
     * 递归遍历对象，查找并替换 dungeon_key 枚举数组
     * @param {any} obj - 当前遍历的对象
     * @param {string[]} targetKeys - 目标枚举数组
     * @returns {number} 更新数量
     */
    function replaceDungeonKeyEnums(obj, targetKeys) {
        let count = 0;
        if (!obj || typeof obj !== 'object') return 0;

        // 处理数组
        if (Array.isArray(obj)) {
            for (const item of obj) {
                count += replaceDungeonKeyEnums(item, targetKeys);
            }
            return count;
        }

        // 处理对象
        for (const [key, value] of Object.entries(obj)) {
            if (key === 'dungeon_key' && value && typeof value === 'object') {
                // 检查是否有 enum 数组
                if (Array.isArray(value.enum)) {
                    // 判断是否需要扩展：
                    // - 不含 "all"：扩展为 targetKeys（4个副本键）
                    // - 含 "all"：扩展为 targetKeys + ['all']
                    const hasAll = value.enum.includes('all');
                    const newEnum = hasAll ? targetKeys.concat(['all']) : targetKeys.slice();

                    // 仅当新枚举与旧枚举不同时更新
                    if (JSON.stringify(value.enum) !== JSON.stringify(newEnum)) {
                        // 验证：旧枚举必须是新枚举的子集（防止意外覆盖）
                        const isSubset = value.enum.every(k => newEnum.includes(k));
                        if (isSubset) {
                            value.enum = newEnum;
                            count++;
                            console.log(`[openapi_patch_kunwu_xutian] 扩展 dungeon_key 枚举为: [${newEnum.join(', ')}]`);
                        }
                    }
                }
            } else if (value && typeof value === 'object') {
                count += replaceDungeonKeyEnums(value, targetKeys);
            }
        }
        return count;
    }

    updatedEnums += replaceDungeonKeyEnums(spec.paths, ALL_DUNGEON_KEYS);
    console.log(`[openapi_patch_kunwu_xutian] paths 中扩展 dungeon_key 枚举: ${updatedEnums} 处`);

    // ============ 3. 更新 /api/multi-dungeon/advance 接口描述 ============
    const advancePath = spec.paths?.['/api/multi-dungeon/advance'];
    if (advancePath?.post) {
        // 更新 summary
        advancePath.post.summary = '队长触发自动决战（昆吾山第四幕 / 虚天殿第六幕）';
        // 更新 description
        advancePath.post.description = [
            '通用自动决战接口，根据副本 instance_key 分发到对应副本的决战处理器：',
            '',
            '1. 昆吾山·封魔塔（kunwu）第四幕【玲珑封魔塔决战】',
            '   - 5 回合自动战斗，每回合伤害 = 200000 + 玲珑值 × 2000',
            '   - 5 回合内击杀塔心魔影（HP=1000000）且封印推进值>=80 即通关',
            '',
            '2. 虚天殿（xutian）第六幕【虚天主魂·幻海归元】',
            '   - 6 回合自动决战，每回合伤害 = 180000 + 阵法强度 × 2500',
            '   - 6 回合内削减虚天主魂 HP（初始 1500000）至 0 即通关',
            '   - 阵法强度由前 5 幕抉择累积（0-100），越高越易通关',
            '',
            '仅在当前幕标记 is_auto_advance 时允许调用。'
        ].join('\n');
        console.log('[openapi_patch_kunwu_xutian] 已更新 /advance 接口描述');
    } else {
        console.warn('[openapi_patch_kunwu_xutian] 警告: /api/multi-dungeon/advance 接口不存在，跳过描述更新');
    }

    // ============ 4. 更新 create 接口 description（提及4个副本） ============
    const createPath = spec.paths?.['/api/multi-dungeon/create'];
    if (createPath?.post) {
        createPath.post.description = '队长开启多人副本（掩月抢亲/端午镇蛟/昆吾山·封魔塔/虚天殿），校验前置条件并消耗物品。校验通过后创建副本实例，队长自动加入。';
        console.log('[openapi_patch_kunwu_xutian] 已更新 /create 接口描述');
    }

    // ============ 5. 更新 cooldown 接口 description（提及4个副本） ============
    const cooldownPath = spec.paths?.['/api/multi-dungeon/cooldown'];
    if (cooldownPath?.get) {
        cooldownPath.get.description = '查询玩家在 yanyue、duanwu、kunwu、xutian 四个副本的当前冷却状态，返回剩余冷却时间。该接口为只读操作。';
        console.log('[openapi_patch_kunwu_xutian] 已更新 /cooldown 接口描述');
    }

    // ============ 6. 更新 help 接口 description ============
    const helpPath = spec.paths?.['/api/multi-dungeon/help'];
    if (helpPath?.get) {
        helpPath.get.description = '返回所有副本（掩月抢亲/端午镇蛟/昆吾山·封魔塔/虚天殿）的玩法概要、前置条件、状态机说明。该接口为只读操作。';
        console.log('[openapi_patch_kunwu_xutian] 已更新 /help 接口描述');
    }

    // ============ 7. 更新 rewards 接口 description ============
    const rewardsPath = spec.paths?.['/api/multi-dungeon/rewards'];
    if (rewardsPath?.get) {
        rewardsPath.get.description = '查看指定副本的奖励池配置（支持 yanyue/duanwu/kunwu/xutian），包括奖励key、奖励内容、触发条件。该接口为只读操作。';
        console.log('[openapi_patch_kunwu_xutian] 已更新 /rewards 接口描述');
    }

    // ============ 8. 更新 Schema 定义 ============
    if (!spec.components?.schemas) {
        console.warn('[openapi_patch_kunwu_xutian] 警告: components.schemas 不存在');
    } else {
        const schemas = spec.components.schemas;

        // 8.1 MultiDungeonInstanceResponse - 更新 dungeon_key 枚举
        if (schemas.MultiDungeonInstanceResponse?.properties?.dungeon_key?.enum) {
            schemas.MultiDungeonInstanceResponse.properties.dungeon_key.enum = ALL_DUNGEON_KEYS.slice();
            schemas.MultiDungeonInstanceResponse.properties.dungeon_key.description = '副本键：yanyue=掩月抢亲，duanwu=端午镇蛟，kunwu=昆吾山·封魔塔，xutian=虚天殿';
            console.log('[openapi_patch_kunwu_xutian] 已更新 MultiDungeonInstanceResponse.dungeon_key 枚举');
        }

        // 8.2 MultiDungeonStatusResponse - 更新 dungeon_key 枚举 + 添加虚天殿专属变量
        if (schemas.MultiDungeonStatusResponse?.properties?.dungeon_key?.enum) {
            schemas.MultiDungeonStatusResponse.properties.dungeon_key.enum = ALL_DUNGEON_KEYS.slice();
            schemas.MultiDungeonStatusResponse.properties.dungeon_key.description = '副本键';
            console.log('[openapi_patch_kunwu_xutian] 已更新 MultiDungeonStatusResponse.dungeon_key 枚举');
        }
        // 在 variables 中追加虚天殿专属变量字段
        if (schemas.MultiDungeonStatusResponse?.properties?.variables?.properties) {
            const varProps = schemas.MultiDungeonStatusResponse.properties.variables.properties;
            // 仅追加不存在的字段（幂等）
            if (!varProps.path_choice) {
                varProps.path_choice = {
                    type: 'integer',
                    description: '虚天殿·道路选择（0=未选 / 1=冰道 / 2=火道），仅 xutian 副本返回',
                    enum: [0, 1, 2]
                };
                console.log('[openapi_patch_kunwu_xutian] 已追加 variables.path_choice 字段');
            }
            if (!varProps.formation_power) {
                varProps.formation_power = {
                    type: 'integer',
                    minimum: 0,
                    maximum: 100,
                    description: '虚天殿·阵法强度（0-100，影响第六幕决战伤害与通关），仅 xutian 副本返回'
                };
                console.log('[openapi_patch_kunwu_xutian] 已追加 variables.formation_power 字段');
            }
            if (!varProps.void_soul_hp) {
                varProps.void_soul_hp = {
                    type: 'string',
                    description: '虚天殿·虚天主魂 HP（字符串形式的 BIGINT，null=未进入第六幕），仅 xutian 副本返回',
                    nullable: true
                };
                console.log('[openapi_patch_kunwu_xutian] 已追加 variables.void_soul_hp 字段');
            }
            // 追加昆吾山专属变量字段（若不存在）
            if (!varProps.demonic_qi) {
                varProps.demonic_qi = { type: 'integer', minimum: 0, maximum: 100, description: '昆吾山·魔气值（0-100，>=100 失败）' };
            }
            if (!varProps.mountain_seal) {
                varProps.mountain_seal = { type: 'integer', minimum: 0, maximum: 100, description: '昆吾山·山禁值（0-100）' };
            }
            if (!varProps.treasure_pressure) {
                varProps.treasure_pressure = { type: 'integer', minimum: 0, maximum: 100, description: '昆吾山·宝压值（0-100）/ 虚天殿·夺宝压力（0-100）' };
            }
            if (!varProps.linglong) {
                varProps.linglong = { type: 'integer', minimum: 0, maximum: 100, description: '昆吾山·玲珑值（0-100，越高决战伤害越高）' };
            }
            if (!varProps.seal_progress) {
                varProps.seal_progress = { type: 'integer', minimum: 0, maximum: 100, description: '昆吾山·封印推进值（第四幕，需>=80通关）' };
            }
            if (!varProps.tower_shadow_hp) {
                varProps.tower_shadow_hp = { type: 'string', description: '昆吾山·塔心魔影 HP（字符串形式的 BIGINT）', nullable: true };
            }
        }

        // 8.3 MultiDungeonRewardsResponse - 更新 dungeon_key 枚举
        if (schemas.MultiDungeonRewardsResponse?.properties?.dungeon_key?.enum) {
            schemas.MultiDungeonRewardsResponse.properties.dungeon_key.enum = ALL_DUNGEON_KEYS.slice();
            console.log('[openapi_patch_kunwu_xutian] 已更新 MultiDungeonRewardsResponse.dungeon_key 枚举');
        }

        // 8.4 新增 MultiDungeonXutianVariables Schema（虚天殿专属变量集合）
        if (!schemas.MultiDungeonXutianVariables) {
            schemas.MultiDungeonXutianVariables = {
                type: 'object',
                description: '虚天殿副本专属变量集合（仅 xutian 副本返回，其他副本为默认值）',
                properties: {
                    path_choice: {
                        type: 'integer',
                        description: '道路选择（第一幕）：0=未选 / 1=冰道 / 2=火道',
                        enum: [0, 1, 2]
                    },
                    formation_power: {
                        type: 'integer',
                        minimum: 0,
                        maximum: 100,
                        description: '阵法强度（0-100）：由前5幕抉择累积，影响第六幕决战每回合伤害（基础 180000 + 阵法强度 × 2500），越高越易通关'
                    },
                    void_soul_hp: {
                        type: 'string',
                        description: '虚天主魂 HP（字符串形式的 BIGINT）：初始 1500000，第六幕每回合被削减，归零则通关。null 表示未进入第六幕',
                        nullable: true
                    },
                    treasure_pressure: {
                        type: 'integer',
                        minimum: 0,
                        maximum: 100,
                        description: '夺宝压力（0-100）：第四幕夺鼎抉择累积，影响后续魔染与封印稳定度'
                    }
                }
            };
            console.log('[openapi_patch_kunwu_xutian] 已新增 MultiDungeonXutianVariables schema');
        }

        // 8.5 新增 MultiDungeonXutianRoundLog Schema（虚天殿第六幕决战回合日志）
        if (!schemas.MultiDungeonXutianRoundLog) {
            schemas.MultiDungeonXutianRoundLog = {
                type: 'object',
                description: '虚天殿第六幕自动决战回合日志',
                properties: {
                    round: { type: 'integer', description: '回合数（1-6）' },
                    damage: { type: 'string', description: '本回合造成伤害（字符串形式的 BIGINT）' },
                    void_soul_hp_before: { type: 'string', description: '本回合前虚天主魂 HP' },
                    void_soul_hp_after: { type: 'string', description: '本回合后虚天主魂 HP' },
                    formation_power_after: { type: 'integer', description: '本回合后阵法强度' },
                    morale_after: { type: 'integer', description: '本回合后士气值' }
                }
            };
            console.log('[openapi_patch_kunwu_xutian] 已新增 MultiDungeonXutianRoundLog schema');
        }
    }

    // ============ 9. 更新 tags 描述 ============
    if (Array.isArray(spec.tags)) {
        for (const tag of spec.tags) {
            if (tag.name === '多人副本系统') {
                tag.description = '掩月抢亲/端午镇蛟/昆吾山·封魔塔/虚天殿 多人副本系统玩家接口';
            } else if (tag.name === '多人副本系统GM管理') {
                tag.description = '多人副本系统GM后台管理接口（含4个副本）';
            }
        }
        console.log('[openapi_patch_kunwu_xutian] 已更新 tags 描述');
    }

    // ============ 10. 写回文件 ============
    const output = JSON.stringify(spec, null, 4);
    fs.writeFileSync(OPENAPI_PATH, output, 'utf8');

    console.log('\n[openapi_patch_kunwu_xutian] 更新完成！');
    console.log(`  - 扩展 dungeon_key 枚举位置: ${updatedEnums} 处`);
    console.log(`  - 更新接口描述: 6 处`);
    console.log(`  - 新增 schemas: 2 个（MultiDungeonXutianVariables / MultiDungeonXutianRoundLog）`);
    console.log(`  - 当前 paths 总数: ${Object.keys(spec.paths).length}`);
    console.log(`  - 当前 schemas 总数: ${Object.keys(spec.components?.schemas || {}).length}`);
} catch (err) {
    console.error('[openapi_patch_kunwu_xutian] 执行失败:', err);
    process.exit(1);
}
