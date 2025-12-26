/**
 * 测试登录并获取玩家数据
 * 用于验证前端属性显示是否正确
 */
const http = require('http');

// 首先尝试登录获取token
const loginData = JSON.stringify({
  username: 'testuser1592363624',
  password: '123456' // 假设这是测试用户的密码
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

console.log('正在尝试登录...');

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
          console.log('API调用成功!');
          console.log('\n=== 完整的API响应数据 ===');
          console.log(JSON.stringify(response, null, 2));
          
          console.log('\n=== 关键属性检查 ===');
          console.log('寿命数据:', response.data.lifespan);
          console.log('修为数据:', {
            exp: response.data.exp,
            exp_next: response.data.exp_next
          });
          console.log('气血数据:', {
            hp_current: response.data.hp_current,
            hp_max: response.data.hp_max
          });
          console.log('灵力数据:', {
            mp_current: response.data.mp_current,
            mp_max: response.data.mp_max
          });
          
          // 检查前端模板需要的数据结构
          console.log('\n=== 前端模板数据访问检查 ===');
          console.log('player.lifespan?.current:', response.data.lifespan?.current);
          console.log('player.lifespan?.max:', response.data.lifespan?.max);
          console.log('player.exp:', response.data.exp);
          console.log('player.exp_next:', response.data.exp_next);
          
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