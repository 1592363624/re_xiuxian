const sequelize = require('../config/database');

async function checkTable() {
  try {
    await sequelize.authenticate();
    console.log('DB Connected.');
    
    // 查询 players 表的列信息
    const [results, metadata] = await sequelize.query("DESCRIBE players;");
    console.log('Players Table Columns:');
    results.forEach(col => {
        console.log(`- ${col.Field}: ${col.Type}`);
    });
    
    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

checkTable();
