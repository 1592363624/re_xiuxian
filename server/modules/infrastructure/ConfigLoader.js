/**
 * 配置加载模块
 * 负责加载、校验、缓存配置文件，支持热更新
 * 数据配置层的核心模块
 */
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

class ConfigLoader extends EventEmitter {
    constructor() {
        super();
        this.configPath = path.join(__dirname, '../../config');
        this.configCache = new Map();
        this.configValidator = null;
        this.isInitialized = false;
    }

    /**
     * 初始化配置加载器
     */
    async initialize() {
        try {
            this.configValidator = require('./ConfigValidator');
            await this.loadAllConfigs();
            this.isInitialized = true;
            console.log('配置加载模块初始化完成');
            return { success: true };
        } catch (error) {
            console.error('配置加载模块初始化失败:', error);
            throw error;
        }
    }

    /**
     * 批量加载所有配置文件
     *
     * 改为目录扫描：以前这里写死 43 个文件名，新增配置文件必须回来加一行，
     * 漏加的后果是 getConfig 抛"配置未加载"，而多数服务把它 catch 成空对象——
     * technique_data / achievement_data / lottery_data 就是这么静默变成"功能不可用"的。
     */
    discoverConfigNames() {
        if (!fs.existsSync(this.configPath)) return [];
        return fs.readdirSync(this.configPath)
            .filter(name => name.endsWith('.json'))
            .map(name => name.replace(/\.json$/, ''))
            .sort();
    }

    async loadAllConfigs() {
        const configFiles = this.discoverConfigNames();
        const results = {};

        for (const configName of configFiles) {
            try {
                const config = await this.loadConfig(configName);
                this.configCache.set(configName, config);
                results[configName] = { success: true, data: config };
            } catch (error) {
                console.error(`加载配置文件 ${configName} 失败:`, error);
                results[configName] = { success: false, error: error.message };
                const backupConfig = this.loadBackupConfig(configName);
                if (backupConfig) {
                    this.configCache.set(configName, backupConfig);
                    results[configName] = { success: true, data: backupConfig, useBackup: true };
                }
            }
        }

        this.emit('configsLoaded', results);
        return results;
    }

    /**
     * 配置名是否是一个"就是一个文件名（不含扩展名）"。
     * loadConfig 走 path.join(configPath, `${name}.json`)，名字来自后台请求，
     * 所以这一眼校验放在真正读文件之前 —— 白名单只能挡已知名字，规则挡的是 `../` 这类构造。
     * @param {string} configName
     * @returns {boolean}
     */
    static isSafeConfigName(configName) {
        return typeof configName === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(configName);
    }

    /**
     * 加载单个配置文件
     * @param {string} configName - 配置文件名称（不含扩展名）
     */
    async loadConfig(configName) {
        if (!ConfigLoader.isSafeConfigName(configName)) {
            throw new Error(`配置名称不合法: ${JSON.stringify(configName)}`);
        }
        const filePath = path.join(this.configPath, `${configName}.json`);
        
        if (!fs.existsSync(filePath)) {
            throw new Error(`配置文件不存在: ${filePath}`);
        }

        const fileContent = fs.readFileSync(filePath, 'utf-8');
        const configData = JSON.parse(fileContent);

        if (this.configValidator) {
            const validationResult = this.configValidator.validate(configName, configData);
            if (!validationResult.valid) {
                throw new Error(`配置文件 ${configName} 校验失败: ${validationResult.errors.join(', ')}`);
            }
        }

        return configData;
    }

    /**
     * 加载备份配置
     *
     * 修复：备份文件名由后台写入时带时间戳（<name>_<ISO时间>.json），
     * 旧实现只找 <name>.json，因此这条兜底路径永远命中不了、等于没有回滚。
     * 现在取时间戳最新的一份。
     */
    loadBackupConfig(configName) {
        const backupDir = path.join(this.configPath, 'backup');
        if (!fs.existsSync(backupDir)) return null;

        const plain = path.join(backupDir, `${configName}.json`);
        if (fs.existsSync(plain)) {
            try {
                return JSON.parse(fs.readFileSync(plain, 'utf-8'));
            } catch (error) {
                console.error(`加载备份配置 ${configName} 失败:`, error);
            }
        }

        const prefix = `${configName}_`;
        const candidates = fs.readdirSync(backupDir)
            .filter(name => name.startsWith(prefix) && name.endsWith('.json'))
            .sort(); // 时间戳格式字典序即时间序
        const latest = candidates[candidates.length - 1];
        if (!latest) return null;

        try {
            return JSON.parse(fs.readFileSync(path.join(backupDir, latest), 'utf-8'));
        } catch (error) {
            console.error(`加载备份配置 ${latest} 失败:`, error);
            return null;
        }
    }

    /**
     * 注入合并后的数据集（基础配置 + 资料片），由 ContentRegistry 在启动/热更时调用。
     * 这样现网所有 getConfig('item_data') 调用点无需改动即可看到资料片内容。
     */
    setMergedConfig(configName, data) {
        this.configCache.set(configName, data);
        this.emit('configMerged', { configName, timestamp: Date.now() });
    }

    /**
     * 获取配置数据
     * @param {string} configName - 配置名称
     * @param {string} [key] - 配置键名，可选
     */
    getConfig(configName, key = null) {
        const config = this.configCache.get(configName);
        if (!config) {
            throw new Error(`配置 ${configName} 未加载`);
        }

        if (key === null) {
            return config;
        }

        return config[key];
    }

    /**
     * 读配置，但"还没加载"时返回 null 而不是抛错。
     *
     * 给"配置缺了整个玩法就不可用"的服务用。这些服务本来就要判 null，而 getConfig 是抛错的，
     * 于是调用点只能自己包 try/catch —— 有人为了少包一次就把结果存进模块变量，
     * 那一存就再也拿不到热更新后的新值（慕兰战线、洞府遗府、神念对决都是这个形状）。
     * 这里给一个"每次读、读不到就 null"的入口，缓存就没有存在理由了：
     * getConfig 本身只是 Map.get，不解析文件。
     * @param {string} configName
     * @param {string} [key] 只要配置里的某一段（如 peekConfig('cave_legacy_data','cave_legacy')）
     * @returns {*} 配置（或某一段），没加载/没有这一段时返回 null
     */
    peekConfig(configName, key = null) {
        let config = null;
        try {
            config = this.getConfig(configName);
        } catch {
            return null;
        }
        if (config === null || config === undefined) return null;
        return key === null ? config : (config[key] ?? null);
    }

    /**
     * 热更新配置
     * @param {string} configName - 配置名称
     */
    async hotUpdateConfig(configName) {
        let newConfig;
        try {
            newConfig = await this.loadConfig(configName);
        } catch (error) {
            console.error(`热更新配置 ${configName} 失败:`, error);
            throw error;
        }

        const oldConfig = this.configCache.get(configName);
        this.configCache.set(configName, newConfig);

        try {
            this.emit('configHotUpdated', {
                configName,
                oldConfig,
                newConfig,
                timestamp: Date.now()
            });
        } catch (error) {
            // 监听者（内容层）会在校验不过时抛错。此时必须把缓存退回上一份在用的视图：
            // 上面刚写进去的是"裸基础配置"，留着它就等于运行中的进程突然看不到资料片内容，
            // 一次失败的后台编辑会变成线上道具/属性凭空消失，而不是一个报错。
            if (oldConfig !== undefined) this.configCache.set(configName, oldConfig);
            else this.configCache.delete(configName);
            console.error(`热更新配置 ${configName} 被下游校验拒绝，已退回上一份配置:`, error.message);
            throw error;
        }

        return { success: true, configName };
    }

    /**
     * 重新加载所有配置
     */
    async reloadAllConfigs() {
        this.configCache.clear();
        return await this.loadAllConfigs();
    }

    /**
     * 检查配置是否存在
     */
    hasConfig(configName) {
        return this.configCache.has(configName);
    }

    /**
     * 获取所有已加载的配置名称
     */
    getLoadedConfigNames() {
        return Array.from(this.configCache.keys());
    }
}

module.exports = new ConfigLoader();
// 运行期一律用上面的单例；测试里需要独立实例（临时配置目录、不同 configPath）所以再导出类
module.exports.ConfigLoader = ConfigLoader;
