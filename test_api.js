/**
 * 测试API响应数据结构
 * 用于验证前端属性显示是否正确
 */
const http = require('http');

// 模拟API调用获取玩家数据
const options = {
  hostname: 'localhost',
  port: 3000,
  path: '/api/player/me',
  method: 'GET',
  headers: {
    'Authorization': 'Bearer testtoken'
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
      console.log('API响应数据:');
      console.log(JSON.stringify(response, null, 2));
      
      if (response.data) {
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
      }
    } catch (error) {
      console.log('原始响应:', data);
    }
  });
});

req.on('error', (error) => {
  console.error('API调用失败:', error.message);
});

req.end();