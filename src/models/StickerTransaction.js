const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');

// PURCHASE  Stickers bought (+), with what was paid.
// GENERATE  Stickers used for a batch (−).
// REFILL    A yearly Subscription's new month of stickers (+).
// EXPIRE    Unused stickers that ran out at the end of their month (−).
// RESET     Cleared by a test-mode reset (−).
const TRANSACTION_TYPES = ['PURCHASE', 'GENERATE', 'REFILL', 'EXPIRE', 'RESET'];

// The sticker ledger: append-only, one row per change to a pack, with the balance of that plan's
// tab after it. Per plan, a user's rows always add up to their balance on that tab.
const StickerTransaction = sequelize.define(
  'StickerTransaction',
  {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    userId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, field: 'user_id' },
    planType: { type: DataTypes.STRING(20), allowNull: false, field: 'plan_type' },
    packId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true, field: 'pack_id' },
    type: { type: DataTypes.STRING(10), allowNull: false, validate: { isIn: [TRANSACTION_TYPES] } },
    // Signed: positive adds stickers, negative takes them.
    stickers: { type: DataTypes.INTEGER, allowNull: false },
    balanceAfter: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, field: 'balance_after' },
    amountPaise: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true, field: 'amount_paise' },
    purchaseId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true, unique: true, field: 'purchase_id' },
    batchId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true, field: 'batch_id' },
    description: { type: DataTypes.STRING(255), allowNull: false },
  },
  {
    tableName: 'sticker_transactions',
    underscored: true,
    timestamps: true,
    updatedAt: false,
    indexes: [{ fields: ['user_id', 'id'] }],
  }
);

module.exports = StickerTransaction;
