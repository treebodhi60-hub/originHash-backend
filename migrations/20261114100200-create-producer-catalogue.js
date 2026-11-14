const { id, ref, timestamps, createTable, dropTables } = require('../src/db/migrationHelpers');

// Supply-chain module: what a producer shows consumers — products (info, NABL certificate, other
// certificates, website, images, warranty terms) and discounts / loyalty offers.

module.exports = {
  up: async ({ queryInterface, Sequelize: { DataTypes } }) => {
    await createTable(
      queryInterface,
      'producer_products',
      {
        id: id(),
        producer_id: ref('producers', { allowNull: false, onDelete: 'CASCADE' }),
        name: { type: DataTypes.STRING(160), allowNull: false },
        category: { type: DataTypes.STRING(80), allowNull: true },
        description: { type: DataTypes.TEXT, allowNull: true },
        website: { type: DataTypes.STRING(255), allowNull: true },
        nabl_certificate_url: { type: DataTypes.STRING(500), allowNull: true },
        nabl_certificate_name: { type: DataTypes.STRING(200), allowNull: true },
        // [{ name, url, fileName }]
        certifications: { type: DataTypes.JSON, allowNull: true },
        // [url, …]
        images: { type: DataTypes.JSON, allowNull: true },
        warranty_terms: { type: DataTypes.TEXT, allowNull: true },
        is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        created_by: ref('users'),
        ...timestamps(),
      },
      [{ fields: ['producer_id', 'name'] }]
    );

    await createTable(
      queryInterface,
      'producer_offers',
      {
        id: id(),
        producer_id: ref('producers', { allowNull: false, onDelete: 'CASCADE' }),
        // Empty: the offer applies to every product of the producer.
        product_id: ref('producer_products'),
        title: { type: DataTypes.STRING(160), allowNull: false },
        coupon_code: { type: DataTypes.STRING(60), allowNull: true },
        details: { type: DataTypes.TEXT, allowNull: true },
        valid_till: { type: DataTypes.DATEONLY, allowNull: true },
        is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        created_by: ref('users'),
        ...timestamps(),
      },
      [{ fields: ['producer_id', 'is_active'] }]
    );
  },

  down: async ({ queryInterface }) => {
    await dropTables(queryInterface, ['producer_offers', 'producer_products']);
  },
};
