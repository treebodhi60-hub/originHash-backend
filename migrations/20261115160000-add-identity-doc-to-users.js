// A retailer's identity document (image or PDF): required when they register themselves, optional
// when a producer or the superadmin adds them. Stored like the module's other files (connect/identity).

module.exports = {
  up: async ({ queryInterface, Sequelize: { DataTypes } }) => {
    const columns = await queryInterface.describeTable('users');
    if (!columns.identity_doc_url) {
      await queryInterface.addColumn('users', 'identity_doc_url', { type: DataTypes.STRING(500), allowNull: true });
    }
    if (!columns.identity_doc_name) {
      await queryInterface.addColumn('users', 'identity_doc_name', { type: DataTypes.STRING(200), allowNull: true });
    }
  },

  down: async ({ queryInterface }) => {
    const columns = await queryInterface.describeTable('users');
    if (columns.identity_doc_name) await queryInterface.removeColumn('users', 'identity_doc_name');
    if (columns.identity_doc_url) await queryInterface.removeColumn('users', 'identity_doc_url');
  },
};
