/**
 * JSON 文本列的读取契约：空值给默认，损坏必须响。
 *
 * 为什么单独一道闸：models/ 里曾有 11 个 getter 写成 `catch { return [] }`，
 * 表现是"那一列读出来是空"，不报错、不 500；下一次带这列的写入把空落回库里，
 * 玩家数据就这么没了（objective 点名的静默数据丢失同一类）。
 * 其余 40 多个 JSON 列本来就没有 try/catch（坏了直接抛），这 11 列是例外，现已对齐。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { readJsonColumn } = require('../models/jsonColumn');

const SITES = [
    ['caveTreasureLog', 'rewards'],
    ['caveVisitor', 'encounter_reward'],
    ['dungeonProgress', 'nodes_completed'],
    ['dungeonProgress', 'items_collected'],
    ['dungeonRecord', 'items_gained'],
    ['playerFishCatch', 'bonus_items'],
    ['playerFishing', 'active_session'],
    ['playerSect', 'daily_quests_completed'],
    ['playerSect', 'quests_accepted'],
    ['playerSect', 'quests_accepted_at'],
    ['sectWarTerritory', 'defender_player_ids']
];

describe('readJsonColumn 本身', () => {
    test('空值走默认，不抛', () => {
        expect(readJsonColumn('M', 'f', null, [])).toEqual([]);
        expect(readJsonColumn('M', 'f', '', null)).toBeNull();
        expect(readJsonColumn('M', 'f', undefined, {})).toEqual({});
    });

    test('合法 JSON 原样解析；已是对象直接返回', () => {
        expect(readJsonColumn('M', 'f', '{"a":1}', {})).toEqual({ a: 1 });
        expect(readJsonColumn('M', 'f', [1, 2], [])).toEqual([1, 2]);
    });

    test('坏 JSON 抛错，错误里点名模型.字段', () => {
        expect(() => readJsonColumn('playerSect', 'quests_accepted', '{oops', []))
            .toThrow(/playerSect\.quests_accepted/);
    });
});

describe('每个 JSON 列 getter 都要遵守这个契约', () => {
    for (const [modelName, field] of SITES) {
        test(`${modelName}.${field}：损坏内容必须抛，不能读成空`, () => {
            const model = require(`../models/${modelName}`);
            const row = model.build();
            row.setDataValue(field, '{这不是JSON');
            expect(() => row[field]).toThrow(new RegExp(`${modelName}\\.${field}`));
        });

        test(`${modelName}.${field}：正常读写不受影响`, () => {
            const model = require(`../models/${modelName}`);
            const row = model.build();
            row.setDataValue(field, '["a","b"]');
            expect(row[field]).toEqual(['a', 'b']);
            row.setDataValue(field, null);
            expect(Array.isArray(row[field]) || row[field] === null || typeof row[field] === 'object').toBe(true);
        });
    }
});

describe('回归闸：models/ 里不许再出现"catch 之后返回默认值"的 JSON getter', () => {
    const modelsDir = path.join(__dirname, '..', 'models');
    const offenders = [];
    for (const file of fs.readdirSync(modelsDir).filter(f => f.endsWith('.js'))) {
        const text = fs.readFileSync(path.join(modelsDir, file), 'utf8').replace(/\r\n/g, '\n');
        // 单行式：try { return JSON.parse(x); } catch … { return 默认 }
        if (/try\s*\{\s*return JSON\.parse\([^)]*\);\s*\}\s*catch[^{]*\{\s*return (?:\[\]|\{\}|null|0)\s*;?\s*\}/.test(text)) {
            offenders.push(`${file}（单行 try/catch 吞掉 JSON.parse）`);
            continue;
        }
        // 多行式
        if (/try \{\s*\n\s*return \w+ \? JSON\.parse\(\w+\)[^\n]*\n\s*\} catch[^{]*\{\s*\n(?:\s*\/\/[^\n]*\n)?\s*return (?:\[\]|\{\}|null);/.test(text)) {
            offenders.push(`${file}（多行 try/catch 吞掉 JSON.parse）`);
        }
    }
    test('一处都没有', () => {
        expect(offenders).toEqual([]);
    });

    /**
     * 这条闸不能是空转：喂一份"已知有缺陷"的文本，必须被抓出来。
     * （否则以后有人改了写法，门禁会悄悄变成永远绿。）
     */
    test('检测器本身不是空转：能认出两种旧写法', () => {
        const oneLine = "get() { const raw = this.getDataValue('x'); if (!raw) return []; try { return JSON.parse(raw); } catch (e) { return []; } }";
        const multiLine = "get() {\n  const rawValue = this.getDataValue('x');\n  try {\n    return rawValue ? JSON.parse(rawValue) : [];\n  } catch (e) {\n    return [];\n  }\n}";
        const reOne = /try\s*\{\s*return JSON\.parse\([^)]*\);\s*\}\s*catch[^{]*\{\s*return (?:\[\]|\{\}|null|0)\s*;?\s*\}/;
        const reMulti = /try \{\s*\n\s*return \w+ \? JSON\.parse\(\w+\)[^\n]*\n\s*\} catch[^{]*\{\s*\n(?:\s*\/\/[^\n]*\n)?\s*return (?:\[\]|\{\}|null);/;
        expect(reOne.test(oneLine)).toBe(true);
        expect(reMulti.test(multiLine)).toBe(true);
    });
});
