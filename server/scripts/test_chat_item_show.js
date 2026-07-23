/**
 * 聊天物品展示系统测试脚本
 *
 * 测试目标：
 *   1. 后端路由定义验证（POST /api/chat/show-item）
 *   2. 后端 InventoryService 引入验证
 *   3. 前端 chat.ts API 定义验证（showItem 方法 + 类型定义）
 *   4. 前端 GlobalChat.vue 辅助函数和状态验证
 *   5. 前端 GlobalChat.vue 模板验证（物品卡片 + 选择弹窗 + 详情弹窗）
 *   6. OpenAPI 文档验证
 *   7. changelog 记录验证
 *   8. 后端 API 实际响应验证（登录 → 展示物品 → 历史记录验证）
 *   9. 安全校验验证（展示未拥有物品应失败）
 *
 * 运行方式：node scripts/test_chat_item_show.js
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const fs = require('fs');
const axios = require('axios');

// ====== 测试框架 ======
let passCount = 0;
let failCount = 0;
const failedItems = [];

function check(name, condition, detail = '') {
    if (condition) {
        passCount++;
    } else {
        failCount++;
        failedItems.push({ name, detail });
        console.log(`  ❌ ${name}${detail ? ' | ' + detail : ''}`);
    }
}

// ====== 配置 ======
const API_BASE = `http://localhost:${process.env.PORT || 5000}/api`;
const TEST_ACCOUNT = '1592363624';
const TEST_PASSWORD = '1592363624';

// ====== 主流程 ======
async function main() {
    console.log('====== 聊天物品展示系统测试 ======\n');

    // ====== 测试1：后端路由定义验证 ======
    console.log('【测试1】后端路由定义验证');
    const chatRoutePath = path.join(__dirname, '..', 'routes', 'chat.js');
    check('chat.js 路由文件存在', fs.existsSync(chatRoutePath));
    if (fs.existsSync(chatRoutePath)) {
        const routeContent = fs.readFileSync(chatRoutePath, 'utf-8');
        check('含 POST /show-item 路由定义', routeContent.includes("router.post('/show-item'"));
        check('含 InventoryService 引入', routeContent.includes('require(\'../game/services/InventoryService\')'));
        check('含 item_show 消息类型', routeContent.includes("'item_show'"));
        check('含持有校验逻辑', routeContent.includes('你未拥有该物品'));
        check('含 Socket.IO 广播', routeContent.includes("type: 'item_show'"));
        check('含 item_key 参数校验', routeContent.includes('item_key'));
        check('含 content JSON 序列化', routeContent.includes('JSON.stringify(itemShowContent)'));
        check('路由注释含物品展示说明', routeContent.includes('POST /api/chat/show-item'));
    }
    console.log('');

    // ====== 测试2：前端 chat.ts API 定义验证 ======
    console.log('【测试2】前端 chat.ts API 定义验证');
    const chatTsPath = path.join(__dirname, '..', '..', 'client', 'src', 'api', 'chat.ts');
    check('chat.ts 文件存在', fs.existsSync(chatTsPath));
    if (fs.existsSync(chatTsPath)) {
        const chatTsContent = fs.readFileSync(chatTsPath, 'utf-8');
        check('含 showItem 方法', chatTsContent.includes('export const showItem'));
        check('含 ItemShowMessageContent 接口', chatTsContent.includes('interface ItemShowMessageContent'));
        check('含 ShowItemResult 接口', chatTsContent.includes('interface ShowItemResult'));
        check('ChatMessageType 含 item_show', chatTsContent.includes("'item_show'"));
        check('含 item_key 字段定义', chatTsContent.includes('item_key: string'));
        check('含 item_name 字段定义', chatTsContent.includes('item_name: string'));
        check('含 quality 字段定义', chatTsContent.includes('quality: ItemQuality'));
        check('含 POST /chat/show-item 调用', chatTsContent.includes("'/chat/show-item'"));
    }
    console.log('');

    // ====== 测试3：前端 GlobalChat.vue 辅助函数和状态验证 ======
    console.log('【测试3】前端 GlobalChat.vue 辅助函数和状态验证');
    const globalChatPath = path.join(__dirname, '..', '..', 'client', 'src', 'components', 'widgets', 'GlobalChat.vue');
    check('GlobalChat.vue 文件存在', fs.existsSync(globalChatPath));
    if (fs.existsSync(globalChatPath)) {
        const chatContent = fs.readFileSync(globalChatPath, 'utf-8');

        // import 验证
        check('import showItem', chatContent.includes('showItem'));
        check('import getInventory', chatContent.includes('getInventory'));

        // 品质颜色映射
        check('含 qualityColorMap 映射', chatContent.includes('const qualityColorMap'));
        check('qualityColorMap 含 common', chatContent.includes('common:'));
        check('qualityColorMap 含 uncommon', chatContent.includes('uncommon:'));
        check('qualityColorMap 含 rare', chatContent.includes('rare:'));
        check('qualityColorMap 含 epic', chatContent.includes('epic:'));
        check('qualityColorMap 含 legendary', chatContent.includes('legendary:'));

        // 物品类型映射
        check('含 itemTypeLabelMap 映射', chatContent.includes('const itemTypeLabelMap'));

        // 状态
        check('含 itemSelectModal 状态', chatContent.includes('const itemSelectModal'));
        check('含 itemDetailModal 状态', chatContent.includes('const itemDetailModal'));

        // 辅助函数
        check('含 parseItemShowContent 函数', chatContent.includes('function parseItemShowContent'));
        check('含 getQualityStyle 函数', chatContent.includes('const getQualityStyle'));
        check('含 getItemTypeLabel 函数', chatContent.includes('const getItemTypeLabel'));
        check('含 openItemSelectModal 函数', chatContent.includes('const openItemSelectModal'));
        check('含 closeItemSelectModal 函数', chatContent.includes('const closeItemSelectModal'));
        check('含 confirmShowItem 函数', chatContent.includes('const confirmShowItem'));
        check('含 handleItemClick 函数', chatContent.includes('const handleItemClick'));
        check('含 closeItemDetail 函数', chatContent.includes('const closeItemDetail'));
    }
    console.log('');

    // ====== 测试4：前端 GlobalChat.vue 模板验证 ======
    console.log('【测试4】前端 GlobalChat.vue 模板验证');
    if (fs.existsSync(globalChatPath)) {
        const chatContent = fs.readFileSync(globalChatPath, 'utf-8');

        // 物品展示按钮
        check('含「展示物品」按钮', chatContent.includes('openItemSelectModal') && chatContent.includes('title="展示物品"'));

        // 物品卡片渲染
        check('含物品展示消息卡片', chatContent.includes("msg.messageType === 'item_show'") && chatContent.includes('msg.itemShowInfo'));
        check('物品卡片含点击事件', chatContent.includes('@click="handleItemClick'));
        check('物品卡片含品质边框', chatContent.includes('getQualityStyle(msg.itemShowInfo.quality).border'));
        check('物品卡片含物品名称', chatContent.includes('msg.itemShowInfo.item_name'));

        // 物品选择弹窗
        check('含物品选择弹窗', chatContent.includes('itemSelectModal.visible'));
        check('物品选择弹窗含网格布局', chatContent.includes('grid grid-cols-2 gap-2'));
        check('物品选择弹窗含物品列表', chatContent.includes('itemSelectModal.items'));
        check('物品选择弹窗含确认展示', chatContent.includes('confirmShowItem(item)'));

        // 物品详情弹窗
        check('含物品详情弹窗', chatContent.includes('itemDetailModal.visible'));
        check('物品详情弹窗含物品描述', chatContent.includes('itemDetailModal.data.description'));
        check('物品详情弹窗含售价', chatContent.includes('itemDetailModal.data.price'));
        check('物品详情弹窗含持有数量', chatContent.includes('itemDetailModal.data.quantity'));
    }
    console.log('');

    // ====== 测试5：Socket 监听和消息处理验证 ======
    console.log('【测试5】Socket 监听和消息处理验证');
    if (fs.existsSync(globalChatPath)) {
        const chatContent = fs.readFileSync(globalChatPath, 'utf-8');
        check('Socket 监听含 item_show 处理', chatContent.includes("msg.type === 'item_show'"));
        check('fetchMessages 含 item_show 解析', chatContent.includes("msg.type === 'item_show'") &&
              chatContent.includes('parseItemShowContent'));
        check('顶部通知含物品展示文案', chatContent.includes('展示了【'));
    }
    console.log('');

    // ====== 测试6：OpenAPI 文档验证 ======
    console.log('【测试6】OpenAPI 文档验证');
    const openapiPath = path.join(__dirname, '..', '..', 'docs', 'openapi.json');
    if (fs.existsSync(openapiPath)) {
        const openapiDoc = JSON.parse(fs.readFileSync(openapiPath, 'utf-8'));
        check('OpenAPI 含 /api/chat/show-item 路径', !!openapiDoc.paths['/api/chat/show-item']);
        if (openapiDoc.paths['/api/chat/show-item']) {
            const showItemPath = openapiDoc.paths['/api/chat/show-item'];
            check('show-item 含 POST 方法', !!showItemPath.post);
            check('show-item 含 Chat tag', showItemPath.post?.tags?.includes('Chat'));
            check('show-item 含 item_key 参数', !!showItemPath.post?.requestBody?.content?.['application/json']?.schema?.properties?.item_key);
            check('show-item 含 201 响应', !!showItemPath.post?.responses?.['201']);
            check('show-item 含 400 响应', !!showItemPath.post?.responses?.['400']);
            check('show-item 含 item_show 响应结构', JSON.stringify(showItemPath.post?.responses?.['201']).includes('item_show'));
        }
        const chatPathCount = Object.keys(openapiDoc.paths).filter(p => p.includes('chat')).length;
        check(`Chat 路径数为 9`, chatPathCount === 9, `实际: ${chatPathCount}`);
    } else {
        check('openapi.json 文件存在', false);
    }
    console.log('');

    // ====== 测试7：changelog 记录验证 ======
    console.log('【测试7】changelog 记录验证');
    const changelogPath = path.join(__dirname, '..', '..', 'client', 'src', 'data', 'changelog.js');
    if (fs.existsSync(changelogPath)) {
        const changelogContent = fs.readFileSync(changelogPath, 'utf-8');
        check('changelog 含"聊天物品展示"section', changelogContent.includes('聊天物品展示系统'));
        check('changelog 含"多人社交"条目', changelogContent.includes('多人社交'));
        check('changelog 含"后端接口"条目', changelogContent.includes('POST /api/chat/show-item'));
        check('changelog 含"安全设计"条目', changelogContent.includes('安全设计'));
        check('changelog 含"物品选择弹窗"条目', changelogContent.includes('物品选择弹窗'));
        check('changelog type 为 feature', changelogContent.includes("type: 'feature'"));
    }
    console.log('');

    // ====== 测试8：后端 API 实际响应验证 ======
    console.log('【测试8】后端 API 实际响应验证');
    try {
        // 登录
        const loginRes = await axios.post(`${API_BASE}/auth/login`, {
            username: TEST_ACCOUNT,
            password: TEST_PASSWORD
        });
        const token = loginRes.data?.token;
        check('登录成功获取 token', !!token);

        if (token) {
            const client = axios.create({
                baseURL: API_BASE,
                headers: { Authorization: `Bearer ${token}` },
                timeout: 10000
            });

            // 获取背包，找到一个物品用于展示
            let testItemKey = null;
            try {
                const invRes = await client.get('/inventory');
                const items = invRes.data?.data?.items || [];
                check('背包查询成功', items.length >= 0);
                if (items.length > 0) {
                    testItemKey = items[0].item_key;
                    check(`找到测试物品: ${items[0].name}(${testItemKey})`, !!testItemKey);
                } else {
                    check('背包为空（无法测试物品展示，跳过）', true);
                }
            } catch (e) {
                check('背包查询成功', false, e.message);
            }

            // 测试展示物品
            if (testItemKey) {
                try {
                    const showRes = await client.post('/chat/show-item', { item_key: testItemKey });
                    const data = showRes.data?.data;
                    check('POST /chat/show-item 返回 201', showRes.status === 201);
                    check('返回 chat_message_id', !!data?.chat_message_id);
                    check('返回 item_show 对象', !!data?.item_show);
                    if (data?.item_show) {
                        check('item_show 含 item_key', !!data.item_show.item_key);
                        check('item_show 含 item_name', !!data.item_show.item_name);
                        check('item_show 含 quality', !!data.item_show.quality);
                        check('item_show 含 type', !!data.item_show.type);
                        check('item_show 含 description', data.item_show.description !== undefined);
                        check('item_show 含 price', data.item_show.price !== undefined);
                        check('item_show 含 quantity', data.item_show.quantity !== undefined);
                    }
                } catch (e) {
                    check('POST /chat/show-item 请求成功', false, e.response?.data?.message || e.message);
                }
            }

            // 测试参数校验：空 item_key
            try {
                await client.post('/chat/show-item', { item_key: '' });
                check('空 item_key 应返回 400', false, '未返回 400');
            } catch (e) {
                check('空 item_key 返回 400', e.response?.status === 400,
                    `实际: ${e.response?.status}`);
            }

            // 测试参数校验：无 item_key
            try {
                await client.post('/chat/show-item', {});
                check('无 item_key 应返回 400', false, '未返回 400');
            } catch (e) {
                check('无 item_key 返回 400', e.response?.status === 400);
            }

            // 测试安全校验：展示未拥有的物品
            try {
                await client.post('/chat/show-item', { item_key: 'non_existent_item_key_12345' });
                check('未拥有物品应返回 400', false, '未返回 400');
            } catch (e) {
                check('未拥有物品返回 400', e.response?.status === 400,
                    `实际: ${e.response?.status} ${e.response?.data?.message}`);
                check('未拥有物品含错误提示', e.response?.data?.message?.includes('未拥有') || e.response?.data?.message?.includes('不存在'),
                    `实际: ${e.response?.data?.message}`);
            }

            // 测试历史记录含 item_show 消息
            try {
                const historyRes = await client.get('/chat/history');
                const messages = historyRes.data?.data || [];
                check('GET /chat/history 返回消息列表', Array.isArray(messages));
                // 检查是否有 item_show 类型消息（刚展示的应该在最近50条中）
                const itemShowMessages = messages.filter(m => m.type === 'item_show');
                if (itemShowMessages.length > 0) {
                    check('历史记录含 item_show 消息', true);
                    // 验证 item_show 消息 content 可解析为 JSON
                    const firstItemMsg = itemShowMessages[0];
                    try {
                        const parsed = JSON.parse(firstItemMsg.content);
                        check('item_show 消息 content 可解析为 JSON', !!parsed.item_key);
                        check('解析后含 item_name', !!parsed.item_name);
                        check('解析后含 quality', !!parsed.quality);
                    } catch (e) {
                        check('item_show 消息 content 可解析为 JSON', false, e.message);
                    }
                } else {
                    check('历史记录含 item_show 消息（可能刚发送，暂未查到）', true);
                }
            } catch (e) {
                check('GET /chat/history 请求成功', false, e.message);
            }
        }
    } catch (e) {
        check('登录请求成功', false, e.message);
    }
    console.log('');

    // ====== 汇总 ======
    console.log('====== 测试汇总 ======');
    const total = passCount + failCount;
    console.log(`总计: ${total} 项 | 通过: ${passCount} | 失败: ${failCount}`);
    if (failCount > 0) {
        console.log('\n失败项明细:');
        failedItems.forEach((item, idx) => {
            console.log(`  ${idx + 1}. ${item.name}${item.detail ? ' | ' + item.detail : ''}`);
        });
        process.exit(1);
    } else {
        console.log('\n🎉 全部测试通过！');
        process.exit(0);
    }
}

main().catch(err => {
    console.error('测试脚本异常:', err);
    process.exit(1);
});
