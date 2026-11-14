require('dotenv').config();
const app = require('./app');
const { sequelize } = require('./models');
const seedAdmin = require('./utils/seedAdmin');
const migrator = require('./db/migrator');
const migrateScans = require('./utils/migrateScans');
const { backfillLocationNames } = require('./utils/locationNames');
const { billingStatus, startStickerSweeps } = require('./services/stickerService');

const PORT = process.env.PORT || 5000;

const start = async () => {
  try {
    await sequelize.authenticate();
    console.log('Database connected.');

    // Versioned schema changes (backend/migrations) first, so the tables they own never come from sync().
    await migrator.up();

    await sequelize.sync(); // creates tables if they don't exist
    console.log('Tables synced.');

    await migrateScans();

    await seedAdmin();

    app.listen(PORT, () => {
      console.log(`OriginHash backend running on http://localhost:${PORT}`);
      console.log(billingStatus());
      startStickerSweeps(); // background: expire and refill monthly sticker packs on time
      backfillLocationNames(); // background; rate-limited lookups
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
};

start();
