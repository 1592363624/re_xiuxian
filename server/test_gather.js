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

async function testGatherAPI() {
    console.log('=== 测试采集系统 API ===\n');

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

            console.log('\n3. 获取资源列表...');
            const resourcesData = await httpRequest({
                ...baseOptions,
                headers: authHeaders,
                path: '/api/gather/resources',
                method: 'GET'
            });
            console.log('✓ 资源列表获取成功');
            console.log(`   地图ID: ${resourcesData.map_id}`);
            console.log(`   共 ${resourcesData.resources.length} 种资源:`);
            resourcesData.resources.forEach(r => {
                console.log(`   - ID: ${r.resource_id}, 名称: ${r.name}, 消耗: ${r.mp_cost} MP`);
            });

            console.log('\n4. 获取采集统计...');
            const stats = await httpRequest({
                ...baseOptions,
                headers: authHeaders,
                path: '/api/gather/stats',
                method: 'GET'
            });
            console.log('✓ 采集统计:', JSON.stringify(stats, null, 2));

            const firstResource = resourcesData.resources[0];
            const secondResource = resourcesData.resources[1];

            console.log(`\n5. 测试采集 [${firstResource.name}]...`);
            const gatherResult = await httpRequest({
                ...baseOptions,
                headers: authHeaders,
                path: '/api/gather/collect',
                method: 'POST'
            }, JSON.stringify({ resource_id: firstResource.resource_id }));
            console.log('✓ 采集结果:', JSON.stringify(gatherResult, null, 2));

            console.log(`\n6. 再次采集 [${firstResource.name}] (测试熟练度)...`);
            const gatherResult2 = await httpRequest({
                ...baseOptions,
                headers: authHeaders,
                path: '/api/gather/collect',
                method: 'POST'
            }, JSON.stringify({ resource_id: firstResource.resource_id }));
            console.log('✓ 采集结果:', JSON.stringify(gatherResult2, null, 2));

            console.log(`\n7. 测试采集 [${secondResource.name}]...`);
            const gatherResult3 = await httpRequest({
                ...baseOptions,
                headers: authHeaders,
                path: '/api/gather/collect',
                method: 'POST'
            }, JSON.stringify({ resource_id: secondResource.resource_id }));
            console.log('✓ 采集结果:', JSON.stringify(gatherResult3, null, 2));

            console.log('\n8. 获取更新后的采集统计...');
            const stats2 = await httpRequest({
                ...baseOptions,
                headers: authHeaders,
                path: '/api/gather/stats',
                method: 'GET'
            });
            console.log('✓ 采集统计:', JSON.stringify(stats2, null, 2));

            console.log('\n=== 采集系统测试完成 ===\n');

            return { token: loginResult.token, playerId: loginResult.player.id };
        } else {
            console.log('✗ 登录失败:', loginResult.message);
            return null;
        }
    } catch (error) {
        console.error('测试失败:', error.message);
        return null;
    }
}

testGatherAPI();
