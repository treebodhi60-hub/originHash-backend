// Warranty documents on a product: several titled images or PDFs (warranty card, terms sheet,
// service centres…), stored like `certifications` as [{ title, ref, name }].

module.exports = {
  up: async ({ queryInterface, Sequelize: { DataTypes } }) => {
    const columns = await queryInterface.describeTable('producer_products');
    if (!columns.warranty_docs) {
      await queryInterface.addColumn('producer_products', 'warranty_docs', { type: DataTypes.JSON, allowNull: true, after: 'warranty_terms' });
    }
  },

  down: async ({ queryInterface }) => {
    const columns = await queryInterface.describeTable('producer_products');
    if (columns.warranty_docs) await queryInterface.removeColumn('producer_products', 'warranty_docs');
  },
};
