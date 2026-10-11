const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');

// Light QR stickers: a batch of unique QR codes for one product. Each code is one unit, with its
// own ID (QR-00427) and journey: every scan, and one photo + comment per user.

const LightQrBatch = sequelize.define(
  'LightQrBatch',
  {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    brandName: { type: DataTypes.STRING(120), allowNull: false, field: 'brand_name' },
    productName: { type: DataTypes.STRING(160), allowNull: false, field: 'product_name' },
    batchNo: { type: DataTypes.STRING(80), allowNull: false, field: 'batch_no' },
    packSize: { type: DataTypes.STRING(60), allowNull: false, field: 'pack_size' },
    quantity: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    pageSize: { type: DataTypes.STRING(2), allowNull: false, defaultValue: 'A4', field: 'page_size' },
    labelsPerPage: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 10, field: 'labels_per_page' },
    createdBy: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true, field: 'created_by' },
  },
  { tableName: 'light_qr_batches', underscored: true, timestamps: true, indexes: [{ fields: ['created_by', 'created_at'] }] }
);

// One unit. Its printed ID is QR- plus its id (QR-00427); the QR links to its unguessable token,
// so codes can't be found by counting.
const LightQrCode = sequelize.define(
  'LightQrCode',
  {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    batchId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, field: 'batch_id' },
    sequenceNo: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, field: 'sequence_no' },
    token: { type: DataTypes.STRING(12), allowNull: false, unique: true },
    scanCount: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0, field: 'scan_count' },
    updateCount: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0, field: 'update_count' },
    lastScannedAt: { type: DataTypes.DATE, allowNull: true, field: 'last_scanned_at' },
  },
  { tableName: 'light_qr_codes', underscored: true, timestamps: true, indexes: [{ fields: ['batch_id', 'sequence_no'] }] }
);

// One opening of a code's page: who (when signed in) and where (once the browser shares it, via
// `token`, which only that page knows).
const LightQrScan = sequelize.define(
  'LightQrScan',
  {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    codeId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, field: 'code_id' },
    userId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true, field: 'user_id' },
    token: { type: DataTypes.STRING(36), allowNull: false, unique: true },
    latitude: { type: DataTypes.DECIMAL(9, 6), allowNull: true },
    longitude: { type: DataTypes.DECIMAL(9, 6), allowNull: true },
    locationName: { type: DataTypes.STRING(255), allowNull: true, field: 'location_name' },
  },
  { tableName: 'light_qr_scans', underscored: true, timestamps: true, indexes: [{ fields: ['code_id', 'created_at'] }] }
);

// A photo and a comment on a code — once per user per code.
const LightQrUpdate = sequelize.define(
  'LightQrUpdate',
  {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    codeId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, field: 'code_id' },
    userId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, field: 'user_id' },
    photoUrl: { type: DataTypes.STRING(500), allowNull: false, field: 'photo_url' },
    comment: { type: DataTypes.STRING(500), allowNull: false },
    latitude: { type: DataTypes.DECIMAL(9, 6), allowNull: true },
    longitude: { type: DataTypes.DECIMAL(9, 6), allowNull: true },
    locationName: { type: DataTypes.STRING(255), allowNull: true, field: 'location_name' },
  },
  {
    tableName: 'light_qr_updates',
    underscored: true,
    timestamps: true,
    indexes: [{ unique: true, fields: ['code_id', 'user_id'] }],
  }
);

module.exports = { LightQrBatch, LightQrCode, LightQrScan, LightQrUpdate };
