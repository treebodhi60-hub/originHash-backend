// Tracking and "Chat with brand" move from the producer to each QR batch, switched by the producer
// admin or the OriginHash superadmin. Existing batches keep what their producer had; new batches
// start with both on. (producers.tracking_enabled / chat_enabled stay, unused.)

module.exports = {
  up: async ({ queryInterface, Sequelize: { DataTypes } }) => {
    const columns = await queryInterface.describeTable('chain_batches');
    const added = [];
    for (const name of ['tracking_enabled', 'chat_enabled']) {
      if (!columns[name]) {
        await queryInterface.addColumn('chain_batches', name, { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true });
        added.push(name);
      }
    }
    if (added.length) {
      await queryInterface.sequelize.query(
        `UPDATE chain_batches b JOIN producers p ON p.id = b.producer_id
            SET ${added.map((c) => `b.${c} = p.${c}`).join(', ')}`
      );
    }
  },

  down: async ({ queryInterface }) => {
    const columns = await queryInterface.describeTable('chain_batches');
    for (const name of ['chat_enabled', 'tracking_enabled']) if (columns[name]) await queryInterface.removeColumn('chain_batches', name);
  },
};
