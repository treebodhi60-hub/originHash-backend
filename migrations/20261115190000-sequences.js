// Counters for numbers that run in one sequence across OriginHash — for now only batch numbers
// (OHB-0001, OHB-0002…; see src/connect/batches). One row per sequence; `value` is the last number used.

module.exports = {
  up: async ({ queryInterface, Sequelize: { DataTypes } }) => {
    const tables = (await queryInterface.showAllTables()).map((t) => (typeof t === 'string' ? t : t.tableName));
    if (!tables.includes('oh_sequences')) {
      await queryInterface.createTable('oh_sequences', {
        name: { type: DataTypes.STRING(40), primaryKey: true, allowNull: false },
        value: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      });
    }
    // Start after any OHB- numbers already in use.
    await queryInterface.sequelize.query(
      `INSERT IGNORE INTO oh_sequences (name, value)
       SELECT 'batch_no', COALESCE(MAX(CAST(SUBSTRING(batch_no, 5) AS UNSIGNED)), 0)
         FROM chain_batches WHERE batch_no REGEXP '^OHB-[0-9]+$'`
    );
  },

  down: async ({ queryInterface }) => {
    await queryInterface.dropTable('oh_sequences');
  },
};
