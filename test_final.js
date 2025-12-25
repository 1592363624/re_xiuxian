/**
 * 最终测试：验证前端属性显示修正
 */
const http = require('http');

// 生成随机测试账号和昵称
const testUsername = 'test' + Math.floor(Math.random() * 10000);
const testPassword = '123456';
const testNickname = '测试玩家' + Math.floor(Math.random() * 1000);

// 首先注册账号
const registerData = JSON.stringify({
  username: testUsername,
  password: testPassword,
  nickname: testNickname
});

const registerOptions = {
  hostname: 'localhost',
  port: 3000,
  path: '/api/auth/register',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(registerData)
  }
};

console.log('正在注册测试账号...');
console.log('账号:', testUsername);
console.log('密码:', testPassword);
console.log('昵称:', testNickname);

const registerReq = http.request(registerOptions, (registerRes) => {
  let registerResponse = '';
  
  registerRes.on('data', (chunk) => {
    registerResponse += chunk;
  });
  
  registerRes.on('end', () => {
    try {
      const response = JSON.parse(registerResponse);
      console.log('注册响应状态:', registerRes.statusCode);
      
      if (registerRes.statusCode === 201) {
        console.log('注册成功!');
        // 注册成功后登录
        login(testUsername, testPassword);
      } else {
        console.log('注册失败:', response.message || '未知错误');
        console.log('响应数据:', response);
      }
    } catch (error) {
      console.log('注册响应解析失败:', error.message);
      console.log('原始响应:', registerResponse);
    }
  });
});

registerReq.on('error', (error) => {
  console.error('注册请求失败:', error.message);
});

registerReq.write(registerData);
registerReq.end();

function login(username, password) {
  console.log('\n正在尝试登录...');
  
  const loginData = JSON.stringify({
    username: username,
    password: password
  });

  const loginOptions = {
    hostname: 'localhost',
    port: 3000,
    path: '/api/auth/login',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(loginData)
    }
  };

  const loginReq = http.request(loginOptions, (loginRes) => {
    let loginData = '';
    
    loginRes.on('data', (chunk) => {
      loginData += chunk;
    });
    
    loginRes.on('end', () => {
      try {
        const response = JSON.parse(loginData);
        console.log('登录响应状态:', loginRes.statusCode);
        
        if (loginRes.statusCode === 200 && response.token) {
          console.log('登录成功，获取到token');
          
          // 使用获取的token测试玩家信息API
          testPlayerAPI(response.token);
        } else {
          console.log('登录失败:', response.message || '未知错误');
          console.log('响应数据:', response);
        }
      } catch (error) {
        console.log('登录响应解析失败:', error.message);
        console.log('原始响应:', loginData);
      }
    });
  });

  loginReq.on('error', (error) => {
    console.error('登录请求失败:', error.message);
  });

  loginReq.write(loginData);
  loginReq.end();
}

function testPlayerAPI(token) {
  console.log('\n正在测试玩家信息API...');
  
  const options = {
    hostname: 'localhost',
    port: 3000,
    path: '/api/player/me',
    method: 'GET',
    headers: {
      'Authorization': 'Bearer ' + token
    }
  };

  const req = http.request(options, (res) => {
    let data = '';
    
    res.on('data', (chunk) => {
      data += chunk;
    });
    
    res.on('end', () => {
      try {
        const response = JSON.parse(data);
        console.log('API响应状态:', res.statusCode);
        
        if (res.statusCode === 200 && response.data) {
          console.log('✅ API调用成功!');
          
          console.log('\n=== 关键属性检查 ===');
          console.log('寿命数据:', response.data.lifespan);
          console.log('修为数据:', {
            exp: response.data.exp,
            exp_next: response.data.exp_next
          });
          
          // 检查前端模板需要的数据结构
          console.log('\n=== 前端模板数据访问检查 ===');
          console.log('player.lifespan?.current:', response.data.lifespan?.current);
          console.log('player.lifespan?.max:', response.data.lifespan?.max);
          console.log('player.exp:', response.data.exp);
          console.log('player.exp_next:', response.data.exp_next);
          
          // 检查前端显示是否正确
          console.log('\n=== 前端显示预期 ===');
          console.log('寿命显示:', response.data.lifespan?.current + ' / ' + response.data.lifespan?.max);
          console.log('修为显示:', response.data.exp + ' / ' + response.data.exp_next);
          
          // 验证修正结果
          console.log('\n=== 修正结果验证 ===');
          if (response.data.lifespan?.current !== undefined && response.data.lifespan?.max !== undefined) {
            console.log('✅ 寿命数据显示修正成功');
          } else {
            console.log('❌ 寿命数据显示仍有问题');
          }
          
          if (response.data.exp_next !== undefined) {
            console.log('✅ 修为最大值显示修正成功');
          } else {
            console.log('❌ 修为最大值显示仍有问题');
          }
          
        } else {
          console.log('API调用失败:', response.message || '未知错误');
        }
      } catch (error) {
        console.log('API响应解析失败:', error.message);
        console.log('原始响应:', data);
      }
    });
  });

  req.on('error', (error) => {
    console.error('API调用失败:', error.message);
  });

  req.end();
}