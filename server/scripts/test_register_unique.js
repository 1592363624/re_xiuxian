const axios = require('axios');

const API_URL = 'http://localhost:3000/api/auth';

const randomString = (length = 8) => Math.random().toString(36).substring(2, 2 + length);

async function runTests() {
    console.log('=== 开始唯一性约束测试 ===\n');

    const baseUsername = `user_${randomString()}`;
    const baseNickname = `道友_${randomString()}`;
    const password = 'password123';

    // 1. 正常注册
    console.log('1. 测试正常注册...');
    try {
        const res = await axios.post(`${API_URL}/register`, {
            username: baseUsername,
            password: password,
            nickname: baseNickname
        });
        console.log('✅ 注册成功:', res.data.message);
    } catch (error) {
        console.error('❌ 注册失败:', error.response?.data || error.message);
        process.exit(1);
    }

    // 2. 测试账号重复
    console.log('\n2. 测试账号重复 (不同道号)...');
    try {
        await axios.post(`${API_URL}/register`, {
            username: baseUsername, // 重复账号
            password: password,
            nickname: `道友_${randomString()}` // 新道号
        });
        console.error('❌ 预期失败但成功了');
    } catch (error) {
        if (error.response?.status === 400 && error.response?.data?.message.includes('账号已被注册')) {
            console.log('✅ 成功拦截重复账号:', error.response.data.message);
        } else {
            console.error('❌ 未知错误:', error.response?.data || error.message);
        }
    }

    // 3. 测试道号重复
    console.log('\n3. 测试道号重复 (不同账号)...');
    try {
        await axios.post(`${API_URL}/register`, {
            username: `user_${randomString()}`, // 新账号
            password: password,
            nickname: baseNickname // 重复道号
        });
        console.error('❌ 预期失败但成功了');
    } catch (error) {
        if (error.response?.status === 400 && error.response?.data?.message.includes('道号已被使用')) {
            console.log('✅ 成功拦截重复道号:', error.response.data.message);
        } else {
            console.error('❌ 未知错误:', error.response?.data || error.message);
        }
    }

    // 4. 并发注册测试
    console.log('\n4. 测试并发注册 (5个请求同时竞争)...');
    const concurrentUsername = `race_${randomString()}`;
    const concurrentNickname = `race_nick_${randomString()}`;
    
    const promises = [];
    for (let i = 0; i < 5; i++) {
        promises.push(
            axios.post(`${API_URL}/register`, {
                username: concurrentUsername,
                password: password,
                nickname: concurrentNickname
            }).then(res => ({ status: 'fulfilled', data: res.data }))
              .catch(err => ({ status: 'rejected', reason: err.response?.data || err.message }))
        );
    }

    const results = await Promise.all(promises);
    const successes = results.filter(r => r.status === 'fulfilled');
    const failures = results.filter(r => r.status === 'rejected');

    console.log(`并发结果: 成功 ${successes.length} 个, 失败 ${failures.length} 个`);
    
    if (successes.length === 1 && failures.length === 4) {
        console.log('✅ 并发控制成功，数据一致性保持良好');
    } else {
        console.error('❌ 并发控制失败，可能存在脏数据');
    }

    // 5. 测试前端检查 API
    console.log('\n5. 测试前端检查 API...');
    try {
        const checkUser = await axios.get(`${API_URL}/check-unique?type=username&value=${baseUsername}`);
        if (checkUser.data.available === false) {
            console.log('✅ 检查账号API返回正确 (不可用)');
        } else {
            console.error('❌ 检查账号API返回错误');
        }

        const checkNick = await axios.get(`${API_URL}/check-unique?type=nickname&value=${baseNickname}`);
        if (checkNick.data.available === false) {
            console.log('✅ 检查道号API返回正确 (不可用)');
        } else {
            console.error('❌ 检查道号API返回错误');
        }

        const checkNew = await axios.get(`${API_URL}/check-unique?type=username&value=new_${randomString()}`);
        if (checkNew.data.available === true) {
            console.log('✅ 检查新账号API返回正确 (可用)');
        } else {
            console.error('❌ 检查新账号API返回错误');
        }

    } catch (error) {
        console.error('❌ API测试失败:', error.message);
    }

    console.log('\n=== 测试结束 ===');
}

runTests();
