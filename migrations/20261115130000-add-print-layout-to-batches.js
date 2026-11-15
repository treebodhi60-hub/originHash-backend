// How a QR batch's PDF is laid out, set by the OriginHash superadmin (producers download with it):
// paper size, QR labels per page (always even: retailer + consumer pairs) and the pair orientation
// (horizontal: retailer left, consumer right; vertical: consumer on top, retailer below).

module.exports = {
  up: async ({ queryInterface, Sequelize: { DataTypes } }) => {
    const columns = await queryInterface.describeTable('chain_batches');
    if (!columns.print_page_size) {
      await queryInterface.addColumn('chain_batches', 'print_page_size', { type: DataTypes.ENUM('A4', 'A3'), allowNull: false, defaultValue: 'A4' });
    }
    if (!columns.print_per_page) {
      await queryInterface.addColumn('chain_batches', 'print_per_page', { type: DataTypes.TINYINT.UNSIGNED, allowNull: false, defaultValue: 40 });
    }
    if (!columns.print_orientation) {
      await queryInterface.addColumn('chain_batches', 'print_orientation', {
        type: DataTypes.ENUM('horizontal', 'vertical'),
        allowNull: false,
        defaultValue: 'horizontal',
      });
    }
  },

  down: async ({ queryInterface }) => {
    const columns = await queryInterface.describeTable('chain_batches');
    for (const name of ['print_orientation', 'print_per_page', 'print_page_size']) {
      if (columns[name]) await queryInterface.removeColumn('chain_batches', name);
    }
  },
};
