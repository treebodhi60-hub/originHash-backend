const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');

// A run of identical QR labels: one QR, printed `quantity` times, that opens the product's details
// (brand, product, batch, pack size, purpose, expiry). Each printed label also carries its own
// running number next to the batch's public code.
const BulkQrBatch = sequelize.define(
  'BulkQrBatch',
  {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    // Public, unguessable reference in the QR's link and on every label, e.g. OHB-7K2M9QXA.
    code: { type: DataTypes.STRING(16), allowNull: false, unique: true },
    brandName: { type: DataTypes.STRING(120), allowNull: false, field: 'brand_name' },
    productName: { type: DataTypes.STRING(160), allowNull: false, field: 'product_name' },
    batchNo: { type: DataTypes.STRING(80), allowNull: false, field: 'batch_no' },
    packSize: { type: DataTypes.STRING(60), allowNull: false, field: 'pack_size' },
    purpose: { type: DataTypes.STRING(30), allowNull: true },
    expiryDate: { type: DataTypes.DATEONLY, allowNull: true, field: 'expiry_date' },
    quantity: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    pageSize: { type: DataTypes.STRING(2), allowNull: false, defaultValue: 'A4', field: 'page_size' },
    labelsPerPage: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 10, field: 'labels_per_page' },
    createdBy: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true, field: 'created_by' },
    // How often the QR has been opened, and when last.
    scanCount: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0, field: 'scan_count' },
    lastScannedAt: { type: DataTypes.DATE, allowNull: true, field: 'last_scanned_at' },
  },
  {
    tableName: 'bulk_qr_batches',
    underscored: true,
    timestamps: true,
    indexes: [{ fields: ['created_by', 'created_at'] }],
  }
);

module.exports = BulkQrBatch;
