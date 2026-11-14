const fs = require('fs');
const path = require('path');
const { Sequelize, QueryTypes } = require('sequelize');
const sequelize = require('../config/db');

// A small migration runner. Every file in backend/migrations exports `up` and `down`, each given
// { queryInterface, Sequelize, sequelize, transaction }. Files run in name order (they start with a
// timestamp) and each one that runs is recorded in `oh_migrations`, so it never runs twice.
//
//   npm run migrate          apply every pending migration
//   npm run migrate:status   list applied and pending migrations
//   npm run migrate:down     undo the most recent migration
//
// The server also applies pending migrations on start, before sequelize.sync(), so the tables
// these migrations create always come from here and never from sync().

const DIR = path.join(__dirname, '..', '..', 'migrations');
const TABLE = 'oh_migrations';

const ensureTable = () =>
  sequelize.query(
    `CREATE TABLE IF NOT EXISTS \`${TABLE}\` (
       \`name\` VARCHAR(255) NOT NULL PRIMARY KEY,
       \`run_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );

const allFiles = () =>
  fs.existsSync(DIR)
    ? fs
        .readdirSync(DIR)
        .filter((f) => f.endsWith('.js'))
        .sort()
    : [];

const appliedNames = async () => {
  await ensureTable();
  const rows = await sequelize.query(`SELECT name FROM \`${TABLE}\` ORDER BY name`, { type: QueryTypes.SELECT });
  return rows.map((r) => r.name);
};

const status = async () => {
  const applied = new Set(await appliedNames());
  return allFiles().map((name) => ({ name, applied: applied.has(name) }));
};

const context = () => ({ queryInterface: sequelize.getQueryInterface(), Sequelize, sequelize });

// MySQL commits DDL on its own, so a failed migration can leave part of its work behind; each
// migration's `up` is therefore written to be safe to re-run (it skips tables that already exist).
const up = async ({ log = console.log } = {}) => {
  const applied = new Set(await appliedNames());
  const pending = allFiles().filter((f) => !applied.has(f));
  for (const name of pending) {
    const migration = require(path.join(DIR, name));
    log(`Migrating: ${name}`);
    await migration.up(context());
    await sequelize.query(`INSERT INTO \`${TABLE}\` (name) VALUES (?)`, { replacements: [name] });
  }
  if (pending.length) log(`Applied ${pending.length} migration(s).`);
  return pending;
};

const down = async ({ log = console.log } = {}) => {
  const applied = await appliedNames();
  const last = applied[applied.length - 1];
  if (!last) {
    log('Nothing to undo.');
    return null;
  }
  const file = path.join(DIR, last);
  if (!fs.existsSync(file)) throw new Error(`Migration file ${last} is missing; cannot undo it.`);
  log(`Reverting: ${last}`);
  await require(file).down(context());
  await sequelize.query(`DELETE FROM \`${TABLE}\` WHERE name = ?`, { replacements: [last] });
  return last;
};

module.exports = { up, down, status };
