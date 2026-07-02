/**
 * AI 大模型服务
 *
 * 支持多种 AI API 提供商，用于生成游戏事件描述
 * 兼容所有支持 OpenAI 协议的模型（DeepSeek、Moonshot/Kimi、零一万物、通义千问、智谱 GLM-4 等）
 * 同时保留对 Anthropic Claude 专有协议的适配
 *
 * 协议判定逻辑：
 *   - openai/azure/qwen/zhipu/xiaomi 及其他未识别 provider -> 走 OpenAI 兼容协议
 *   - anthropic -> 走 Anthropic 专有协议
 *
 * 用户可通过 ai_config.json 的 providers[].compatibleWith 字段强制指定协议
 */
const axios = require('axios');

class AIService {
    /**
     * 构造函数
     * @param {Object} config - AI 配置
     */
    constructor(config = {}) {
        this.config = {
            provider: config.provider || 'openai',
            apiKey: config.apiKey || process.env.AI_API_KEY || '',
            baseUrl: config.baseUrl || process.env.AI_BASE_URL || 'https://api.openai.com/v1',
            model: config.model || 'gpt-3.5-turbo',
            temperature: config.temperature || 0.7,
            maxTokens: config.maxTokens || 1000,
            timeout: config.timeout || 30000,
            enableCache: config.enableCache !== false,
            cacheDuration: config.cacheDuration || 3600000,
            fallbackToTemplate: config.fallbackToTemplate !== false,
            // 通信协议：'openai'（默认，兼容所有 OpenAI 协议模型）或 'anthropic'
            protocol: config.protocol || this.inferProtocol(config.provider)
        };

        this.cache = new Map();
        this.requestQueue = [];
        this.isProcessing = false;
    }

    /**
     * 根据 provider 推断通信协议
     * 默认所有 provider 都走 OpenAI 兼容协议，仅 anthropic 走专有协议
     * @param {string} provider - 提供商标识
     * @returns {string} 协议类型：'openai' | 'anthropic'
     */
    inferProtocol(provider) {
        if (!provider) return 'openai';
        // 仅 Claude 走 Anthropic 专有协议，其他厂商均提供 OpenAI 兼容接口
        if (provider === 'anthropic') return 'anthropic';
        return 'openai';
    }

    /**
     * 初始化 AI 服务
     * @param {Object} configLoader - 配置加载器
     * @returns {AIService} AI 服务实例
     */
    static async initialize(configLoader) {
        let aiConfig = {
            provider: 'openai',
            apiKey: process.env.AI_API_KEY || '',
            baseUrl: process.env.AI_BASE_URL || 'https://api.openai.com/v1',
            model: process.env.AI_MODEL || 'gpt-3.5-turbo',
            temperature: parseFloat(process.env.AI_TEMPERATURE) || 0.7,
            maxTokens: parseInt(process.env.AI_MAX_TOKENS) || 1000,
            timeout: parseInt(process.env.AI_TIMEOUT) || 30000,
            enableCache: process.env.AI_ENABLE_CACHE !== 'false',
            cacheDuration: parseInt(process.env.AI_CACHE_DURATION) || 3600000,
            fallbackToTemplate: process.env.AI_FALLBACK_TO_TEMPLATE !== 'false'
        };

        if (configLoader) {
            try {
                const loadedConfig = configLoader.getConfig('ai_config');
                if (loadedConfig) {
                    if (!process.env.AI_API_KEY && loadedConfig.apiKey) {
                        aiConfig.apiKey = loadedConfig.apiKey;
                    }
                    if (!process.env.AI_BASE_URL && loadedConfig.baseUrl) {
                        aiConfig.baseUrl = loadedConfig.baseUrl;
                    }
                    if (!process.env.AI_MODEL && loadedConfig.model) {
                        aiConfig.model = loadedConfig.model;
                    }
                    if (!process.env.AI_TEMPERATURE && loadedConfig.temperature) {
                        aiConfig.temperature = loadedConfig.temperature;
                    }
                    if (!process.env.AI_MAX_TOKENS && loadedConfig.maxTokens) {
                        aiConfig.maxTokens = loadedConfig.maxTokens;
                    }
                    if (!process.env.AI_TIMEOUT && loadedConfig.timeout) {
                        aiConfig.timeout = loadedConfig.timeout;
                    }

                    const envProvider = process.env.AI_PROVIDER;
                    const providerFromConfig = envProvider || loadedConfig.provider || aiConfig.provider;
                    aiConfig.provider = providerFromConfig;

                    if (loadedConfig.providers && loadedConfig.providers[providerFromConfig]) {
                        const providerConfig = loadedConfig.providers[providerFromConfig];
                        // 优先使用 providers 节点中配置的 endpoint
                        if (!process.env.AI_BASE_URL && providerConfig.endpoint) {
                            aiConfig.baseUrl = providerConfig.endpoint;
                        }
                        // 读取 compatibleWith 字段，用于强制指定协议（如某些自定义 provider）
                        if (providerConfig.compatibleWith) {
                            aiConfig.protocol = providerConfig.compatibleWith;
                        }
                        console.log(`[AI Service] 已加载提供商 ${providerFromConfig} 的配置`);
                    }

                    // 推断通信协议（未显式指定时，根据 provider 自动判定）
                    if (!aiConfig.protocol) {
                        const tempService = new AIService(aiConfig);
                        aiConfig.protocol = tempService.config.protocol;
                    }

                    console.log('[AI Service] 配置加载完成（环境变量优先级最高）');
                }
            } catch (error) {
                console.warn('AI 配置加载失败，使用默认配置:', error.message);
            }
        }

        const service = new AIService(aiConfig);

        if (!aiConfig.apiKey) {
            console.warn('[AI Service] 未配置 API Key，将使用模板生成模式');
        } else {
            console.log(`[AI Service] 已初始化，提供商: ${aiConfig.provider}, 模型: ${aiConfig.model}, 协议: ${aiConfig.protocol}`);
        }

        return service;
    }

    /**
     * 生成缓存键
     * @param {string} prompt - 提示词
     * @param {Object} context - 上下文
     * @returns {string} 缓存键
     */
    generateCacheKey(prompt, context = {}) {
        const crypto = require('crypto');
        const content = JSON.stringify({ prompt, context, config: { model: this.config.model } });
        return crypto.createHash('md5').update(content).digest('hex');
    }

    /**
     * 获取缓存结果
     * @param {string} cacheKey - 缓存键
     * @returns {Object|null} 缓存结果
     */
    getFromCache(cacheKey) {
        if (!this.config.enableCache) return null;
        
        const cached = this.cache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < this.config.cacheDuration) {
            console.log(`[AI Service] 缓存命中: ${cacheKey.substring(0, 8)}...`);
            return cached.result;
        }
        return null;
    }

    /**
     * 保存到缓存
     * @param {string} cacheKey - 缓存键
     * @param {Object} result - 结果
     */
    saveToCache(cacheKey, result) {
        if (!this.config.enableCache) return;
        
        if (this.cache.size >= 1000) {
            const firstKey = this.cache.keys().next().value;
            this.cache.delete(firstKey);
        }
        
        this.cache.set(cacheKey, {
            result,
            timestamp: Date.now()
        });
    }

    /**
     * 调用 AI API
     * @param {string} prompt - 提示词
     * @param {Object} options - 选项
     * @returns {Object} AI 响应
     */
    async callAPI(prompt, options = {}) {
        const cacheKey = this.generateCacheKey(prompt, options.context || {});
        const cached = this.getFromCache(cacheKey);
        if (cached) return cached;

        if (!this.config.apiKey) {
            console.log('[AI Service] 无 API Key，跳过 AI 调用');
            return { content: null, fromCache: false, error: 'No API Key configured' };
        }

        const messages = this.buildMessages(prompt, options);
        const requestBody = this.buildRequestBody(messages, options);

        try {
            const response = await this.executeRequest(requestBody);
            const result = this.parseResponse(response);
            
            if (result.content) {
                this.saveToCache(cacheKey, result);
            }
            
            return { ...result, fromCache: false };
        } catch (error) {
            console.error('[AI Service] API 调用失败:', error.message);
            return { content: null, fromCache: false, error: error.message };
        }
    }

    /**
     * 构建消息
     * @param {string} prompt - 提示词
     * @param {Object} options - 选项
     * @returns {Array} 消息数组
     */
    buildMessages(prompt, options = {}) {
        const systemPrompt = options.systemPrompt || this.getSystemPrompt(options.context);
        
        const messages = [
            { role: 'system', content: systemPrompt }
        ];
        
        if (options.history && Array.isArray(options.history)) {
            messages.push(...options.history);
        }
        
        messages.push({ role: 'user', content: prompt });
        
        return messages;
    }

    /**
     * 获取系统提示词
     * @param {Object} context - 上下文
     * @returns {string} 系统提示词
     */
    getSystemPrompt(context = {}) {
        const realm = context.realm || '炼气期';
        const worldStyle = context.worldStyle || '凡人修仙传';
        
        return `你是游戏《${worldStyle}》的叙事系统，负责生成沉浸式的修仙世界事件描述。

当前玩家境界: ${realm}
背景设定: 天南地区，凡人国度

请用优雅古风但不晦涩的语言描述游戏事件，风格要求：
- 简洁有力，富有画面感
- 符合修仙世界观
- 有一定的文学美感
- 事件描述要自然流畅

直接输出事件描述，不要添加任何解释或格式标记。`;
    }

    /**
     * 构建请求体
     * 根据 protocol 字段决定走 OpenAI 兼容协议或 Anthropic 专有协议
     * @param {Array} messages - 消息数组
     * @param {Object} options - 选项
     * @returns {Object} 请求体
     */
    buildRequestBody(messages, options = {}) {
        const body = {
            messages,
            temperature: options.temperature || this.config.temperature,
            max_tokens: options.maxTokens || this.config.maxTokens
        };

        // 根据协议类型构建请求体
        if (this.config.protocol === 'anthropic') {
            // Anthropic 专有协议：max_tokens 是必填字段，messages 格式相同
            body.model = this.config.model;
            // Anthropic 的 max_tokens 字段名一致，无需特殊处理
        } else {
            // OpenAI 兼容协议（适用于 openai/azure/qwen/zhipu/xiaomi/deepseek/moonshot 等）
            body.model = this.config.model;
        }

        return body;
    }

    /**
     * 执行请求
     * @param {Object} requestBody - 请求体
     * @returns {Object} 响应
     */
    async executeRequest(requestBody) {
        const headers = this.getHeaders();
        const url = this.getEndpoint();
        
        console.log('[AI Service] 发起请求:', {
            url: url.substring(0, 50) + '...',
            model: this.config.model,
            provider: this.config.provider
        });
        
        const response = await axios.post(url, requestBody, {
            headers,
            timeout: Math.max(this.config.timeout, 60000)
        });
        
        return response;
    }

    /**
     * 获取请求头
     * 根据 protocol 字段决定请求头格式
     * @returns {Object} 请求头
     */
    getHeaders() {
        const headers = {
            'Content-Type': 'application/json'
        };

        if (this.config.protocol === 'anthropic') {
            // Anthropic 专有协议：使用 x-api-key 头
            headers['x-api-key'] = this.config.apiKey;
            headers['anthropic-version'] = '2023-06-01';
        } else {
            // OpenAI 兼容协议：统一使用 Bearer Token 认证
            headers['Authorization'] = `Bearer ${this.config.apiKey}`;
        }

        return headers;
    }

    /**
     * 获取 API 端点
     * 根据 protocol 字段决定端点路径
     * 注意：用户应在 ai_config.json 的 providers 节点配置完整的 baseUrl（含路径）
     * @returns {string} 端点 URL
     */
    getEndpoint() {
        const baseUrl = this.config.baseUrl.replace(/\/$/, '');

        if (this.config.protocol === 'anthropic') {
            // Anthropic 专有协议端点
            return `${baseUrl}/messages`;
        }

        // OpenAI 兼容协议端点
        // 用户在 ai_config.json 配置的 baseUrl 应已包含版本号路径（如 /v1）
        // 若配置的 baseUrl 已包含 /chat/completions，则直接使用，避免重复拼接
        if (baseUrl.endsWith('/chat/completions')) {
            return baseUrl;
        }
        return `${baseUrl}/chat/completions`;
    }

    /**
     * 解析响应
     * 根据 protocol 字段决定解析逻辑，添加 default 分支保证未识别 provider 也能正常解析
     * @param {Object} response - API 响应
     * @returns {Object} 解析结果 { content, usage, error }
     */
    parseResponse(response) {
        try {
            // 优先尝试 OpenAI 兼容协议响应格式（choices[0].message.content）
            // 这是绝大多数模型的标准格式，未识别的 provider 也走此分支
            if (response.data?.choices?.[0]?.message?.content) {
                return {
                    content: response.data.choices[0].message.content.trim(),
                    usage: response.data.usage
                };
            }

            // Anthropic 专有协议响应格式（content[0].text）
            if (this.config.protocol === 'anthropic' && response.data?.content?.[0]?.text) {
                return {
                    content: response.data.content[0].text.trim(),
                    usage: response.data.usage
                };
            }

            // 通义千问旧版专有协议响应格式（output.text）
            // 多数通义千问场景已兼容 OpenAI 格式，此处保留兼容旧版
            if (response.data?.output?.text) {
                return {
                    content: response.data.output.text.trim(),
                    usage: response.data.usage
                };
            }

            // 兜底：记录无法识别的响应结构，便于排查
            console.warn('[AI Service] 无法解析响应格式，响应结构:', JSON.stringify(response.data).substring(0, 200));
            return { content: null, error: '无法解析响应格式' };
        } catch (error) {
            return { content: null, error: error.message };
        }
    }

    /**
     * 生成历练事件描述
     * @param {Object} context - 事件上下文
     * @returns {Object} 事件描述结果
     */
    async generateAdventureEvent(context) {
        const {
            playerRealm = '炼气期',
            mapName = '未知区域',
            mapEnvironment = '山地',
            timeOfDay = '白昼',
            weather = '晴朗',
            playerLevel = 1,
            eventType = 'random',
            useTemplateFallback = this.config.fallbackToTemplate
        } = context;

        const prompt = this.buildAdventurePrompt(context);
        
        const result = await this.callAPI(prompt, {
            context,
            systemPrompt: this.getAdventureSystemPrompt(context)
        });

        if (result.content) {
            return {
                success: true,
                description: result.content,
                fromAI: true,
                cached: result.fromCache || false
            };
        }

        if (useTemplateFallback) {
            console.log('[AI Service] AI 调用失败，使用模板生成');
            return this.generateEventFromTemplate(context);
        }

        return {
            success: false,
            error: result.error || 'AI 生成失败',
            fromAI: false
        };
    }

    /**
     * 构建历练事件提示词
     * @param {Object} context - 上下文
     * @returns {string} 提示词
     */
    buildAdventurePrompt(context) {
        const {
            playerRealm,
            mapName,
            mapEnvironment,
            timeOfDay,
            weather,
            playerLevel,
            eventType
        } = context;

        return `生成一个在${mapName}（${mapEnvironment}环境，${timeOfDay}，${weather}）的历练事件。

玩家境界: ${playerRealm}
玩家等级: 约${playerLevel}级

事件类型: ${eventType === 'combat' ? '战斗遭遇' : 
          eventType === 'treasure' ? '发现宝物' : 
          eventType === 'encounter' ? '偶遇人物' : 
          eventType === 'discovery' ? '发现奇景' : '随机事件'}

请用100-200字描述这个事件，风格要符合《凡人修仙传》的叙事风格。事件应该:
1. 画面感强，场景描写生动
2. 符合当前环境设定
3. 与玩家境界相匹配
4. 有一定的情节张力

直接输出事件描述，不需要标题或格式。`;
    }

    /**
     * 获取历练系统提示词
     * @param {Object} context - 上下文
     * @returns {string} 系统提示词
     */
    getAdventureSystemPrompt(context = {}) {
        const realm = context.playerRealm || '炼气期';
        
        return `你是《凡人修仙传》风格的叙事系统，专注于生成沉浸式的历练事件。

你的任务是创作符合以下原则的事件描述：
1. 事件长度: 100-200字的中文描述
2. 语言风格: 古风但不晦涩，有画面感
3. 世界观: 符合修仙体系（炼气、筑基、金丹等）
4. 场景设定: 基于地图环境和天气
5. 文学性: 有一定的诗词意境

直接输出事件文本，不要有任何格式标记或解释。`;
    }

    /**
     * 从模板生成事件（降级方案）
     * @param {Object} context - 上下文
     * @returns {Object} 事件结果
     */
    generateEventFromTemplate(context) {
        const templates = this.getEventTemplates();
        const { eventType = 'random' } = context;
        
        let templatePool;
        switch (eventType) {
            case 'combat':
                templatePool = templates.combat;
                break;
            case 'treasure':
                templatePool = templates.treasure;
                break;
            case 'encounter':
                templatePool = templates.encounter;
                break;
            case 'discovery':
                templatePool = templates.discovery;
                break;
            default:
                templatePool = [...templates.combat, ...templates.peaceful];
        }
        
        const template = templatePool[Math.floor(Math.random() * templatePool.length)];
        
        let description = template;
        description = description.replace('{map}', context.mapName || '此地');
        description = description.replace('{environment}', context.mapEnvironment || '');
        description = description.replace('{time}', context.timeOfDay || '');
        
        return {
            success: true,
            description,
            fromAI: false,
            cached: false
        };
    }

    /**
     * 获取事件模板库
     * @returns {Object} 模板库
     */
    getEventTemplates() {
        return {
            peaceful: [
                '{map}中，{environment}，微风轻拂。你寻得一处僻静之地，静坐吐纳，吸纳天地灵气',
                '{time}的{map}显得格外宁静，你漫步其中，心中感悟颇多',
                '{map}的{environment}深处，你发现了一处灵气充盈的宝地'
            ],
            combat: [
                '{map}中忽然窜出一只凶兽，眼中闪着血红的光芒，似乎已将你锁定为目标',
                '{environment}中传来一阵骚动，一只体型硕大的妖兽出现在你的面前',
                '{map}的{time}，一道黑影从林中窜出，却是一只等级不低的妖兽'
            ],
            treasure: [
                '{map}的{environment}中，你意外发现了一处隐秘的洞穴，似乎内有乾坤',
                '拨开草丛，你发现了一株散发着淡淡荧光的灵草，正是炼制丹药的稀有材料',
                '{map}深处，你找到了前人遗留下的洞府遗迹，虽已破旧，但或许还有遗留'
            ],
            encounter: [
                '{map}中，你偶遇一位行色匆匆的散修，彼此点头示意后各自离去',
                '{environment}中传来阵阵钟声，原来是一处隐世门派的山门所在',
                '一位身着灰袍的老者从你身旁经过，眼神深邃，似是某位高人'
            ],
            discovery: [
                '{map}的{environment}中，你发现了一处天然的灵泉，泉水散发着诱人的灵气',
                '{time}的{map}被一层薄雾笼罩，你仿佛进入了另一方天地',
                '站在{map}的高处远眺，云海翻涌，气象万千，令你心境开阔'
            ]
        };
    }

    /**
     * 生成怪物描述和属性
     * @param {Object} context - 上下文
     * @returns {Object} 怪物数据
     */
    async generateMonster(context) {
        const {
            playerRealm = '炼气期',
            mapEnvironment = '山地',
            difficulty = 'normal'
        } = context;

        const prompt = this.buildMonsterPrompt(context);
        
        const result = await this.callAPI(prompt, {
            context,
            systemPrompt: this.getMonsterSystemPrompt(context),
            maxTokens: 500
        });

        if (result.content) {
            try {
                const monsterData = JSON.parse(result.content);
                return {
                    success: true,
                    monster: monsterData,
                    fromAI: true
                };
            } catch (parseError) {
                console.error('[AI Service] 怪物数据解析失败:', parseError.message);
            }
        }

        return this.generateMonsterFromTemplate(context);
    }

    /**
     * 构建怪物提示词
     * @param {Object} context - 上下文
     * @returns {string} 提示词
     */
    buildMonsterPrompt(context) {
        const { playerRealm, mapEnvironment, difficulty } = context;
        
        return `为玩家境界为${playerRealm}，在${mapEnvironment}环境中，生成一个${difficulty}难度的怪物。

请以JSON格式输出，包含以下字段:
- name: 怪物名称（符合修仙世界观）
- realm: 境界（与玩家境界匹配）
- description: 50字左右的描述
- hp: 生命值
- atk: 攻击力
- def: 防御力
- speed: 速度
- skills: 技能数组（可选）
- exp_reward: 击败后获得的修为

只输出JSON，不要其他内容。`;
    }

    /**
     * 获取怪物系统提示词
     * @param {Object} context - 上下文
     * @returns {string} 系统提示词
     */
    getMonsterSystemPrompt(context = {}) {
        return `你是《凡人修仙传》世界的怪物生成系统。生成符合修仙世界观的怪物数据。

要求:
1. 怪物名称要有修仙特色（妖兽、鬼物、妖精等）
2. 属性数值要平衡，与玩家境界匹配
3. 描述要有画面感
4. JSON格式输出

只输出JSON数据。`;
    }

    /**
     * 从模板生成怪物（降级方案）
     * @param {Object} context - 上下文
     * @returns {Object} 怪物数据
     */
    generateMonsterFromTemplate(context) {
        const { playerRealm = '炼气期', mapEnvironment = '山地' } = context;
        
        const monsterNames = {
            山地: ['黑风虎', '烈焰狼', '巨岩熊', '青鳞蛇'],
            森林: ['青风狼', '灵狐', '幻影鹿', '毒蜘蛛'],
            水域: ['碧水蛟', '玄龟', '银鱼怪', '水精灵'],
            平原: ['奔雷马', '赤焰牛', '黄土怪'],
            海洋: ['鲨鱼精', '螃蟹将', '海蛇妖', '水母精']
        };

        const envMonsters = monsterNames[mapEnvironment] || monsterNames['平原'];
        const name = envMonsters[Math.floor(Math.random() * envMonsters.length)];
        
        const realmLevels = {
            '凡人': { hp: 80, atk: 10, def: 5, exp: 10 },
            '炼气1层': { hp: 100, atk: 15, def: 8, exp: 20 },
            '炼气3层': { hp: 150, atk: 25, def: 12, exp: 40 },
            '炼气6层': { hp: 250, atk: 40, def: 20, exp: 80 },
            '筑基期': { hp: 500, atk: 80, def: 40, exp: 200 },
            '筑基中期': { hp: 800, atk: 120, def: 60, exp: 350 }
        };

        const baseStats = realmLevels[playerRealm] || realmLevels['炼气1层'];
        const variance = 0.9 + Math.random() * 0.2;

        return {
            success: true,
            monster: {
                name: name,
                realm: playerRealm,
                description: `一只在${mapEnvironment}中修行的${name}，眼中闪烁着幽幽光芒`,
                hp: Math.floor(baseStats.hp * variance),
                atk: Math.floor(baseStats.atk * variance),
                def: Math.floor(baseStats.def * variance),
                speed: Math.floor(baseStats.atk * 0.6 * variance),
                exp_reward: Math.floor(baseStats.exp * variance)
            },
            fromAI: false
        };
    }

    /**
     * 生成 NPC 对话
     * @param {Object} context - 上下文
     * @returns {Object} NPC 对话结果
     */
    async generateNPCDialogue(context) {
        const {
            npcName = '神秘修士',
            npcRole = '散修',
            playerRealm = '炼气期',
            conversationType = 'random'
        } = context;

        const prompt = `生成一段${npcName}（${npcRole}）与${playerRealm}境界修士的${conversationType}对话。

要求:
1. 语言符合修仙世界观
2. 对话自然流畅
3. 50-100字
4. 可以包含有用的信息或任务

直接输出对话内容。`;

        const result = await this.callAPI(prompt, {
            context,
            maxTokens: 500
        });

        if (result.content) {
            return { success: true, dialogue: result.content, fromAI: true };
        }

        return this.generateDialogueFromTemplate(context);
    }

    /**
     * 从模板生成对话（降级方案）
     * @param {Object} context - 上下文
     * @returns {Object} 对话结果
     */
    generateDialogueFromTemplate(context) {
        const dialogues = [
            '这位道友，可曾听闻附近有异宝出没？',
            '修仙之路漫漫，道友还需多加小心。',
            '前方路途艰险，道友若是独自一人，只怕凶多吉少。',
            '我观道友印堂发亮，想必近日必有机缘。'
        ];

        return {
            success: true,
            dialogue: dialogues[Math.floor(Math.random() * dialogues.length)],
            fromAI: false
        };
    }

    /**
     * 检查配置是否有效
     * @returns {Object} 配置状态
     */
    checkConfig() {
        const status = {
            provider: this.config.provider,
            model: this.config.model,
            protocol: this.config.protocol,
            hasApiKey: !!this.config.apiKey,
            cacheEnabled: this.config.enableCache,
            cacheSize: this.cache.size
        };

        if (!this.config.apiKey) {
            status.warning = '未配置 API Key，将使用模板生成模式';
        }

        return status;
    }

    /**
     * 清理缓存
     * @param {number} maxAge - 最大存活时间（毫秒）
     */
    clearCache(maxAge = 0) {
        const now = Date.now();
        let cleared = 0;

        for (const [key, value] of this.cache.entries()) {
            if (now - value.timestamp > maxAge) {
                this.cache.delete(key);
                cleared++;
            }
        }

        console.log(`[AI Service] 清理了 ${cleared} 条过期缓存`);
        return cleared;
    }
}

/**
 * 模块级 AI 服务实例引用
 * 用于支持从 GM 后台热重载配置时，替换全局实例
 */
let activeInstance = null;

/**
 * 设置当前活跃的 AI 服务实例
 * @param {AIService} instance - AI 服务实例
 */
AIService.setActiveInstance = function(instance) {
    activeInstance = instance;
};

/**
 * 获取当前活跃的 AI 服务实例
 * @returns {AIService|null} AI 服务实例
 */
AIService.getActiveInstance = function() {
    return activeInstance;
};

/**
 * 从数据库热重载 AI 配置
 * GM 后台激活新配置后调用，替换全局实例并通知 AdventureEventService
 *
 * 优先级：数据库启用配置 > 环境变量 > JSON 配置文件
 * @returns {Promise<AIService>} 新的 AI 服务实例
 */
AIService.reloadFromDatabase = async function() {
    try {
        // 延迟加载 AiConfig 模型，避免循环依赖
        const AiConfig = require('../../models/ai_config');
        const cryptoHelper = require('../../utils/cryptoHelper');

        // 查询当前启用的配置
        const dbConfig = await AiConfig.findOne({ where: { is_active: true } });

        let newConfig = null;

        if (dbConfig) {
            // 从数据库读取并解密 API Key
            let apiKey = '';
            if (dbConfig.encrypted_api_key) {
                try {
                    apiKey = cryptoHelper.decrypt(dbConfig.encrypted_api_key);
                } catch (e) {
                    console.warn('[AI Service] 数据库 API Key 解密失败，降级为无 Key:', e.message);
                }
            }

            newConfig = {
                provider: dbConfig.provider,
                apiKey,
                baseUrl: dbConfig.base_url,
                model: dbConfig.model,
                protocol: dbConfig.protocol,
                temperature: parseFloat(dbConfig.temperature),
                maxTokens: dbConfig.max_tokens,
                timeout: dbConfig.timeout,
                enableCache: true,
                fallbackToTemplate: true
            };
            console.log(`[AI Service] 从数据库加载配置: ${dbConfig.display_name} (${dbConfig.provider})`);
        } else {
            // 数据库无启用配置，使用原有初始化逻辑（环境变量 + JSON 配置文件）
            console.log('[AI Service] 数据库无启用配置，使用环境变量/JSON 配置');
            const { infrastructure } = require('../../modules');
            const configLoader = infrastructure.ConfigLoader;
            newConfig = null;  // null 表示使用 initialize 默认逻辑
        }

        // 创建新实例（若 dbConfig 为 null，则走 initialize 默认逻辑）
        let newInstance;
        if (newConfig) {
            newInstance = new AIService(newConfig);
            if (newConfig.apiKey) {
                console.log(`[AI Service] 已热重载，提供商: ${newConfig.provider}, 模型: ${newConfig.model}, 协议: ${newConfig.protocol}`);
            } else {
                console.warn('[AI Service] 已热重载，但未配置 API Key，将使用模板生成模式');
            }
        } else {
            // 降级为 initialize 默认逻辑
            const { infrastructure } = require('../../modules');
            newInstance = await AIService.initialize(infrastructure.ConfigLoader);
        }

        // 替换全局实例
        activeInstance = newInstance;

        // 通知 AdventureEventService 更新引用
        try {
            const AdventureEventService = require('./AdventureEventService');
            const advInstance = AdventureEventService.getActiveInstance?.();
            if (advInstance) {
                advInstance.aiService = newInstance;
                console.log('[AI Service] 已通知 AdventureEventService 更新 AI 服务引用');
            }
        } catch (e) {
            console.warn('[AI Service] 通知 AdventureEventService 失败:', e.message);
        }

        return newInstance;
    } catch (error) {
        console.error('[AI Service] 从数据库热重载失败:', error.message);
        // 失败时保留旧实例，不替换
        return activeInstance;
    }
};

module.exports = AIService;
