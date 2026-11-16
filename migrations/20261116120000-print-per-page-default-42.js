// QR codes per page on a batch's print layout: at most 42 for horizontal pairs and 48 for vertical
// ones, and that maximum is the default. New batches start horizontal, so the column default goes
// from 40 to 42. Existing batches keep what they have.

module.exports = {
  up: async ({ queryInterface, Sequelize: { DataTypes } }) => {
    await queryInterface.changeColumn('chain_batches', 'print_per_page', { type: DataTypes.TINYINT.UNSIGNED, allowNull: false, defaultValue: 42 });
  },

  down: async ({ queryInterface, Sequelize: { DataTypes } }) => {
    await queryInterface.changeColumn('chain_batches', 'print_per_page', { type: DataTypes.TINYINT.UNSIGNED, allowNull: false, defaultValue: 40 });
  },
};
