const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');

// ACTIVE  Its stickers can be used now.
// ENDED   Expired (EXPIRED) or cleared by a test-mode reset (RESET).
const PACK_STATUSES = ['ACTIVE', 'ENDED'];

// Stickers bought with one plan purchase. A user's balance on a plan's tab is the sum of that
// plan's ACTIVE packs; generating takes from the pack that expires first.
//
// Pay As You Go   Valid for two years from purchase (cycleEnd = periodEnd).
// Subscription    monthlyQuota stickers each month for 1 or 12 months; unused ones expire at the
//                 end of each month (cycleEnd), and a yearly pack refills until periodEnd.
// Fixed + Variable The month's included stickers plus extras (extrasBought, which sets the price of
//                 further extras that month); everything left expires at periodEnd.
const StickerPack = sequelize.define(
  'StickerPack',
  {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    userId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, field: 'user_id' },
    planType: { type: DataTypes.STRING(20), allowNull: false, field: 'plan_type' },
    billingCycle: { type: DataTypes.STRING(10), allowNull: true, field: 'billing_cycle' },
    monthlyQuota: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true, field: 'monthly_quota' },
    stickersLeft: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0, field: 'stickers_left' },
    extrasBought: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0, field: 'extras_bought' },
    // The current month's stickers expire at cycleEnd; the pack ends at periodEnd.
    cycleEnd: { type: DataTypes.DATE, allowNull: true, field: 'cycle_end' },
    periodStart: { type: DataTypes.DATE, allowNull: false, field: 'period_start' },
    periodEnd: { type: DataTypes.DATE, allowNull: true, field: 'period_end' },
    status: {
      type: DataTypes.STRING(10),
      allowNull: false,
      defaultValue: 'ACTIVE',
      validate: { isIn: [PACK_STATUSES] },
    },
    endedReason: { type: DataTypes.STRING(20), allowNull: true, field: 'ended_reason' },
    endedAt: { type: DataTypes.DATE, allowNull: true, field: 'ended_at' },
  },
  {
    tableName: 'sticker_packs',
    underscored: true,
    timestamps: true,
    indexes: [{ fields: ['user_id', 'status'] }, { fields: ['status', 'cycle_end'] }],
  }
);

module.exports = StickerPack;
