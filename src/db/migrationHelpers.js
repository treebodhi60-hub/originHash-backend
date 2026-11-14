const { DataTypes } = require('sequelize');

// Shared bits for files in backend/migrations.

const id = () => ({ type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true, allowNull: false });

// A foreign key column. `onDelete` is CASCADE, SET NULL or RESTRICT.
const ref = (table, { allowNull = true, onDelete = 'SET NULL' } = {}) => ({
  type: DataTypes.INTEGER.UNSIGNED,
  allowNull,
  references: { model: table, key: 'id' },
  onUpdate: 'CASCADE',
  onDelete,
});

const timestamps = () => ({
  created_at: { type: DataTypes.DATE, allowNull: false },
  updated_at: { type: DataTypes.DATE, allowNull: false },
});

const tableExists = async (queryInterface, table) => {
  const tables = await queryInterface.showAllTables();
  return tables.map((t) => (typeof t === 'string' ? t : t.tableName)).includes(table);
};

// Creates a table (utf8mb4, InnoDB) and its indexes, unless the table is already there — so a
// migration that stopped half way can simply be run again.
const createTable = async (queryInterface, table, columns, indexes = []) => {
  if (await tableExists(queryInterface, table)) return;
  await queryInterface.createTable(table, columns, { charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci', engine: 'InnoDB' });
  for (const index of indexes) await queryInterface.addIndex(table, index);
};

const dropTables = async (queryInterface, tables) => {
  for (const table of tables) await queryInterface.dropTable(table);
};

module.exports = { id, ref, timestamps, createTable, dropTables, tableExists };
