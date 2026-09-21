/**
 * 模型时间戳读法契约测试（纯内存，不连库）。
 *
 * 要钉住的性质：不管一个模型把创建时间声明成 createdAt 还是 created_at，
 * 实例上两种拼法读到的必须是同一份值。
 * 为什么值得单独一个文件：读错拼法不抛错、只返回 undefined，
 * 现网因此出过"攻击冷却中，NaN 秒后可再次攻击"和前端拿到 `created_at: undefined` 两类问题；
 * 而 models 目录里三种声明方式并存（见 timestampCompat.js 头部），
 * 让每个调用方先查一眼"这张表当年是哪种写法"是不成立的约定。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { DataTypes } = require('sequelize');

const sequelize = require('../config/database');
const { installModelTimestampCompat, TIMESTAMP_SPELLINGS } = require('../models/timestampCompat');

const MODELS_DIR = path.join(__dirname, '../models');

function loadAllModels() {
    const models = [];
    for (const file of fs.readdirSync(MODELS_DIR)
        .filter(f => f.endsWith('.js') && f !== 'timestampCompat.js')) {
        const required = require(path.join(MODELS_DIR, file));
        const model = required && required.rawAttributes ? required : (required && required.default);
        if (model && model.rawAttributes && model.name) models.push(model);
    }
    return models;
}

const models = loadAllModels();

/** 这一对拼法在该模型里声明了什么：'both' / 'camel' / 'snake' / null */
function declaredSpelling(model, camel, snake) {
    const hasCamel = !!model.rawAttributes[camel];
    const hasSnake = !!model.rawAttributes[snake];
    if (hasCamel && hasSnake) return 'both';
    if (hasCamel) return 'camel';
    if (hasSnake) return 'snake';
    return null;
}

const columnOf = (model, key) => {
    const attribute = model.rawAttributes[key];
    return attribute ? (attribute.field || key) : null;
};

describe('模型时间戳读法契约', () => {
    test('模型都是从 config/database 的实例定义的（兼容层才可能包住它们）', () => {
        expect(models.length).toBeGreaterThan(100);
        expect(models.filter(m => m.sequelize !== sequelize).map(m => m.name)).toEqual([]);
    });

    test('只声明了一种拼法的表：另一种拼法读得到同一个值，写也落回同一份', () => {
        const checked = [];
        const broken = [];
        for (const model of models) {
            for (const [camel, snake] of TIMESTAMP_SPELLINGS) {
                if (declaredSpelling(model, camel, snake) === 'both') continue;
                if (!declaredSpelling(model, camel, snake)) continue;
                checked.push(`${model.name}.${camel}`);
                const stamp = new Date('2026-01-02T03:04:05.000Z');

                const row = model.build();
                row[camel] = stamp;
                if (row[snake] !== stamp || row[camel] !== stamp) {
                    broken.push(`${model.name}: 写 ${camel} 之后 ${snake}=${String(row[snake])}`);
                }
                row[snake] = null;
                if (row[camel] !== null) {
                    broken.push(`${model.name}: 通过 ${snake} 写入 null 没有落到 ${camel}`);
                }

                // 反向：从数据库口径（真实属性）读，别名也必须是同一份
                const stamped = model.build({ [camel]: stamp, [snake]: stamp });
                if (stamped[camel] !== stamped[snake]) {
                    broken.push(`${model.name}: build 后 ${camel}/${snake} 不一致`);
                }
            }
        }
        expect(broken).toEqual([]);
        // 现网两种声明都真的存在，别哪天退化成"只检查了一种"
        expect(new Set(checked.map(c => c.split('.')[1]))).toEqual(new Set(['createdAt', 'updatedAt']));
    });

    test('已知债：这几张表把时间声明成了两列，别再往里加', () => {
        // 现状（用 information_schema 实测过）：两列都有值，但显式声明的 created_at/updated_at
        // 是"插入即冻结"的那一列，自动维护的 createdAt/updatedAt 才是活的。
        // 于是读错一列不会报错，只会拿到一个看起来合理、其实不再更新的时间。
        // 根治要把两列并成一列（需要 owner 授权改表），先把名单钉在这里：
        // 新模型进名单就说明又多了一张双列表，必须改成像 PlayerTechnique 那样
        // 用 timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } 声明一次。
        const DUAL_TIMESTAMP_TABLES = [
            'Item', 'PlayerCave', 'PlayerCombat', 'PlayerGarden', 'PlayerGathering', 'PlayerMapPosition'
        ];
        const diverging = [];
        for (const model of models) {
            for (const [camel, snake] of TIMESTAMP_SPELLINGS) {
                if (declaredSpelling(model, camel, snake) !== 'both') continue;
                if (columnOf(model, camel) !== columnOf(model, snake)) diverging.push(model.name);
            }
        }
        expect([...new Set(diverging)].sort()).toEqual([...DUAL_TIMESTAMP_TABLES].sort());
    });

    test('兼容层不遮蔽模型自己声明的属性', () => {
        const shadowed = [];
        for (const model of models) {
            for (const [camel, snake] of TIMESTAMP_SPELLINGS) {
                for (const alias of [camel, snake]) {
                    if (!model.rawAttributes[alias]) continue;
                    const descriptor = Object.getOwnPropertyDescriptor(model.prototype, alias);
                    if (descriptor && descriptor.get && descriptor.get.__timestampSpellingAlias) {
                        shadowed.push(`${model.name}.${alias}`);
                    }
                }
            }
        }
        expect(shadowed).toEqual([]);
    });

    test('重复安装不产生第二层别名，读写仍然一致', () => {
        const model = sequelize.define('CompatIdempotentProbe', {
            label: { type: DataTypes.STRING }
        }, { tableName: 'compat_idempotent_probe', timestamps: true, underscored: true });

        const before = Object.getOwnPropertyDescriptor(model.prototype, 'created_at');
        expect(before).toBeTruthy();
        installModelTimestampCompat(model);
        // 每次都返回新的 descriptor 包装对象，比访问器本身才说明"没重装一层"
        expect(Object.getOwnPropertyDescriptor(model.prototype, 'created_at').get).toBe(before.get);

        const row = model.build();
        const stamp = new Date('2026-05-06T07:08:09.000Z');
        row.created_at = stamp;
        expect(row.createdAt).toBe(stamp);
        expect(row.get('createdAt')).toBe(stamp);
    });
});
