const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');

// One opening of a bulk QR's page: who (when signed in) and where (when the browser shared it).
// The location arrives a moment after the scan, once the person answers the browser's prompt, so
// it's attached later using `token`, which only the page that made the scan knows.
const BulkQrScan = sequelize.define(
  'BulkQrScan',
  {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    batchId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, field: 'batch_id' },
    userId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true, field: 'user_id' },
    token: { type: DataTypes.STRING(36), allowNull: false, unique: true },
    latitude: { type: DataTypes.DECIMAL(9, 6), allowNull: true },
    longitude: { type: DataTypes.DECIMAL(9, 6), allowNull: true },
    // Place name for the coordinates ("Madhapur, Telangana"), filled in shortly after.
    locationName: { type: DataTypes.STRING(255), allowNull: true, field: 'location_name' },
  },
  {
    tableName: 'bulk_qr_scans',
    underscored: true,
    timestamps: true,
    indexes: [{ fields: ['batch_id', 'created_at'] }],
  }
);

module.exports = BulkQrScan;
