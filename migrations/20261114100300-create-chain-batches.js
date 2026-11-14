const { id, ref, timestamps, createTable, dropTables } = require('../src/db/migrationHelpers');

// Supply-chain module: QR batches. A producer requests N units; the superadmin allots a batch with
// a max discount and an expiry date. Each unit is a pair of QR codes — a retailer QR (scanned along
// the chain, marked Sold by a retailer) and a consumer QR that only opens once the unit is sold —
// with its own unique coupon code when the batch has a discount.

module.exports = {
  up: async ({ queryInterface, Sequelize: { DataTypes } }) => {
    await createTable(
      queryInterface,
      'chain_batches',
      {
        id: id(),
        producer_id: ref('producers', { allowNull: false, onDelete: 'RESTRICT' }),
        product_id: ref('producer_products'),
        batch_no: { type: DataTypes.STRING(80), allowNull: false },
        quantity: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
        // Null or 0: no discount on this batch (no coupon codes).
        max_discount_percent: { type: DataTypes.DECIMAL(5, 2), allowNull: true },
        expiry_date: { type: DataTypes.DATEONLY, allowNull: false },
        notes: { type: DataTypes.STRING(500), allowNull: true },
        allotted_by: ref('users'),
        ...timestamps(),
      },
      [{ unique: true, fields: ['producer_id', 'batch_no'] }]
    );

    await createTable(
      queryInterface,
      'chain_batch_requests',
      {
        id: id(),
        producer_id: ref('producers', { allowNull: false, onDelete: 'CASCADE' }),
        product_id: ref('producer_products'),
        quantity: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
        max_discount_percent: { type: DataTypes.DECIMAL(5, 2), allowNull: true },
        expiry_date: { type: DataTypes.DATEONLY, allowNull: false },
        batch_no: { type: DataTypes.STRING(80), allowNull: true },
        note: { type: DataTypes.STRING(500), allowNull: true },
        status: { type: DataTypes.ENUM('pending', 'allotted', 'rejected'), allowNull: false, defaultValue: 'pending' },
        requested_by: ref('users'),
        decided_by: ref('users'),
        decided_at: { type: DataTypes.DATE, allowNull: true },
        decision_note: { type: DataTypes.STRING(500), allowNull: true },
        batch_id: ref('chain_batches'),
        ...timestamps(),
      },
      [{ fields: ['status', 'created_at'] }, { fields: ['producer_id', 'created_at'] }]
    );

    await createTable(
      queryInterface,
      'chain_units',
      {
        id: id(),
        batch_id: ref('chain_batches', { allowNull: false, onDelete: 'CASCADE' }),
        serial_no: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
        retailer_token: { type: DataTypes.STRING(12), allowNull: false, unique: true },
        consumer_token: { type: DataTypes.STRING(12), allowNull: false, unique: true },
        coupon_code: { type: DataTypes.STRING(20), allowNull: true, unique: true },
        discount_percent: { type: DataTypes.DECIMAL(5, 2), allowNull: true },
        // 'sold' happens once: it unlocks the consumer QR.
        status: { type: DataTypes.ENUM('allotted', 'sold'), allowNull: false, defaultValue: 'allotted' },
        sold_at: { type: DataTypes.DATE, allowNull: true },
        // The retailer (or OriginHash superadmin) who pressed Sold.
        sold_by_user_id: ref('users'),
        // The retailer-QR scan the sale was made from (who scanned it), next to who pressed Sold.
        sale_scan_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
        trade_scan_count: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
        consumer_scan_count: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
        coupon_claimed_by: ref('users'),
        coupon_claimed_at: { type: DataTypes.DATE, allowNull: true },
        ...timestamps(),
      },
      [{ fields: ['batch_id', 'serial_no'] }, { fields: ['status', 'sold_at'] }]
    );
  },

  down: async ({ queryInterface }) => {
    await dropTables(queryInterface, ['chain_units', 'chain_batch_requests', 'chain_batches']);
  },
};
