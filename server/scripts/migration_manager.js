/**
 * 数据库迁移主控脚本
 * 管理所有数据库迁移的版本控制和执行
 */
const fs = require('fs');
const path = require('path');
const sequelize = require('../config/database');
const { QueryTypes } = require('sequelize');

const MIGRATION_DIR = path.join(__dirname, 'migrations');

/**
 * 迁移脚本的契约 —— 本文件是唯一权威，模板、门禁、启动路径都以它为准。
 *
 *     module.exports = {
 *         description: '…', version: 90,
 *         async up(sequelize, QueryTypes) { … },      // 第一个参数是 **sequelize 实例本身**
 *         async down(sequelize, QueryTypes) { … }      // 可省略；给了就必须是函数
 *     };
 *
 * 为什么要把这句话写下来：Sequelize 官方文档里的迁移签名是 `up(queryInterface, Sequelize)`，
 * 而本仓库的 runner 传的是 `(sequelize, QueryTypes)`。`createMigration` 生成的模板照抄了官方签名，
 * 于是**照着模板写出来的迁移一上线就把服务器拦在 boot 外** —— `queryInterface.addColumn is not a function`
 * 抛在 `migrationResult.success=false` 那条路上，index.js 直接 process.exit(1)。
 * 需要 queryInterface 的文件自己取：`const queryInterface = sequelize.getQueryInterface()`
 * （现网 0039/0053 就是这个写法，它们连 runner 传的参数都不用）。
 */
const CONTRACT = 'up(sequelize, QueryTypes)';

/** 历史遗留：这两份在 require 时就 process.chdir（改的是整个进程的 CWD）。不再新增，也不在这里顺手改它们。 */
const GRANDFATHERED_CHDIR = ['migration_0039_world_boss_skills_fields.js', 'migration_0053_world_boss_action_system.js'];
/** 历史遗留：0050 被两个文件同时占用。库里两者都已记录，改名会造出"库里记着、仓库里没有"的孤儿，所以只冻结不新增。 */
const GRANDFATHERED_VERSIONS = { 50: ['migration_0050_kunwu_choice_fields.js', 'migration_0050_spirit_beast_soul.js'] };

/** 从文件名解析版本号（解析不出来就是契约外文件） */
function parseMigrationFilename(filename) {
    const match = filename.match(/^migration_(\d+)_+(.+)\.js$/);
    if (!match) return null;
    return { version: parseInt(match[1], 10), name: match[2], filename };
}

/**
 * 单个迁移文件的形状检查（不连库、不执行任何 SQL）。
 * @returns {string[]} 问题列表，空数组 = 合格
 */
function checkMigrationShape(filename, src, mod) {
    const problems = [];
    if (!parseMigrationFilename(filename)) {
        problems.push(`${filename}: 文件名必须是 migration_<4位版本号>_<描述>.js，runner 靠它排序与回滚`);
    }
    if (!mod || typeof mod !== 'object' || Array.isArray(mod)) {
        problems.push(`${filename}: module.exports 不是对象，runner 拿不到 up`);
        return problems;
    }
    if (typeof mod.up !== 'function') {
        problems.push(`${filename}: 没有导出 up 函数（契约：module.exports = { ${CONTRACT} }）`);
        return problems;
    }
    if (mod.down !== undefined && typeof mod.down !== 'function') {
        problems.push(`${filename}: down 必须是函数（不给可以，给半个就不行）`);
    }
    // 用了 queryInterface 却没人给它：runner 传的第一个参数是 sequelize 实例，不是 queryInterface
    if (/\bqueryInterface\./.test(src) && !/getQueryInterface\s*\(/.test(src)) {
        problems.push(`${filename}: 引用了 queryInterface.* 但没有 sequelize.getQueryInterface() —— `
            + `runner 传进来的第一个参数是 sequelize 实例（契约 ${CONTRACT}），照官方签名写会在启动时抛 not a function`);
    }
    if (/\bprocess\.chdir\s*\(/.test(src) && !GRANDFATHERED_CHDIR.includes(filename)) {
        problems.push(`${filename}: 在 require 时 process.chdir() 会改掉整个服务器的当前目录（迁移不该有这种副作用）`);
    }
    return problems;
}

/** 全部迁移的静态盘点（不连库）：形状问题 + 版本号重复。 */
function inspectMigrations() {
    const files = fs.readdirSync(MIGRATION_DIR).filter(f => f.startsWith('migration_') && f.endsWith('.js')).sort();
    const problems = [];
    const byVersion = new Map();
    for (const file of files) {
        const full = path.join(MIGRATION_DIR, file);
        const src = fs.readFileSync(full, 'utf8');
        let mod = null;
        try {
            mod = require(full);
        } catch (error) {
            problems.push(`${file}: require 就失败 —— ${error.message}`);
        }
        problems.push(...checkMigrationShape(file, src, mod));
        const info = parseMigrationFilename(file);
        if (info) byVersion.set(info.version, [...(byVersion.get(info.version) || []), file]);
    }
    const duplicated = [...byVersion.entries()]
        .filter(([, list]) => list.length > 1)
        .map(([version, list]) => ({ version, files: list }))
        .filter(d => !(GRANDFATHERED_VERSIONS[d.version]
            && d.files.slice().sort().join('|') === GRANDFATHERED_VERSIONS[d.version].slice().sort().join('|')));
    return { files, problems, duplicated };
}

/** 生成新迁移文件的模板：与 CONTRACT 同一个签名，并且默认带上"重复执行安全"的骨架。 */
function migrationTemplate(version, description) {
    return `/**
 * 数据库迁移脚本
 * 版本: ${version}
 * 描述: ${description}
 * 创建时间: ${new Date().toISOString()}
 *
 * 契约（与本文件顶部那段一致）：runner 传进来的第一个参数是 **sequelize 实例**，不是 queryInterface。
 * 需要 queryInterface 就自己取：const queryInterface = sequelize.getQueryInterface()。
 * 启动时会自动跑这里，所以整段必须"重复执行安全"：先查 information_schema 再改。
 */
'use strict';

const MIGRATION_NAME = 'migration_${String(version).padStart(4, '0')}_${description}';

module.exports = {
    description: '${description}',
    version: ${version},

    async up(sequelize, QueryTypes) {
        // 加列示例（幂等）：
        // const has = await sequelize.query(
        //     'SELECT COUNT(*) AS count FROM information_schema.columns '
        //     + 'WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?',
        //     { replacements: ['players', 'new_field'], type: QueryTypes.SELECT }
        // );
        // if (Number(has[0]?.count || 0) === 0) {
        //     await sequelize.query('ALTER TABLE \`players\` ADD COLUMN \`new_field\` INT NOT NULL DEFAULT 0');
        // }
    },

    async down(sequelize, QueryTypes) {
        // 与 up 相反；确实不可逆就删掉这个函数（门禁允许没有 down，但不许有半个）
    }
};
`;
}

/**
 * 迁移版本记录表名
 */
const MIGRATIONS_TABLE = 'schema_migrations';

/**
 * 已执行的迁移记录
 */
const executedMigrations = new Set();

/**
 * 初始化迁移表
 */
async function initMigrationTable() {
    const query = `
        CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
            id INT AUTO_INCREMENT PRIMARY KEY,
            migration_name VARCHAR(191) NOT NULL,
            executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            checksum VARCHAR(64),
            description TEXT,
            UNIQUE KEY unique_migration_name (migration_name)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `;
    await sequelize.query(query);
    console.log(`[Migration] 表 ${MIGRATIONS_TABLE} 已就绪`);
}

/**
 * 获取所有迁移文件（按版本号排序）
 */
function getMigrationFiles() {
    const files = fs.readdirSync(MIGRATION_DIR)
        .filter(f => f.startsWith('migration_') && f.endsWith('.js'))
        .sort();
    return files;
}

/**
 * 获取已执行的迁移列表
 */
async function getExecutedMigrations() {
    try {
        const results = await sequelize.query(
            `SELECT migration_name FROM ${MIGRATIONS_TABLE}`,
            { type: QueryTypes.SELECT }
        );
        return new Set((results || []).map(r => r.migration_name));
    } catch (error) {
        console.error('[Migration] 获取已执行迁移失败:', error.message);
        return new Set();
    }
}

/**
 * 计算文件 checksum
 */
function calculateChecksum(filePath) {
    const content = fs.readFileSync(filePath, 'utf8');
    return require('crypto').createHash('sha256').update(content).digest('hex');
}

/**
 * 执行单个迁移
 */
async function executeMigration(filename) {
    const migration = require(path.join(MIGRATION_DIR, filename));
    
    console.log(`[Migration] 执行迁移: ${filename}`);
    
    try {
        await migration.up(sequelize, QueryTypes);
        
        const checksum = calculateChecksum(path.join(MIGRATION_DIR, filename));
        await sequelize.query(
            `INSERT IGNORE INTO ${MIGRATIONS_TABLE} (migration_name, checksum, description) VALUES (?, ?, ?)`,
            {
                replacements: [filename, checksum, migration.description || ''],
                type: QueryTypes.INSERT
            }
        );
        
        console.log(`[Migration] ✓ 迁移成功: ${filename}`);
        return true;
    } catch (error) {
        console.error(`[Migration] ✗ 迁移失败: ${filename}`);
        console.error(`  错误: ${error.message}`);
        throw error;
    }
}

/**
 * 回滚单个迁移
 */
async function rollbackMigration(filename) {
    const migration = require(path.join(MIGRATION_DIR, filename));
    
    console.log(`[Migration] 回滚迁移: ${filename}`);
    
    try {
        if (typeof migration.down === 'function') {
            await migration.down(sequelize, QueryTypes);
        }
        
        await sequelize.query(
            `DELETE FROM ${MIGRATIONS_TABLE} WHERE migration_name = ?`,
            {
                replacements: [filename],
                type: QueryTypes.DELETE
            }
        );
        
        console.log(`[Migration] ✓ 回滚成功: ${filename}`);
        return true;
    } catch (error) {
        console.error(`[Migration] ✗ 回滚失败: ${filename}`);
        console.error(`  错误: ${error.message}`);
        throw error;
    }
}

/**
 * 运行所有待执行的迁移
 */
/**
 * 仓库与库里的迁移记录对一遍账（只读，不改任何东西）。
 *
 * 三种对不上，各自都会静默生效很久：
 *   孤儿记录  —— 库里有、仓库里没有 = 线上库的结构已经不是这个仓库能重放出来的了；
 *                新库会跳过它（表建不出来），老库出问题没人知道是谁。本轮实测到一条：
 *                测试库记着 migration_0087_spirit_beast_stats.js，而那个文件已改名成 0088。
 *   校验和漂移 —— 记录之后又改过文件 = 改的内容**永远不会在已经跑过的库上重放**，
 *                表现是"我明明加了列，线上怎么没有"。
 *   版本号重复 —— `--to-version` / rollback 按版本号定位，两个同号时它不再唯一。
 * @param {Array<{migration_name: string, checksum: string|null}>} executedRows
 * @param {string[]} files 仓库里的迁移文件名
 * @param {string} [dir] 文件所在目录（默认迁移目录；测试里可以指到临时目录，不往仓库写文件）
 */
function auditMigrations(executedRows, files, dir = MIGRATION_DIR) {
    const onDisk = new Set(files);
    const orphans = executedRows.map(r => r.migration_name).filter(n => !onDisk.has(n));
    const recorded = new Map(executedRows.map(r => [r.migration_name, r.checksum]));
    const drift = [];
    for (const file of files) {
        const was = recorded.get(file);
        if (!was) continue;
        if (was !== calculateChecksum(path.join(dir, file))) drift.push(file);
    }
    const { duplicated } = dir === MIGRATION_DIR ? inspectMigrations() : { duplicated: [] };
    return { orphans, drift, duplicated };
}

/**
 * 把上面三件事打成日志。都是"看得见"级别，不拦启动：
 * 拦启动的只有下面 preflight 那条 —— 形状不对的迁移真跑起来会把服务器挡在 boot 外，
 * 而漂移/孤儿/重复号是历史事实，硬拦会让现网升不上去（本轮实测漂移就有 37 条）。
 */
function logMigrationAudit(audit) {
    if (audit.orphans.length) {
        console.warn(`[Migration] 库里有 ${audit.orphans.length} 条记录在仓库里找不到文件：${audit.orphans.join(', ')}`
            + ' —— 线上库的结构已经不全靠这个仓库重放得出来了，请补回文件或确认这条迁移确实该退役（退役也要留文件）');
    }
    if (audit.drift.length) {
        console.warn(`[Migration] ${audit.drift.length} 个迁移在记录之后被改过（改动不会在已跑过的库上重放）：`
            + `${audit.drift.slice(0, 5).join(', ')}${audit.drift.length > 5 ? ` …另有 ${audit.drift.length - 5} 条` : ''}`);
        console.warn('           确认这些改动确实只影响"还没跑过的新库"，或改用一条新的迁移把它们补上；'
            + '愿意接受现状就执行 `node scripts/migration_manager.js restack-checksums --apply` 以当前文件为重算基线');
    }
    for (const dup of audit.duplicated) {
        console.warn(`[Migration] 版本号 ${dup.version} 被 ${dup.files.join(' / ')} 同时占用：`
            + '按版本号定位（--to-version、rollback）时它不再唯一，新的迁移请取未用过的号');
    }
}

async function migrate(options = {}) {
    const { force = false, toVersion = null } = options;
    
    console.log('='.repeat(50));
    console.log('[Migration] 开始数据库迁移...');
    console.log('='.repeat(50));
    
    try {
        await sequelize.authenticate();
        console.log('[Migration] 数据库连接成功');
        
        await initMigrationTable();
        
        const executed = await getExecutedMigrations();
        const files = getMigrationFiles();

        // —— 先对账，再决定要不要跑 ——
        try {
            const executedRows = await sequelize.query(
                `SELECT migration_name, checksum FROM ${MIGRATIONS_TABLE}`,
                { type: QueryTypes.SELECT }
            );
            logMigrationAudit(auditMigrations(executedRows || [], files));
        } catch (error) {
            console.warn('[Migration] 迁移账本对账跳过：', error.message);
        }

        let pendingMigrations = [];
        for (const file of files) {
            const info = parseMigrationFilename(file);
            if (!info) continue;
            
            if (toVersion !== null && info.version > toVersion) {
                continue;
            }
            
            if (!executed.has(file) || force) {
                pendingMigrations.push({ file, info });
            }
        }

        /**
         * 待跑的迁移先逐个查形状。为什么必须在执行前查、还要单独把文件名念出来：
         * 形状不对时 runner 抛的是 `queryInterface.addColumn is not a function`，
         * migrate() 把它收成 success:false，index.js 直接 process.exit(1) ——
         * 服务器起不来，而报错里看不出是"哪一个文件、按哪条契约写的"。
         * 已跑过的历史文件不在此列（它们已经在库里落定，格式问题不再有影响）。
         */
        const shapeProblems = [];
        for (const { file } of pendingMigrations) {
            const full = path.join(MIGRATION_DIR, file);
            let mod = null;
            try {
                mod = require(full);
            } catch (error) {
                shapeProblems.push(`${file}: require 失败 —— ${error.message}`);
                continue;
            }
            shapeProblems.push(...checkMigrationShape(file, fs.readFileSync(full, 'utf8'), mod));
        }
        if (shapeProblems.length) {
            const message = `待执行的迁移不符合契约（${CONTRACT}）:\n  - ${shapeProblems.join('\n  - ')}`;
            console.error(`[Migration] ${message}`);
            return { success: false, error: message };
        }
        
        if (pendingMigrations.length === 0) {
            console.log('[Migration] 所有迁移已执行完成，无需迁移');
            return { success: true, executed: 0, migrated: 0 };
        }
        
        console.log(`[Migration] 待执行迁移数: ${pendingMigrations.length}`);
        
        for (const { file, info } of pendingMigrations) {
            await executeMigration(file);
        }
        
        console.log('='.repeat(50));
        console.log(`[Migration] ✓ 迁移完成！共执行 ${pendingMigrations.length} 个迁移`);
        console.log('='.repeat(50));
        
        // index.js 读的是 migrated（原来只回 executed，那句"✅ 数据库迁移完成"永远不打）
        return { success: true, executed: pendingMigrations.length, migrated: pendingMigrations.length };
    } catch (error) {
        console.error('[Migration] 迁移失败:', error);
        return { success: false, error: error.message };
    }
}

/**
 * 回滚到指定版本
 */
async function rollback(targetVersion) {
    console.log('='.repeat(50));
    console.log(`[Migration] 回滚到版本 ${targetVersion}...`);
    console.log('='.repeat(50));
    
    try {
        await sequelize.authenticate();
        
        const executed = await getExecutedMigrations();
        const files = getMigrationFiles();
        
        const toRollback = [];
        for (const file of files) {
            const info = parseMigrationFilename(file);
            if (!info) continue;
            
            if (info.version > targetVersion && executed.has(file)) {
                toRollback.push({ file, info });
            }
        }
        
        toRollback.sort((a, b) => b.info.version - a.info.version);
        
        for (const { file } of toRollback) {
            await rollbackMigration(file);
        }
        
        console.log('='.repeat(50));
        console.log(`[Migration] ✓ 回滚完成！共回滚 ${toRollback.length} 个迁移`);
        console.log('='.repeat(50));
        
        return { success: true, rolledBack: toRollback.length };
    } catch (error) {
        console.error('[Migration] 回滚失败:', error);
        return { success: false, error: error.message };
    }
}

/**
 * 显示迁移状态
 */
async function status() {
    try {
        await sequelize.authenticate();
        await initMigrationTable();
        
        const executed = await getExecutedMigrations();
        const files = getMigrationFiles();
        
        console.log('='.repeat(50));
        console.log('[Migration] 迁移状态');
        console.log('='.repeat(50));
        
        let pendingCount = 0;
        for (const file of files) {
            const info = parseMigrationFilename(file);
            if (!info) continue;
            
            const isExecuted = executed.has(file);
            const status = isExecuted ? '✓' : '⏳';
            const version = String(info.version).padStart(4, '0');
            
            console.log(`  ${status} [v${version}] ${file}`);
            
            if (!isExecuted) pendingCount++;
        }
        
        console.log('='.repeat(50));
        console.log(`总计: ${files.length} 个迁移, 已执行: ${executed.size}, 待执行: ${pendingCount}`);
        console.log('='.repeat(50));
        
        return { total: files.length, executed: executed.size, pending: pendingCount };
    } catch (error) {
        console.error('[Migration] 获取状态失败:', error);
    }
}

/**
 * 创建新的迁移文件（模板 = migrationTemplate，与 runner 的契约同一份）
 */
function createMigration(version, description) {
    const versionStr = String(version).padStart(4, '0');
    const filename = `migration_${versionStr}_${description}.js`;
    const filepath = path.join(MIGRATION_DIR, filename);
    if (fs.existsSync(filepath)) throw new Error(`迁移文件已存在：${filename}`);
    // 号已经被别人占过时先响：以前 createMigration 不看现有号码，两个 0050 就是这么来的
    const taken = getMigrationFiles()
        .map(f => parseMigrationFilename(f))
        .filter(info => info && info.version === Number(version));
    if (taken.length) {
        console.warn(`[Migration] 版本号 ${version} 已被 ${taken.map(t => t.filename).join(', ')} 占用，建议换一个号`);
    }
    fs.writeFileSync(filepath, migrationTemplate(version, description));
    console.log(`[Migration] 已创建迁移文件: ${filename}（签名 ${CONTRACT}）`);
    return filename;
}

/**
 * 以当前仓库里的文件内容重算校验和基线。
 * 只影响"下一次对账说什么"，不动任何表结构；默认 dry-run，必须 --apply 才写。
 * @param {boolean} apply
 */
async function restackChecksums(apply = false) {
    const rows = await sequelize.query(
        `SELECT migration_name, checksum FROM ${MIGRATIONS_TABLE}`, { type: QueryTypes.SELECT });
    const recorded = new Map(rows.map(r => [r.migration_name, r.checksum]));
    const changed = [];
    for (const file of getMigrationFiles()) {
        if (!recorded.has(file)) continue;
        const now = calculateChecksum(path.join(MIGRATION_DIR, file));
        if (recorded.get(file) !== now) changed.push({ file, now });
    }
    console.log(`[Migration] 校验和与当前文件不一致的记录 ${changed.length} 条${apply ? '，正在以当前文件为基线' : '（dry-run，加 --apply 才写）'}`);
    if (!apply) return { changed: changed.map(c => c.file), applied: false };
    for (const { file, now } of changed) {
        await sequelize.query(
            `UPDATE ${MIGRATIONS_TABLE} SET checksum = ? WHERE migration_name = ?`,
            { replacements: [now, file] }
        );
    }
    return { changed: changed.map(c => c.file), applied: true };
}

module.exports = {
    migrate,
    rollback,
    status,
    createMigration,
    initMigrationTable,
    MIGRATIONS_TABLE,
    // 契约与盘点（门禁直接吃这几个函数，不再自己抄一份判定）
    CONTRACT,
    parseMigrationFilename,
    checkMigrationShape,
    inspectMigrations,
    auditMigrations,
    migrationTemplate,
    restackChecksums
};

/**
 * 命令行入口：
 *   node scripts/migration_manager.js check                —— 不连库，只按契约盘点仓库里的迁移
 *   node scripts/migration_manager.js status               —— 连库看已跑/待跑
 *   node scripts/migration_manager.js restack-checksums [--apply]
 * 存在的理由：`check` 要能在不起服务、不碰数据库的情况下跑（jest 与 CI 都用它），
 * 而"形状不对"这种问题只有在有人新增文件时才值得立刻响。
 */
if (require.main === module) {
    const argv = process.argv.slice(2);
    const command = argv[0] || 'check';
    const apply = argv.includes('--apply');
    (async () => {
        if (command === 'check') {
            const { problems, duplicated, files } = inspectMigrations();
            console.log(`[Migration] 契约盘点（${CONTRACT}）：${files.length} 个文件，问题 ${problems.length} 条，重复版本号 ${duplicated.length} 组`);
            for (const p of problems) console.error(`  - ${p}`);
            await sequelize.close();
            process.exit(problems.length ? 1 : 0);
        }
        if (command === 'restack-checksums') {
            const r = await restackChecksums(apply);
            await sequelize.close();
            process.exit(r.changed.length ? 0 : 0);
        }
        if (command === 'status') {
            await status();
            await sequelize.close();
            process.exit(0);
        }
        console.error(`未知命令：${command}（可用：check / status / restack-checksums [--apply]）`);
        await sequelize.close();
        process.exit(2);
    })().catch(async (error) => {
        console.error('[Migration] 命令失败:', error.message);
        try { await sequelize.close(); } catch {}
        process.exit(1);
    });
}
