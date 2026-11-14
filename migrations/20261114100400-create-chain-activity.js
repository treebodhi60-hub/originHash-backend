const { id, ref, timestamps, createTable, dropTables } = require('../src/db/migrationHelpers');

// Supply-chain module: every scan of a unit's QR codes (who, where, and the Sold action) and the
// warranty records retailers and producers add to a unit (dates and photos).

module.exports = {
  up: async ({ queryInterface, Sequelize: { DataTypes } }) => {
    await createTable(
      queryInterface,
      'chain_scans',
      {
        id: id(),
        unit_id: ref('chain_units', { allowNull: false, onDelete: 'CASCADE' }),
        qr_type: { type: DataTypes.ENUM('retailer', 'consumer'), allowNull: false },
        action: { type: DataTypes.ENUM('scan', 'sold'), allowNull: false, defaultValue: 'scan' },
        actor_type: {
          type: DataTypes.ENUM('admin', 'producer', 'distributor', 'retailer', 'consumer', 'guest'),
          allowNull: false,
        },
        // Who scanned (null for a guest); actor_type is their role at the time.
        user_id: ref('users'),
        // Lets the page that recorded the scan add where it happened, once the browser shares it.
        token: { type: DataTypes.STRING(36), allowNull: false, unique: true },
        latitude: { type: DataTypes.DECIMAL(9, 6), allowNull: true },
        longitude: { type: DataTypes.DECIMAL(9, 6), allowNull: true },
        location_name: { type: DataTypes.STRING(255), allowNull: true },
        ...timestamps(),
      },
      [{ fields: ['unit_id', 'created_at'] }, { fields: ['user_id', 'created_at'] }, { fields: ['qr_type', 'created_at'] }]
    );

    await createTable(
      queryInterface,
      'chain_warranties',
      {
        id: id(),
        unit_id: ref('chain_units', { allowNull: false, onDelete: 'CASCADE' }),
        added_by_type: { type: DataTypes.ENUM('producer', 'retailer', 'admin'), allowNull: false },
        user_id: ref('users'),
        registered_on: { type: DataTypes.DATEONLY, allowNull: false },
        valid_till: { type: DataTypes.DATEONLY, allowNull: true },
        details: { type: DataTypes.TEXT, allowNull: true },
        // [url, …]
        photos: { type: DataTypes.JSON, allowNull: true },
        ...timestamps(),
      },
      [{ fields: ['unit_id', 'created_at'] }]
    );
  },

  down: async ({ queryInterface }) => {
    await dropTables(queryInterface, ['chain_warranties', 'chain_scans']);
  },
};
