const sequelize = require('../config/database');

async function checkIndexes() {
  try {
    await sequelize.authenticate();
    console.log('DB Connected.');

    const [tables] = await sequelize.query("SHOW TABLES;");
    console.log('Tables:', tables.map(t => Object.values(t)[0]));

    for (const t of tables) {
        const tableName = Object.values(t)[0];
        console.log(`\nChecking indexes for table: ${tableName}`);
        try {
            const [indexes] = await sequelize.query(`SHOW INDEX FROM \`${tableName}\`;`);
            console.log(`Index count: ${indexes.length}`);
            indexes.forEach(idx => {
                console.log(`- ${idx.Key_name} (${idx.Column_name})`);
            });
        } catch (e) {
            console.error(`Error checking indexes for ${tableName}:`, e.message);
        }
    }

    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

checkIndexes();
