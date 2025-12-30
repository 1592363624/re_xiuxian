const http = require('http');

function httpRequest(options, postData = null) {
    return new Promise((resolve, reject) => {
        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    resolve(data);
                }
            });
        });
        req.on('error', reject);
        if (postData) req.write(postData);
        req.end();
    });
}

async function testCombatAPI() {
    console.log('=== 测试战斗系统 API ===\n');

    const baseOptions = {
        hostname: 'localhost',
        port: 3000,
        headers: { 'Content-Type': 'application/json' }
    };

    const USERNAME = '1592363624';
    const PASSWORD = '1592363624';

    try {
        console.log(`1. 使用测试账号 ${USERNAME} 登录...`);
        const loginResult = await httpRequest({
            ...baseOptions,
            path: '/api/auth/login',
            method: 'POST'
        }, JSON.stringify({ username: USERNAME, password: PASSWORD }));

        if (loginResult.token) {
            console.log(`✓ 登录成功，Player ID: ${loginResult.player.id}`);

            const authHeaders = {
                ...baseOptions.headers,
                'Authorization': `Bearer ${loginResult.token}`
            };

            console.log('\n2. 获取当前地图信息...');
            const mapInfo = await httpRequest({
                ...baseOptions,
                headers: authHeaders,
                path: '/api/map/info',
                method: 'GET'
            });
            console.log(`   当前地图: ${mapInfo.current_map.name}`);
            console.log(`   地图上的怪物:`);
            if (mapInfo.current_map.monsters) {
                mapInfo.current_map.monsters.forEach(m => {
                    console.log(`   - ID: ${m.id}, 名称: ${m.name}, 境界: ${m.realm}, 经验: ${m.exp}`);
                });
            }

            console.log('\n3. 查看战斗状态...');
            const statusResult = await httpRequest({
                ...baseOptions,
                headers: authHeaders,
                path: '/api/combat/status',
                method: 'GET'
            });
            console.log('✓ 战斗状态:', JSON.stringify(statusResult, null, 2));

            if (statusResult.in_battle) {
                console.log('\n   存在未完成的战斗，先尝试逃跑...');
                let escaped = false;
                for (let i = 0; i < 5 && !escaped; i++) {
                    const fleeResult = await httpRequest({
                        ...baseOptions,
                        headers: authHeaders,
                        path: '/api/combat/flee',
                        method: 'POST'
                    });
                    console.log(`   逃跑尝试 ${i + 1}:`, fleeResult.message);
                    if (fleeResult.success) {
                        escaped = true;
                        console.log('   ✓ 成功逃跑！');
                    }
                }
                if (!escaped) {
                    console.log('   多次逃跑失败，结束测试');
                    return;
                }
            }

            console.log('\n4. 查看战斗历史（初始为空）...');
            const historyResult = await httpRequest({
                ...baseOptions,
                headers: authHeaders,
                path: '/api/combat/history',
                method: 'GET'
            });
            console.log('✓ 战斗历史:', JSON.stringify(historyResult, null, 2));

            console.log('\n5. 主动遭遇怪物 [rabbit]...');
            const encounterResult = await httpRequest({
                ...baseOptions,
                headers: authHeaders,
                path: '/api/combat/encounter',
                method: 'POST'
            }, JSON.stringify({ monster_id: 'rabbit' }));
            console.log('✓ 遭遇结果:', JSON.stringify(encounterResult, null, 2));

            if (encounterResult.in_battle) {
                console.log('\n6. 玩家攻击怪物...');
                const attackResult = await httpRequest({
                    ...baseOptions,
                    headers: authHeaders,
                    path: '/api/combat/attack',
                    method: 'POST'
                }, JSON.stringify({ action: 'attack' }));
                console.log('✓ 攻击结果:', JSON.stringify(attackResult, null, 2));

                if (attackResult.battle_ended) {
                    console.log('\n   战斗已结束！');
                    console.log('   战斗结果:', attackResult.result);
                    console.log('   获得经验:', attackResult.exp_gained);
                    console.log('   获得物品:', attackResult.items_gained);
                } else if (attackResult.turn === 'monster') {
                    console.log('\n7. 怪物回合...');
                    const monsterTurnResult = await httpRequest({
                        ...baseOptions,
                        headers: authHeaders,
                        path: '/api/combat/monster-turn',
                        method: 'POST'
                    });
                    console.log('✓ 怪物行动结果:', JSON.stringify(monsterTurnResult, null, 2));

                    if (!monsterTurnResult.battle_ended) {
                        console.log('\n8. 再次攻击怪物...');
                        const attackResult2 = await httpRequest({
                            ...baseOptions,
                            headers: authHeaders,
                            path: '/api/combat/attack',
                            method: 'POST'
                        }, JSON.stringify({ action: 'attack' }));
                        console.log('✓ 攻击结果:', JSON.stringify(attackResult2, null, 2));

                        if (attackResult2.battle_ended) {
                            console.log('\n   战斗结束！');
                            console.log('   战斗结果:', attackResult2.result);
                            console.log('   获得经验:', attackResult2.exp_gained);
                            console.log('   获得物品:', attackResult2.items_gained);
                        } else {
                            console.log('\n9. 逃跑...');
                            const fleeResult = await httpRequest({
                                ...baseOptions,
                                headers: authHeaders,
                                path: '/api/combat/flee',
                                method: 'POST'
                            });
                            console.log('✓ 逃跑结果:', JSON.stringify(fleeResult, null, 2));
                        }
                    }
                }
            } else {
                console.log('   未遭遇怪物:', encounterResult.message);
            }

            console.log('\n10. 查看战斗历史...');
            const historyResult2 = await httpRequest({
                ...baseOptions,
                headers: authHeaders,
                path: '/api/combat/history',
                method: 'GET'
            });
            console.log('✓ 战斗历史:', JSON.stringify(historyResult2, null, 2));

            console.log('\n=== 战斗系统测试完成 ===\n');
        } else {
            console.log('✗ 登录失败:', loginResult.message);
        }
    } catch (error) {
        console.error('测试失败:', error.message);
    }
}

testCombatAPI();
