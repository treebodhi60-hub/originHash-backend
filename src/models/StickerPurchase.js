const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');

// CREATED  A Razorpay order exists; the user may be paying (or gave up — it simply stays CREATED).
// PAID     The payment was verified with Razorpay and the stickers credited, exactly once.
const PURCHASE_STATUSES = ['CREATED', 'PAID'];

// One plan purchase: a Razorpay order for a fixed price, and the stickers it buys. What it buys
// is fixed here when the order is made, so the stickers credited always match what was paid.
const StickerPurchase = sequelize.define(
  'StickerPurchase',
  {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    userId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, field: 'user_id' },
    planType: { type: DataTypes.STRING(20), allowNull: false, field: 'plan_type' },
    billingCycle: { type: DataTypes.STRING(10), allowNull: true, field: 'billing_cycle' },
    // Pay As You Go: stickers · Subscription: stickers per month · Fixed + Variable: extras.
    quantity: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    // Fixed + Variable only: extras for the month already running (no fee).
    addOn: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'add_on' },
    stickers: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    description: { type: DataTypes.STRING(255), allowNull: false },
    amountPaise: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, field: 'amount_paise' },
    currency: { type: DataTypes.STRING(3), allowNull: false, defaultValue: 'INR' },
    status: {
      type: DataTypes.STRING(10),
      allowNull: false,
      defaultValue: 'CREATED',
      validate: { isIn: [PURCHASE_STATUSES] },
    },
    razorpayOrderId: { type: DataTypes.STRING(40), allowNull: false, unique: true, field: 'razorpay_order_id' },
    // Unique: one Razorpay payment can never be credited twice, even to different purchases.
    razorpayPaymentId: { type: DataTypes.STRING(40), allowNull: true, unique: true, field: 'razorpay_payment_id' },
    method: { type: DataTypes.STRING(20), allowNull: true },
    // The last failed attempt's reason (the user can retry on the same order).
    lastError: { type: DataTypes.STRING(255), allowNull: true, field: 'last_error' },
    paidAt: { type: DataTypes.DATE, allowNull: true, field: 'paid_at' },
    // The pack the stickers went into.
    packId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true, field: 'pack_id' },
  },
  {
    tableName: 'sticker_purchases',
    underscored: true,
    timestamps: true,
    indexes: [{ fields: ['user_id', 'created_at'] }],
  }
);

module.exports = StickerPurchase;
