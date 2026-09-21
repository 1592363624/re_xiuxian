/**
 * 配置管理面的不变量（不连库、不起服务）
 *
 * 钉的是三件事：
 *   1. 匿名可读的配置集合里，绝不能出现"文件里带密钥类字段"的那份 ——
 *      `config/ai_config.json` 有 13 个 provider 槽位，后台保存 AI 配置时会把 apiKey 写进这个文件。
 *      这条不靠人记住：它每次都去扫 config 目录里的实际字段，所以"以后谁往公开配置里塞了密钥"会当场红。
 *   2. 后台可管理的配置集合来自目录扫描，新增一份配置文件不需要再回来改路由（这次就差点没改过来：
 *      路由里写死过 6 个名字，而目录里有 53 份）。
 *   3. 配置名要过形状校验，`../` 之类的构造不能拼进 path.join。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { ConfigLoader } = require('../modules/infrastructure/ConfigLoader');

const SERVER_ROOT = path.join(__dirname, '..');
const CONFIG_DIR = path.join(SERVER_ROOT, 'config');
const ROUTE_SOURCE = fs.readFileSync(
    path.join(SERVER_ROOT, 'routes', 'config.js'), 'utf-8'
).replace(/\r\n/g, '\n');

/** 从路由源码里取出匿名可读白名单（不 require 路由：它一加载就要读 game_balance 配置） */
function parsePublicConfigNames() {
    const m = ROUTE_SOURCE.match(/const PUBLIC_CONFIG_NAMES = \[([\s\S]*?)\]/);
    if (!m) throw new Error('routes/config.js 里找不到 PUBLIC_CONFIG_NAMES，这条门禁就失效了');
    const names = [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
    if (names.length === 0) throw new Error('PUBLIC_CONFIG_NAMES 是空数组，门禁等于没扫');
    return names;
}

/** 递归收集对象里所有键名，用来判断"这份配置将来会不会带密钥" */
function collectKeys(node, out = new Set()) {
    if (Array.isArray(node)) {
        for (const item of node) collectKeys(item, out);
    } else if (node && typeof node === 'object') {
        for (const [key, value] of Object.entries(node)) {
            out.add(key);
            collectKeys(value, out);
        }
    }
    return out;
}

const SECRETISH_KEY = /^(api_?key|secret|.*_secret|password|.*_password|access_?token|refresh_?token|client_?secret)$/i;

describe('配置管理面的安全与可扩张不变量', () => {
    const loader = new ConfigLoader();
    const discovered = loader.discoverConfigNames();
    const publicNames = parsePublicConfigNames();

    test('目录扫描能发现全部配置（含本次新加的 stat_definitions / combat_formulas）', () => {
        expect(discovered.length).toBeGreaterThanOrEqual(50);
        expect(discovered).toContain('stat_definitions');
        expect(discovered).toContain('combat_formulas');
        // 只扫目录本身：backup/ 之类子目录里的 json 不该混进来
        expect(discovered.every(n => !n.includes('/') && !n.includes('\\'))).toBe(true);
    });

    test('带密钥类字段的配置绝不进匿名白名单', () => {
        const secretHolders = [];
        for (const name of discovered) {
            const keys = collectKeys(JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, `${name}.json`), 'utf-8')));
            if ([...keys].some(k => SECRETISH_KEY.test(k))) secretHolders.push(name);
        }
        // 先确认这个判据不是空转：ai_config 必须被抓到（它有 13 个 provider 的 apiKey 槽位）
        expect(secretHolders).toContain('ai_config');
        const leaked = secretHolders.filter(n => publicNames.includes(n));
        expect(leaked).toEqual([]);
    });

    test('内部数值配置（game_balance 等）也不在匿名白名单里', () => {
        // game_balance 里有调度间隔、战斗系数这类不该发给未登录请求者的数值；
        // 它由专用后台界面直接 hotUpdateConfig，读取走 /api/config/full/:configName（带鉴权）
        expect(publicNames).not.toContain('game_balance');
        expect(publicNames).not.toContain('ai_config');
        expect(publicNames).not.toContain('system');
    });

    test('路由里只剩一份写死的配置名清单（其余都走目录扫描）', () => {
        // 'ui_layout' / 'ui_routes' 只可能出现在 PUBLIC_CONFIG_NAMES 这一处
        // （'realm_breakthrough'、'role_init' 还被单个配置读取的端点各自引用一次，不能当签名）
        for (const signature of ['ui_layout', 'ui_routes']) {
            const occurrences = (ROUTE_SOURCE.match(new RegExp(`'${signature}'`, 'g')) || []).length;
            expect(occurrences).toBe(1);
        }
        expect(ROUTE_SOURCE).toMatch(/function manageableConfigNames\(\)[\s\S]{0,200}discoverConfigNames\(\)/);
        expect(ROUTE_SOURCE).toMatch(/router\.get\('\/full\/:configName',\s*auth,\s*adminCheck/);
    });

    test('配置名形状校验挡得住路径穿越，而且不碰文件系统', async () => {
        for (const bad of ['../../package', 'a/b', '..', 'game_balance.json', '', '带中文']) {
            expect(ConfigLoader.isSafeConfigName(bad)).toBe(false);
            await expect(loader.loadConfig(bad)).rejects.toThrow(/配置名称不合法/);
        }
        expect(ConfigLoader.isSafeConfigName('stat_definitions')).toBe(true);
        await expect(loader.loadConfig('stat_definitions')).resolves.toBeTruthy();
    });
});
