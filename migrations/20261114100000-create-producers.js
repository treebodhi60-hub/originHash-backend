const { id, ref, timestamps, createTable, dropTables } = require('../src/db/migrationHelpers');

// Supply-chain module: producer companies, registered by the OriginHash superadmin. The people who
// log in for a producer are ordinary app users linked to it (see the next migration).

module.exports = {
  up: async ({ queryInterface, Sequelize: { DataTypes } }) => {
    await createTable(
      queryInterface,
      'producers',
      {
        id: id(),
        name: { type: DataTypes.STRING(160), allowNull: false },
        // e.g. ["Honey", "Wine"]: a producer can work in several categories.
        categories: { type: DataTypes.JSON, allowNull: true },
        email: { type: DataTypes.STRING(150), allowNull: true },
        mobile: { type: DataTypes.STRING(15), allowNull: true },
        address: { type: DataTypes.STRING(255), allowNull: true },
        website: { type: DataTypes.STRING(255), allowNull: true },
        verification_doc_url: { type: DataTypes.STRING(500), allowNull: true },
        verification_doc_name: { type: DataTypes.STRING(200), allowNull: true },
        // Set by the producer: record distributor/retailer scans, and let consumers chat with the brand.
        tracking_enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        chat_enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        is_blocked: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        created_by: ref('users'),
        ...timestamps(),
      },
      [{ fields: ['name'] }]
    );
  },

  down: async ({ queryInterface }) => {
    await dropTables(queryInterface, ['producers']);
  },
};
