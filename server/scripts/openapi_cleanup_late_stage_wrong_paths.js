/**
 * OpenAPI 文档清理脚本：移除后期系统错误的接口定义
 *
 * 作用：从 docs/openapi.json 中移除 batch3-b3-2 后期系统首次补丁中误加的 7 个错误路径：
 *   - /api/second-soul/summon（实际是 /condense）
 *   - /api/second-soul/adjust-attribute（后端未实现）
 *   - /api/second-soul/separate（实际是 /divide）
 *   - /api/second-soul/recall（后端未实现）
 *   - /api/second-soul/extract-fragment（后端未实现）
 *   - /api/second-soul/fragments（getProfile 已返回汇总）
 *   - /api/law/fragments（getProfile 已返回汇总）
 *
 * 运行方式：node server/scripts/openapi_cleanup_late_stage_wrong_paths.js
 * 幂等性：可重复执行，不存在的路径会被跳过
 *
 * 注意：执行此脚本后，需重新运行 openapi_patch_late_stage.js 添加正确的路径定义
 */
'use strict';

const fs = require('fs');
const path = require('path');

// 目标文件路径
const OPENAPI_PATH = path.resolve(__dirname, '../../docs/openapi.json');

// 需要移除的错误路径列表
const WRONG_PATHS = [
    '/api/second-soul/summon',
    '/api/second-soul/adjust-attribute',
    '/api/second-soul/separate',
    '/api/second-soul/recall',
    '/api/second-soul/extract-fragment',
    '/api/second-soul/fragments',
    '/api/law/fragments'
];

// 主流程
function main() {
    // 读取 openapi.json
    const raw = fs.readFileSync(OPENAPI_PATH, 'utf8');
    const spec = JSON.parse(raw);

    const beforeCount = Object.keys(spec.paths || {}).length;
    let removedCount = 0;

    // 逐个移除错误路径
    for (const wrongPath of WRONG_PATHS) {
        if (spec.paths && spec.paths[wrongPath]) {
            delete spec.paths[wrongPath];
            removedCount++;
            console.log(`- 已移除: ${wrongPath}`);
        } else {
            console.log(`- 跳过（不存在）: ${wrongPath}`);
        }
    }

    // 写回文件（4 空格缩进，与既有风格一致）
    fs.writeFileSync(OPENAPI_PATH, JSON.stringify(spec, null, 4), 'utf8');

    const afterCount = Object.keys(spec.paths || {}).length;
    console.log(`\n清理完成：`);
    console.log(`- 移除路径: ${removedCount} 个`);
    console.log(`- paths 总数: ${beforeCount} → ${afterCount}`);
}

main();
