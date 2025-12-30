const http = require('http');

function httpRequest(options, postData = null) {
    return new Promise((resolve, reject) => {
        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                console.log('Raw response:', data);
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
            console.log('✓ 地图信息:', JSON.stringify(mapInfo, null, 2));

            console.log('\n3. 获取资源列表...');
            const resourcesData = await httpRequest({
                ...baseOptions,
                headers: authHeaders,
                path: '/api/gather/resources',
                method: 'GET'
            });
            console.log('✓ 资源列表:', JSON.stringify(resourcesData, null, 2));
        }
    } catch (error) {
        console.error('测试失败:', error.message);
    }
}

testGatherAPI();
