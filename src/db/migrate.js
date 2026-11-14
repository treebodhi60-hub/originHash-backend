require('dotenv').config();
const sequelize = require('../config/db');
const migrator = require('./migrator');

// CLI: node src/db/migrate.js [up|down|status]
const run = async () => {
  const command = process.argv[2] || 'up';
  await sequelize.authenticate();
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  if (command === 'status') {
    const rows = await migrator.status();
    if (!rows.length) console.log('No migrations found.');
    rows.forEach((r) => console.log(`${r.applied ? '[applied]' : '[pending]'}  ${r.name}`));
  } else if (command === 'down') {
    await migrator.down();
  } else if (command === 'up') {
    const ran = await migrator.up();
    if (!ran.length) console.log('Database is up to date.');
  } else {
    throw new Error(`Unknown command "${command}". Use up, down or status.`);
  }
};

run()
  .then(() => sequelize.close())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
