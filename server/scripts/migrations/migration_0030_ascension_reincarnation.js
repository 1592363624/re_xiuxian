/**
 * 数据库迁移脚本
 * 版本: 0030
 * 描述: 飞升与夺舍重生系统（4 张新表 + 3 条夺舍目标种子数据）
 * 创建时间: 2026-07-19
 *
 * 新建表：
 *   1. player_ascension        - 玩家飞升进度表（大衍诀层数/法则碎片/逆灵通道坐标/历史飞升记录）
 *   2. player_ascension_node   - 玩家空间节点表（搜寻/定星/稳固节点）
 *   3. reincarnation_target    - 夺舍目标配置表（静态种子数据：凡人/修士/妖兽）
 *   4. player_reincarnation    - 玩家夺舍记录表（历史夺舍日志）
 *
 * 设计要点：
 *   - 玩家飞升进度表使用 UNIQUE KEY (player_id) 保证 1:1 关系
 *   - 节点表使用 (player_id, node_key) 唯一键防止重复搜寻
 *   - 夺舍目标表预置 3 条种子数据（凡人武者/修士/妖兽），覆盖三类风险等级
 *   - 夺舍记录表保留全量字段，便于审计与排行
 *   - 修为/伤害等大数使用 BIGINT 防溢出
 *
 * 幂等性：每张表创建前检查 INFORMATION_SCHEMA.TABLES；种子数据使用 INSERT IGNORE
 *
 * MySQL 5.6 兼容性：
 *   - 字符集 utf8mb4 保证中文存储
 *   - ENGINE=InnoDB 支持事务与行级锁
 *   - BOOLEAN 使用 TINYINT(1)，JSON 字段使用 LONGTEXT 兜底
 */

module.exports = {
    description: '飞升与夺舍重生系统：4 张表（玩家飞升进度/空间节点/夺舍目标种子/夺舍记录）',
    version: 30,

    /**
     * 执行迁移：创建 4 张新表 + 插入夺舍目标种子数据
     * @param {Object} sequelize - Sequelize 实例
     * @param {Object} QueryTypes - 查询类型枚举
     */
    async up(sequelize, QueryTypes) {
        console.log('[Migration v0030] 开始创建飞升+夺舍重生系统表...');

        // ===== 1. player_ascension 表：玩家飞升进度表 =====
        await createTableIfNotExists(sequelize, 'player_ascension', `
            CREATE TABLE player_ascension (
                id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '主键ID',
                player_id BIGINT NOT NULL COMMENT '玩家ID',
                ascension_state VARCHAR(20) NOT NULL DEFAULT 'preparing' COMMENT '飞升状态：preparing=准备中，ascending=飞升中，success=成功，failed=失败，reverting=回溯中',
                dayan_level INT NOT NULL DEFAULT 0 COMMENT '大衍诀层数（0-5），飞升需达 5=衍神',
                dayan_exp INT NOT NULL DEFAULT 0 COMMENT '大衍诀当前层数熟练度',
                reverse_channel_coord VARCHAR(100) NULL COMMENT '逆灵通道坐标（定星成功获得）',
                law_fragments_count INT NOT NULL DEFAULT 0 COMMENT '空间法则碎片数量（飞升需≥5）',
                ascension_attempt_count INT NOT NULL DEFAULT 0 COMMENT '历史飞升尝试次数',
                ascension_success_count INT NOT NULL DEFAULT 0 COMMENT '历史飞升成功次数',
                last_ascension_time DATETIME NULL COMMENT '最后飞升时间（冷却用）',
                last_revert_time DATETIME NULL COMMENT '最后天机回溯时间',
                revert_count INT NOT NULL DEFAULT 0 COMMENT '今日天机回溯剩余次数（跨日重置为1）',
                last_revert_date DATE NULL COMMENT '最后回溯日期（跨日重置）',
                is_ascended TINYINT NOT NULL DEFAULT 0 COMMENT '是否已飞升灵界（0否1是）',
                ascended_at DATETIME NULL COMMENT '飞升成功时间',
                ascension_realm VARCHAR(20) NULL COMMENT '飞升后所在界域（lingji=灵界）',
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
                UNIQUE KEY uk_pa_player (player_id),
                INDEX idx_pa_state (ascension_state),
                INDEX idx_pa_ascended (is_ascended)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='玩家飞升进度表'
        `);

        // ===== 2. player_ascension_node 表：玩家空间节点表 =====
        await createTableIfNotExists(sequelize, 'player_ascension_node', `
            CREATE TABLE player_ascension_node (
                id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '主键ID',
                player_id BIGINT NOT NULL COMMENT '玩家ID',
                node_key VARCHAR(50) NOT NULL COMMENT '节点配置键（如 unstable_void_01）',
                node_name VARCHAR(100) NOT NULL COMMENT '节点显示名（如「虚空中裂痕」）',
                node_state VARCHAR(20) NOT NULL DEFAULT 'discovered' COMMENT '节点状态：discovered=已发现，stabilizing=稳固中，stable=已稳固，failed=稳固失败',
                stability INT NOT NULL DEFAULT 0 COMMENT '稳固度（0-100，达80可定星）',
                reward_type VARCHAR(30) NULL COMMENT '稳固成功奖励类型：coord/dan_recipe/spirit_milk/law_fragment',
                reward_claimed TINYINT NOT NULL DEFAULT 0 COMMENT '奖励是否已领取（0否1是）',
                discovered_at DATETIME NOT NULL COMMENT '发现时间',
                stabilize_started_at DATETIME NULL COMMENT '开始稳固时间',
                stabilized_at DATETIME NULL COMMENT '稳固完成时间',
                expires_at DATETIME NOT NULL COMMENT '节点消失时间（未稳固则消失）',
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
                UNIQUE KEY uk_pan_player_node (player_id, node_key),
                INDEX idx_pan_player_state (player_id, node_state),
                INDEX idx_pan_expires (expires_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='玩家空间节点表'
        `);

        // ===== 3. reincarnation_target 表：夺舍目标配置表（静态种子） =====
        await createTableIfNotExists(sequelize, 'reincarnation_target', `
            CREATE TABLE reincarnation_target (
                id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '主键ID',
                target_key VARCHAR(50) NOT NULL COMMENT '目标配置键（如 mortal_warrior_03）',
                target_name VARCHAR(100) NOT NULL COMMENT '目标显示名',
                target_type VARCHAR(20) NOT NULL COMMENT '目标类型：mortal=凡人，cultivator=修士，monster=妖兽',
                realm_rank INT NOT NULL COMMENT '目标境界rank（夺舍后跌落基准）',
                base_atk INT NOT NULL COMMENT '基础攻击',
                base_def INT NOT NULL COMMENT '基础防御',
                base_hp_max INT NOT NULL COMMENT '基础气血上限',
                base_speed INT NOT NULL COMMENT '基础速度',
                base_sense INT NOT NULL COMMENT '基础神识',
                spirit_root_grade VARCHAR(20) NULL COMMENT '灵根资质（伪灵根/单灵根/双灵根等）',
                talent_id VARCHAR(50) NULL COMMENT '天赋ID（部分目标自带特殊天赋）',
                inherit_ratio FLOAT NOT NULL DEFAULT 0.5 COMMENT '属性继承比例（0.3-0.7）',
                drop_realm_count INT NOT NULL DEFAULT 1 COMMENT '夺舍后境界跌落数（1-3）',
                risk_level INT NOT NULL DEFAULT 1 COMMENT '风险等级（1低-3高，影响成功率）',
                description TEXT NULL COMMENT '目标背景描述',
                weight INT NOT NULL DEFAULT 100 COMMENT '出现权重（影响推送概率）',
                is_rare TINYINT NOT NULL DEFAULT 0 COMMENT '是否稀有目标（0否1是，稀有目标属性更好）',
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
                UNIQUE KEY uk_rt_target_key (target_key),
                INDEX idx_rt_type (target_type),
                INDEX idx_rt_risk (risk_level)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='夺舍目标配置表（静态种子数据）'
        `);

        // ===== 4. player_reincarnation 表：玩家夺舍记录表 =====
        await createTableIfNotExists(sequelize, 'player_reincarnation', `
            CREATE TABLE player_reincarnation (
                id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '主键ID',
                player_id BIGINT NOT NULL COMMENT '玩家ID',
                origin_realm VARCHAR(30) NOT NULL COMMENT '原境界',
                origin_realm_rank INT NOT NULL COMMENT '原境界rank',
                origin_exp BIGINT NOT NULL COMMENT '原修为',
                target_id BIGINT NOT NULL COMMENT '夺舍目标ID',
                target_name VARCHAR(100) NOT NULL COMMENT '夺舍目标名',
                new_realm VARCHAR(30) NOT NULL COMMENT '夺舍后境界',
                new_realm_rank INT NOT NULL COMMENT '夺舍后境界rank',
                new_exp BIGINT NOT NULL COMMENT '夺舍后修为',
                inherited_atk INT NOT NULL COMMENT '继承的攻击',
                inherited_def INT NOT NULL COMMENT '继承的防御',
                inherited_hp_max INT NOT NULL COMMENT '继承的气血上限',
                inherit_ratio FLOAT NOT NULL COMMENT '实际继承比例',
                success TINYINT NOT NULL DEFAULT 1 COMMENT '是否夺舍成功（0否1是）',
                death_reason VARCHAR(50) NOT NULL COMMENT '死亡原因（lifespan_out/pvp_kill/breakthrough_fail/ascension_fail）',
                reincarnated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '夺舍时间',
                cooldown_end_time DATETIME NOT NULL COMMENT '夺舍冷却结束时间（72小时）',
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
                INDEX idx_pr_player (player_id),
                INDEX idx_pr_reincarnated_at (reincarnated_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='玩家夺舍记录表'
        `);

        // ===== 插入夺舍目标种子数据（3 条：凡人/修士/妖兽） =====
        await insertReincarnationTargets(sequelize);

        console.log('[Migration v0030] 迁移完成：创建 4 张飞升+夺舍重生系统表 + 3 条夺舍目标种子');
    },

    /**
     * 回滚迁移：删除 4 张表
     * @param {Object} sequelize - Sequelize 实例
     * @param {Object} QueryTypes - 查询类型枚举
     */
    async down(sequelize, QueryTypes) {
        console.log('[Migration v0030] 开始回滚飞升+夺舍重生系统...');

        // 按依赖关系倒序删除
        const tablesToDrop = [
            'player_reincarnation',
            'reincarnation_target',
            'player_ascension_node',
            'player_ascension'
        ];
        for (const table of tablesToDrop) {
            try {
                await sequelize.query(`DROP TABLE IF EXISTS ${table}`);
                console.log(`  ✓ 删除表: ${table}`);
            } catch (e) {
                console.log(`  - 删除表失败，跳过: ${table}（${e.message}）`);
            }
        }

        console.log('[Migration v0030] 回滚完成');
    }
};

/**
 * 工具函数：检查表是否存在，不存在则创建
 * @param {Object} sequelize - Sequelize 实例
 * @param {string} tableName - 表名
 * @param {string} createSql - CREATE TABLE SQL
 */
async function createTableIfNotExists(sequelize, tableName, createSql) {
    const [tables] = await sequelize.query(`
        SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${tableName}'
    `);
    if (tables.length === 0) {
        await sequelize.query(createSql);
        console.log(`  ✓ 创建表: ${tableName}`);
    } else {
        console.log(`  - 表已存在，跳过: ${tableName}`);
    }
}

/**
 * 插入夺舍目标种子数据（3 条：凡人武者/修士/妖兽）
 * 使用 INSERT IGNORE 保证幂等性
 * @param {Object} sequelize - Sequelize 实例
 */
async function insertReincarnationTargets(sequelize) {
    // 检查是否已有种子数据（通过 target_key 唯一键判断）
    const [existing] = await sequelize.query(`
        SELECT COUNT(*) AS cnt FROM reincarnation_target
        WHERE target_key IN ('mortal_warrior_03', 'cultivator_yuanying_02', 'monster_wolf_king_01')
    `);
    const cnt = existing[0]?.cnt || 0;
    if (cnt >= 3) {
        console.log('  - 夺舍目标种子数据已存在，跳过插入');
        return;
    }

    // 种子数据：覆盖凡人/修士/妖兽 三类目标，风险等级 1/2/3
    const seedSql = `
        INSERT IGNORE INTO reincarnation_target
            (target_key, target_name, target_type, realm_rank,
             base_atk, base_def, base_hp_max, base_speed, base_sense,
             spirit_root_grade, talent_id, inherit_ratio, drop_realm_count,
             risk_level, description, weight, is_rare)
        VALUES
            ('mortal_warrior_03', '凡人武者·铁骨散人', 'mortal', 1,
             80, 60, 500, 30, 10,
             '伪灵根', 'common_talent', 0.3, 1,
             1, '江湖中颇有名气的武者，肉身强健但毫无修为根骨，夺舍后跌落至凡人，但成功率最高', 100, 0),
            ('cultivator_yuanying_02', '元婴修士·青云散人', 'cultivator', 18,
             1500, 900, 8000, 200, 300,
             '双灵根', 'dual_spirit_talent', 0.5, 1,
             2, '陨落的元婴期修士，灵根资质上佳，肉身尚未完全腐朽，夺舍后可继承元婴境界，但成功率中等', 60, 1),
            ('monster_wolf_king_01', '三阶妖兽·噬魂狼王', 'monster', 15,
             2200, 600, 12000, 350, 200,
             NULL, 'beast_talent', 0.7, 2,
             3, '三阶巅峰妖兽，肉身强横但神识混乱，夺舍后保留更多修为但境界跌落更多，风险最高', 30, 1)
    `;
    await sequelize.query(seedSql);
    console.log('  ✓ 插入夺舍目标种子数据：3 条（凡人武者/元婴修士/妖兽狼王）');
}
