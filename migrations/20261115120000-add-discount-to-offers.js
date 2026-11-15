// A product's discount (Discounts tab) now carries its percentage. The QR batch request fills its
// "Max discount %" from the chosen product's discount.

module.exports = {
  up: async ({ queryInterface, Sequelize: { DataTypes } }) => {
    const columns = await queryInterface.describeTable('producer_offers');
    if (!columns.discount_percent) {
      await queryInterface.addColumn('producer_offers', 'discount_percent', { type: DataTypes.DECIMAL(5, 2), allowNull: true, after: 'coupon_code' });
    }
  },

  down: async ({ queryInterface }) => {
    const columns = await queryInterface.describeTable('producer_offers');
    if (columns.discount_percent) await queryInterface.removeColumn('producer_offers', 'discount_percent');
  },
};
