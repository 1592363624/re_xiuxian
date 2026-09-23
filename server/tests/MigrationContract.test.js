/**
 * 迁移脚本的契约门禁（不连库）
 *
 * 起因：`migration_manager` 传给迁移的第一个参数是 **sequelize 实例**，而它自己的
 * `createMigration` 模板写的是 Sequelize 官方签名 `up(queryInterface, Sequelize)`。
 * 照着模板写的迁移会在启动时抛 `queryInterface.addColumn is not a function`，
 * 被 migrate() 收成 success:false，index.js 直接 process.exit(1) —— 服务器起不来，
 * 而报错里看不出"哪个文件、按哪条契约写的"。现网 89 个文件里有两种形状在跑
 * （49 个用 runner 传的参数、2 个自己 require sequelize + getQueryInterface），
 * 只要模板还教第三种，就还会再长。这里做的是：**把契约写死一处，模板与门禁都从它生成**。
 *
 * 三条各管一段：
 *   1. 现有 89 个文件全部合格（含"历史遗留"白名单只能收窄不能放宽）；
 *   2. 模板产出的文件本身要合格（模板与契约同源的证明）；
 *   3. 五种坏形状都必须被抓到（防空跑），其中"引用 queryInterface 却没自己取"就是当初那个坑。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const MANAGER = '../scripts/migration_manager';
const manager = require(MANAGER);
const { CONTRACT, checkMigrationShape, inspectMigrations, migrationTemplate, parseMigrationFilename } = manager;

const managerSrc = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'migration_manager.js'), 'utf8');
const indexSrc = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

describe('迁移脚本契约（runner 传的是 sequelize 实例，不是 queryInterface）', () => {
    test('现网 89 个迁移全部合格；0050 那组重复号被冻结成"只有这两个"', () => {
        const { files, problems, duplicated } = inspectMigrations();
        expect(problems).toEqual([]);
        expect(files.length).toBeGreaterThanOrEqual(89);
        // 库里两个 0050 都已落定，改名会造出"库里记着、仓库里没有"的孤儿记录，所以只冻结不新增：
        // 白名单写死在这里，出现第三个同号文件时 duplicated 立刻非空 → 这条红。
        expect(duplicated).toEqual([]);
        const fifties = files.filter(f => (parseMigrationFilename(f) || {}).version === 50).sort();
        expect(fifties).toEqual([
            'migration_0050_kunwu_choice_fields.js', 'migration_0050_spirit_beast_soul.js'
        ]);
    });

    test('模板产出的文件自己就要合格，而且不再教官方那个签名', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiuxian-mig-'));
        const file = path.join(dir, 'migration_9999_probe_tpl.js');
        try {
            const text = migrationTemplate(9999, 'probe_tpl');
            fs.writeFileSync(file, text, 'utf8');
            const mod = require(file);
            expect(checkMigrationShape('migration_9999_probe_tpl.js', text, mod)).toEqual([]);
            expect(typeof mod.up).toBe('function');
            // 关键：模板的签名必须与 runner 实际传的东西一致
            expect(text).toContain('up(sequelize, QueryTypes)');
            expect(text).not.toMatch(/up\(queryInterface,\s*Sequelize\)/);
            expect(text).not.toMatch(/down\(queryInterface,\s*Sequelize\)/);
        } finally {
            delete require.cache[file];
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('runner 确实按契约传参（文档与代码不许各说一段）', () => {
        expect(managerSrc).toMatch(/migration\.up\(sequelize,\s*QueryTypes\)/);
        expect(managerSrc).toContain(CONTRACT);
        // index.js 打印"迁移完成"读的是 migrated；只回 executed 时那句永远不打
        expect(managerSrc).toMatch(/migrated:\s*pendingMigrations\.length/);
        expect(indexSrc).toMatch(/migrationResult\.migrated/);
    });

    test('五种坏形状都要被抓到（含当初那个照模板写的 queryInterface）', () => {
        const upFn = async () => {};
        const cases = [
            {
                name: '官方签名 + 用 queryInterface',
                file: 'migration_9001_official_shape.js',
                mod: { up: upFn },
                src: `module.exports = { async up(queryInterface, Sequelize) { await queryInterface.addColumn('players', 'x', Sequelize.INTEGER); } };`,
                expect: /引用了 queryInterface\.\* 但没有 sequelize\.getQueryInterface/
            },
            {
                name: '根本没导出 up',
                file: 'migration_9002_no_up.js',
                mod: { description: 'x' },
                src: `module.exports = { description: 'x', run() {} };`,
                expect: /没有导出 up 函数/
            },
            {
                name: 'down 给了半个',
                file: 'migration_9003_half_down.js',
                mod: { up: upFn, down: null },
                src: `module.exports = { async up() {}, down: null };`,
                expect: /down 必须是函数/
            },
            {
                name: 'require 时 process.chdir（非白名单）',
                file: 'migration_9004_chdir.js',
                mod: { up: upFn },
                src: `process.chdir(require('path').resolve(__dirname, '..', '..'));\nmodule.exports = { async up() {} };`,
                expect: /process\.chdir/
            },
            {
                name: '文件名不带版本号',
                file: 'migration_add_stuff.js',
                mod: { up: upFn },
                src: `module.exports = { async up() {} };`,
                expect: /文件名必须是/
            }
        ];
        for (const c of cases) {
            const problems = checkMigrationShape(c.file, c.src, c.mod).join('\n');
            expect(`${c.name}: ${problems}`).toMatch(c.expect);
        }
        // 正例：自己取 queryInterface 的写法（现网 0039/0053 就是这个形状）必须放行
        expect(checkMigrationShape('migration_9010_ok.js',
            `const sequelize = require('../../config/database');
             const qi = sequelize.getQueryInterface();
             module.exports = { async up() { await qi.addColumn('players', 'x', {}); } };`,
            { up: upFn }).filter(p => /queryInterface/.test(p))).toEqual([]);
        expect(parseMigrationFilename('migration_9010_ok.js')).toEqual({ version: 9010, name: 'ok', filename: 'migration_9010_ok.js' });
    });

    test('对账函数认得出"库里记着、仓库已经不是那样"的两种情形', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiuxian-mig-audit-'));
        const crypto = require('crypto');
        const sum = p => crypto.createHash('sha256').update(fs.readFileSync(p, 'utf8')).digest('hex');
        try {
            const file = path.join(dir, 'migration_9500_probe.js');
            fs.writeFileSync(file, `module.exports = { async up(sequelize) { await sequelize.query('SELECT 1'); } };`, 'utf8');
            const name = path.basename(file);

            // 孤儿：库里记着一个仓库里没有的文件名
            const orphans = manager.auditMigrations([
                { migration_name: name, checksum: sum(file) },
                { migration_name: 'migration_0000_gone.js', checksum: 'x' }
            ], [name], dir);
            expect(orphans.orphans).toEqual(['migration_0000_gone.js']);
            expect(orphans.drift).toEqual([]);

            // 漂移：记录之后文件又被改过（改动不会在已跑过的库上重放）
            fs.appendFileSync(file, '\n// 事后又改了一行\n', 'utf8');
            const drift = manager.auditMigrations([{ migration_name: name, checksum: 'stale' }], [name], dir);
            expect(drift.drift).toEqual([name]);
            expect(drift.orphans).toEqual([]);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
