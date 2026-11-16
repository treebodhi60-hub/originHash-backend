// A product discount can carry an image (shown to consumers on the consumer QR instead of the bare
// percentage) and two limits, in rupees, chosen with sliders (0 to 500 in steps of 10; 0 = no limit):
//   min_amount  the minimum purchase the discount applies to
//   max_amount  the most the discount can take off

const COLUMNS = (DataTypes) => ({
  image_url: { type: DataTypes.STRING(500), allowNull: true },
  image_name: { type: DataTypes.STRING(200), allowNull: true },
  min_amount: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
  max_amount: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
});

module.exports = {
  up: async ({ queryInterface, Sequelize: { DataTypes } }) => {
    const existing = await queryInterface.describeTable('producer_offers');
    for (const [name, spec] of Object.entries(COLUMNS(DataTypes))) {
      if (!existing[name]) await queryInterface.addColumn('producer_offers', name, spec);
    }
  },

  down: async ({ queryInterface, Sequelize: { DataTypes } }) => {
    const existing = await queryInterface.describeTable('producer_offers');
    for (const name of Object.keys(COLUMNS(DataTypes)).reverse()) {
      if (existing[name]) await queryInterface.removeColumn('producer_offers', name);
    }
  },
};
