const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');

const User = sequelize.define(
  'User',
  {
    id: {
      type: DataTypes.INTEGER.UNSIGNED,
      autoIncrement: true,
      primaryKey: true,
    },
    mobile: {
      type: DataTypes.STRING(15),
      allowNull: true,
      unique: true,
    },
    username: {
      type: DataTypes.STRING(50),
      allowNull: true,
      unique: true,
    },
    passwordHash: {
      type: DataTypes.STRING(255),
      allowNull: true,
      field: 'password_hash',
    },
    countryCode: {
      type: DataTypes.STRING(5),
      allowNull: false,
      defaultValue: '+91',
      field: 'country_code',
    },
    name: {
      type: DataTypes.STRING(120),
      allowNull: true,
    },
    email: {
      type: DataTypes.STRING(150),
      allowNull: true,
    },
    photoUrl: {
      type: DataTypes.STRING(500),
      allowNull: true,
      field: 'photo_url',
    },
    userType: {
      type: DataTypes.ENUM('farmer', 'retailer', 'distributor', 'supplier', 'consumer'),
      allowNull: true,
      field: 'user_type',
    },
    address: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    isAdmin: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
      field: 'is_admin',
    },
    isSuperAdmin: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
      field: 'is_super_admin',
    },
    isBlocked: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
      field: 'is_blocked',
    },
    profileCompleted: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
      field: 'profile_completed',
    },
    scansCount: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      defaultValue: 0,
      field: 'scans_count',
    },
    // ---- Supply-chain module (migration 20261114100100) ----
    // A producer's admin or staff: logs in with username + password.
    producerId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true, field: 'producer_id' },
    producerRole: { type: DataTypes.ENUM('admin', 'staff'), allowNull: true, field: 'producer_role' },
    canChat: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'can_chat' },
    // A distributor or retailer registered by the OriginHash superadmin.
    partnerRole: { type: DataTypes.ENUM('distributor', 'retailer'), allowNull: true, field: 'partner_role' },
    businessName: { type: DataTypes.STRING(160), allowNull: true, field: 'business_name' },
    city: { type: DataTypes.STRING(120), allowNull: true, field: 'city' },
  },
  {
    tableName: 'users',
    underscored: true,
    timestamps: true,
  }
);

module.exports = User;
