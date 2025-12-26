/**
 * 配置校验模块
 * 负责校验配置数据的格式和数值合法性
 */
class ConfigValidator {
    constructor() {
        this.validationRules = this.initValidationRules();
    }

    /**
     * 初始化校验规则
     */
    initValidationRules() {
        return {
            realm_breakthrough: {
                fields: {
                    realms: {
                        type: 'array',
                        required: true,
                        itemRules: {
                            id: { type: 'string', required: true },
                            name: { type: 'string', required: true },
                            rank: { type: 'number', required: true, min: 1 },
                            base_hp: { type: 'number', required: true, min: 0 },
                            base_mp: { type: 'number', required: true, min: 0 },
                            base_atk: { type: 'number', required: true, min: 0 },
                            base_def: { type: 'number', required: true, min: 0 },
                            exp_cap: { type: 'number', required: true, min: 0 },
                            lifespan_max: { type: 'number', required: true, min: 0 },
                            breakthrough_probability: { type: 'number', required: false, min: 0, max: 100 }
                        }
                    }
                }
            },
            role_init: {
                fields: {
                    spiritRootProbabilities: { type: 'object', required: true },
                    initialAttributes: { type: 'object', required: true },
                    initialAge: { type: 'number', required: true, min: 0, max: 100 },
                    initialLifespan: { type: 'number', required: true, min: 0 }
                }
            },
            item_data: {
                fields: {
                    items: {
                        type: 'array',
                        required: true,
                        itemRules: {
                            id: { type: 'string', required: true },
                            name: { type: 'string', required: true },
                            type: { type: 'string', required: true },
                            quality: { type: 'string', required: false },
                            effect: { type: 'object', required: false }
                        }
                    }
                }
            },
            map_data: {
                fields: {
                    maps: {
                        type: 'array',
                        required: true,
                        itemRules: {
                            id: { type: 'number', required: true },
                            name: { type: 'string', required: true },
                            type: { type: 'string', required: true },
                            environment: { type: 'string', required: false }
                        }
                    }
                }
            },
            ui_layout: {
                fields: {
                    layout: { type: 'object', required: true }
                }
            },
            ui_routes: {
                fields: {
                    routes: { type: 'array', required: true }
                }
            }
        };
    }

    /**
     * 校验配置数据
     * @param {string} configName - 配置名称
     * @param {any} configData - 配置数据
     * @returns {{ valid: boolean, errors: string[] }}
     */
    validate(configName, configData) {
        const rule = this.validationRules[configName];
        
        if (!rule) {
            return { valid: true, errors: [] };
        }

        const errors = [];
        this.validateObject(configData, rule.fields, '', errors);

        return {
            valid: errors.length === 0,
            errors
        };
    }

    /**
     * 校验对象数据
     */
    validateObject(data, fields, prefix, errors) {
        if (!data || typeof data !== 'object') {
            errors.push(`${prefix} 数据类型错误，应为对象`);
            return;
        }

        for (const [field, rule] of Object.entries(fields)) {
            const fieldPath = prefix ? `${prefix}.${field}` : field;
            
            if (rule.required && !(field in data)) {
                errors.push(`${fieldPath} 为必填字段`);
                continue;
            }

            if (data[field] === undefined || data[field] === null) {
                if (rule.required) {
                    errors.push(`${fieldPath} 不能为空`);
                }
                continue;
            }

            this.validateField(data[field], rule, fieldPath, errors);
        }
    }

    /**
     * 校验单个字段
     */
    validateField(value, rule, path, errors) {
        const type = typeof value;

        switch (rule.type) {
            case 'string':
                if (type !== 'string') {
                    errors.push(`${path} 类型错误，应为字符串`);
                } else if (rule.required && value.trim() === '') {
                    errors.push(`${path} 不能为空字符串`);
                }
                break;

            case 'number':
                if (type !== 'number' || isNaN(value)) {
                    errors.push(`${path} 类型错误，应为数字`);
                } else {
                    if (rule.min !== undefined && value < rule.min) {
                        errors.push(`${path} 值不能小于 ${rule.min}`);
                    }
                    if (rule.max !== undefined && value > rule.max) {
                        errors.push(`${path} 值不能大于 ${rule.max}`);
                    }
                }
                break;

            case 'boolean':
                if (type !== 'boolean') {
                    errors.push(`${path} 类型错误，应为布尔值`);
                }
                break;

            case 'array':
                if (!Array.isArray(value)) {
                    errors.push(`${path} 类型错误，应为数组`);
                } else if (rule.itemRules) {
                    value.forEach((item, index) => {
                        if (rule.itemRules.type && typeof rule.itemRules.type === 'string') {
                            const expectedType = rule.itemRules.type === 'array' ? 'object' : rule.itemRules.type;
                            if (typeof item !== expectedType) {
                                errors.push(`${path}[${index}] 类型错误，应为 ${expectedType}`);
                            }
                        }
                        if (typeof item === 'object' && !Array.isArray(item) && rule.itemRules.itemRules) {
                            this.validateObject(item, rule.itemRules.itemRules, `${path}[${index}]`, errors);
                        }
                    });
                }
                break;

            case 'object':
                if (type !== 'object' || Array.isArray(value)) {
                    errors.push(`${path} 类型错误，应为对象`);
                } else {
                    this.validateObject(value, rule, path, errors);
                }
                break;

            default:
                break;
        }
    }

    /**
     * 添加自定义校验规则
     * @param {string} configName - 配置名称
     * @param {object} rules - 校验规则
     */
    addRules(configName, rules) {
        this.validationRules[configName] = rules;
    }
}

module.exports = new ConfigValidator();
