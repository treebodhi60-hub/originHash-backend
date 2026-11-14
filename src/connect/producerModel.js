const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');

// A producer company of the supply-chain module (table from backend/migrations). Its people are
// ordinary users with users.producer_id set. Kept in its own file so the main auth controller can
// check a producer's block without loading the whole module.

const opts = (tableName) => ({ tableName, underscored: true, timestamps: true });
const pk = { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true };
const fk = (allowNull = true) => ({ type: DataTypes.INTEGER.UNSIGNED, allowNull });
const json = (name) => ({
  type: DataTypes.JSON,
  allowNull: true,
  get() {
    const raw = this.getDataValue(name);
    if (typeof raw === 'string') {
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    }
    return raw;
  },
});

const Producer = sequelize.define(
  'Producer',
  {
    id: pk,
    name: { type: DataTypes.STRING(160), allowNull: false },
    categories: json('categories'),
    email: { type: DataTypes.STRING(150), allowNull: true },
    mobile: { type: DataTypes.STRING(15), allowNull: true },
    address: { type: DataTypes.STRING(255), allowNull: true },
    website: { type: DataTypes.STRING(255), allowNull: true },
    verificationDocUrl: { type: DataTypes.STRING(500), allowNull: true },
    verificationDocName: { type: DataTypes.STRING(200), allowNull: true },
    trackingEnabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    chatEnabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    isBlocked: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    createdBy: fk(),
  },
  opts('producers')
);

module.exports = Producer;
