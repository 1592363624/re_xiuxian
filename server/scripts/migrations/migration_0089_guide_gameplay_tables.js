/**
 * 迁移脚本 0089：创建琉璃古塔 / 剑诀 / 事件奇遇 / 宗门外交 / 定脉 五套表
 *
 * 设计依据：xiuxian_game_guide.md 第22/25/30/33 节（指南补完·纯玩法批次）
 *
 * 表：
 *   - player_pagoda / player_pagoda_records：古塔进度与闯关记录
 *   - player_sword_arts：剑诀参悟/炼剑/剑阵
 *   - player_fated_events：进行中奇遇
 *   - sect_diplomacies：宗门外交关系
 *   - player_dingmai：落云宗定脉个人状态
 *
 * 全部幂等：表已存在则跳过。
 */
'use strict';

module.exports = {
    name: '0089_guide_gameplay_tables',
    description: '创建古塔/剑诀/奇遇/宗门外交/定脉表',

    up: async (sequelize, QueryTypes) => {
        async function tableExists(tableName) {
            const [result] = await sequelize.query(
                `SELECT COUNT(*) AS cnt FROM INFORMATION_SCHEMA.TABLES
                 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :tbl`,
                { replacements: { tbl: tableName }, type: QueryTypes.SELECT }
            );
            return result && result.cnt > 0;
        }

        if (!(await tableExists('player_pagoda'))) {
            console.log('[migration_0089] 创建表 player_pagoda');
            await sequelize.query(`
                CREATE TABLE player_pagoda (
                    id BIGINT NOT NULL AUTO_INCREMENT,
                    player_id BIGINT NOT NULL,
                    highest_floor INT NOT NULL DEFAULT 0,
                    current_floor INT NOT NULL DEFAULT 0,
                    in_tower TINYINT(1) NOT NULL DEFAULT 0,
                    today_attempts INT NOT NULL DEFAULT 0,
                    today_resets INT NOT NULL DEFAULT 0,
                    attempt_date VARCHAR(10) NULL,
                    first_clear_mask TEXT NULL,
                    last_score INT NOT NULL DEFAULT 0,
                    best_score INT NOT NULL DEFAULT 0,
                    total_clears INT NOT NULL DEFAULT 0,
                    last_attempt_at DATETIME NULL,
                    created_at DATETIME NOT NULL,
                    updated_at DATETIME NOT NULL,
                    PRIMARY KEY (id),
                    UNIQUE KEY idx_pp_player (player_id),
                    KEY idx_pp_best_score (best_score),
                    KEY idx_pp_highest_floor (highest_floor)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='琉璃古塔进度'
            `);
        } else {
            console.log('[migration_0089] 表 player_pagoda 已存在，跳过');
        }

        if (!(await tableExists('player_pagoda_records'))) {
            console.log('[migration_0089] 创建表 player_pagoda_records');
            await sequelize.query(`
                CREATE TABLE player_pagoda_records (
                    id BIGINT NOT NULL AUTO_INCREMENT,
                    player_id BIGINT NOT NULL,
                    player_nickname VARCHAR(50) NOT NULL,
                    floor INT NOT NULL,
                    floor_name VARCHAR(50) NULL,
                    result VARCHAR(20) NOT NULL,
                    score INT NOT NULL DEFAULT 0,
                    rounds_used INT NOT NULL DEFAULT 0,
                    player_hp_remaining BIGINT NOT NULL DEFAULT 0,
                    is_first_clear TINYINT(1) NOT NULL DEFAULT 0,
                    exp_gained BIGINT NOT NULL DEFAULT 0,
                    spirit_stones_gained BIGINT NOT NULL DEFAULT 0,
                    battle_log TEXT NULL,
                    created_at DATETIME NOT NULL,
                    PRIMARY KEY (id),
                    KEY idx_ppr_player (player_id),
                    KEY idx_ppr_score (score),
                    KEY idx_ppr_floor (floor, created_at)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='琉璃古塔闯关记录'
            `);
        } else {
            console.log('[migration_0089] 表 player_pagoda_records 已存在，跳过');
        }

        if (!(await tableExists('player_sword_arts'))) {
            console.log('[migration_0089] 创建表 player_sword_arts');
            await sequelize.query(`
                CREATE TABLE player_sword_arts (
                    id BIGINT NOT NULL AUTO_INCREMENT,
                    player_id BIGINT NOT NULL,
                    manual_id VARCHAR(50) NOT NULL,
                    insight INT NOT NULL DEFAULT 0,
                    sword_stage INT NOT NULL DEFAULT 0,
                    active_formation_id VARCHAR(50) NULL,
                    formation_until DATETIME NULL,
                    today_comprehend INT NOT NULL DEFAULT 0,
                    today_refine INT NOT NULL DEFAULT 0,
                    today_insight INT NOT NULL DEFAULT 0,
                    today_form INT NOT NULL DEFAULT 0,
                    count_date VARCHAR(10) NULL,
                    last_comprehend_at DATETIME NULL,
                    last_refine_at DATETIME NULL,
                    created_at DATETIME NOT NULL,
                    updated_at DATETIME NOT NULL,
                    PRIMARY KEY (id),
                    UNIQUE KEY idx_psa_player_manual (player_id, manual_id),
                    KEY idx_psa_player (player_id)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='玩家剑诀'
            `);
        } else {
            console.log('[migration_0089] 表 player_sword_arts 已存在，跳过');
        }

        if (!(await tableExists('player_fated_events'))) {
            console.log('[migration_0089] 创建表 player_fated_events');
            await sequelize.query(`
                CREATE TABLE player_fated_events (
                    id BIGINT NOT NULL AUTO_INCREMENT,
                    player_id BIGINT NOT NULL,
                    event_id VARCHAR(50) NOT NULL,
                    event_name VARCHAR(50) NOT NULL,
                    status VARCHAR(20) NOT NULL DEFAULT 'pending',
                    choice_id VARCHAR(50) NULL,
                    result VARCHAR(20) NULL,
                    payload TEXT NULL,
                    rewards_summary TEXT NULL,
                    today_count INT NOT NULL DEFAULT 0,
                    count_date VARCHAR(10) NULL,
                    expires_at DATETIME NULL,
                    resolved_at DATETIME NULL,
                    created_at DATETIME NOT NULL,
                    updated_at DATETIME NOT NULL,
                    PRIMARY KEY (id),
                    KEY idx_pfe_player (player_id),
                    KEY idx_pfe_player_status (player_id, status),
                    KEY idx_pfe_expires (expires_at)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='进行中事件奇遇'
            `);
        } else {
            console.log('[migration_0089] 表 player_fated_events 已存在，跳过');
        }

        if (!(await tableExists('sect_diplomacies'))) {
            console.log('[migration_0089] 创建表 sect_diplomacies');
            await sequelize.query(`
                CREATE TABLE sect_diplomacies (
                    id BIGINT NOT NULL AUTO_INCREMENT,
                    sect_a_id VARCHAR(30) NOT NULL,
                    sect_b_id VARCHAR(30) NOT NULL,
                    relation INT NOT NULL DEFAULT 0,
                    status VARCHAR(20) NOT NULL DEFAULT 'neutral',
                    updated_by BIGINT NULL,
                    note VARCHAR(200) NULL,
                    created_at DATETIME NOT NULL,
                    updated_at DATETIME NOT NULL,
                    PRIMARY KEY (id),
                    UNIQUE KEY idx_sd_pair (sect_a_id, sect_b_id),
                    KEY idx_sd_status (status)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='宗门外交关系'
            `);
        } else {
            console.log('[migration_0089] 表 sect_diplomacies 已存在，跳过');
        }

        if (!(await tableExists('player_dingmai'))) {
            console.log('[migration_0089] 创建表 player_dingmai');
            await sequelize.query(`
                CREATE TABLE player_dingmai (
                    id BIGINT NOT NULL AUTO_INCREMENT,
                    player_id BIGINT NOT NULL,
                    today_vein VARCHAR(20) NOT NULL DEFAULT 'calm',
                    today_orders INT NOT NULL DEFAULT 0,
                    today_charges INT NOT NULL DEFAULT 0,
                    count_date VARCHAR(10) NULL,
                    total_merit INT NOT NULL DEFAULT 0,
                    total_purify INT NOT NULL DEFAULT 0,
                    last_action VARCHAR(20) NULL,
                    last_action_at DATETIME NULL,
                    created_at DATETIME NOT NULL,
                    updated_at DATETIME NOT NULL,
                    PRIMARY KEY (id),
                    UNIQUE KEY idx_pd_player (player_id),
                    KEY idx_pd_merit (total_merit),
                    KEY idx_pd_purify (total_purify)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='落云宗定脉个人状态'
            `);
        } else {
            console.log('[migration_0089] 表 player_dingmai 已存在，跳过');
        }

        // 宗门树全局状态（定脉浊息/脉稳/成熟度）挂在 system_configs，无需新表
        console.log('[migration_0089] 全部完成');
    }
};
