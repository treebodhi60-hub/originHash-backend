const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');
const { User } = require('../models');
const Producer = require('./producerModel');

// Supply-chain module: producers, products and offers, QR batches of retailer + consumer QR pairs,
// scans, warranty and brand chat. People are the app's existing users (producer users, distributors,
// retailers and consumers are told apart by columns on `users`). Tables come from backend/migrations.

const opts = (tableName, extra = {}) => ({ tableName, underscored: true, timestamps: true, ...extra });
const pk = { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true };
const fk = (allowNull = true) => ({ type: DataTypes.INTEGER.UNSIGNED, allowNull });
const json = (name) => ({
  type: DataTypes.JSON,
  allowNull: true,
  // mysql2 can hand JSON back as text on some servers.
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

const ProducerProduct = sequelize.define(
  'ProducerProduct',
  {
    id: pk,
    producerId: fk(false),
    name: { type: DataTypes.STRING(160), allowNull: false },
    category: { type: DataTypes.STRING(80), allowNull: true },
    description: { type: DataTypes.TEXT, allowNull: true },
    website: { type: DataTypes.STRING(255), allowNull: true },
    nablCertificateUrl: { type: DataTypes.STRING(500), allowNull: true },
    nablCertificateName: { type: DataTypes.STRING(200), allowNull: true },
    certifications: json('certifications'),
    images: json('images'),
    warrantyTerms: { type: DataTypes.TEXT, allowNull: true },
    warrantyDocs: json('warrantyDocs'),
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    createdBy: fk(),
  },
  opts('producer_products')
);

const ProducerOffer = sequelize.define(
  'ProducerOffer',
  {
    id: pk,
    producerId: fk(false),
    productId: fk(),
    title: { type: DataTypes.STRING(160), allowNull: false },
    couponCode: { type: DataTypes.STRING(60), allowNull: true },
    discountPercent: { type: DataTypes.DECIMAL(5, 2), allowNull: true },
    details: { type: DataTypes.TEXT, allowNull: true },
    validTill: { type: DataTypes.DATEONLY, allowNull: true },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    createdBy: fk(),
  },
  opts('producer_offers')
);

const ChainBatch = sequelize.define(
  'ChainBatch',
  {
    id: pk,
    producerId: fk(false),
    productId: fk(),
    batchNo: { type: DataTypes.STRING(80), allowNull: false },
    quantity: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    maxDiscountPercent: { type: DataTypes.DECIMAL(5, 2), allowNull: true },
    expiryDate: { type: DataTypes.DATEONLY, allowNull: false },
    notes: { type: DataTypes.STRING(500), allowNull: true },
    allottedBy: fk(),
    // The PDF layout (set by the superadmin; see ./batches).
    printPageSize: { type: DataTypes.ENUM('A4', 'A3'), allowNull: false, defaultValue: 'A4' },
    printPerPage: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false, defaultValue: 40 },
    printOrientation: { type: DataTypes.ENUM('horizontal', 'vertical'), allowNull: false, defaultValue: 'horizontal' },
    // Who may press Sold: 'all' retailers (the producer's own + general) or only the 'producer''s.
    soldAccess: { type: DataTypes.ENUM('all', 'producer'), allowNull: false, defaultValue: 'all' },
  },
  opts('chain_batches')
);

const ChainBatchRequest = sequelize.define(
  'ChainBatchRequest',
  {
    id: pk,
    producerId: fk(false),
    productId: fk(),
    quantity: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    maxDiscountPercent: { type: DataTypes.DECIMAL(5, 2), allowNull: true },
    expiryDate: { type: DataTypes.DATEONLY, allowNull: false },
    batchNo: { type: DataTypes.STRING(80), allowNull: true },
    note: { type: DataTypes.STRING(500), allowNull: true },
    status: { type: DataTypes.ENUM('pending', 'allotted', 'rejected'), allowNull: false, defaultValue: 'pending' },
    requestedBy: fk(),
    decidedBy: fk(),
    decidedAt: { type: DataTypes.DATE, allowNull: true },
    decisionNote: { type: DataTypes.STRING(500), allowNull: true },
    batchId: fk(),
  },
  opts('chain_batch_requests')
);

const ChainUnit = sequelize.define(
  'ChainUnit',
  {
    id: pk,
    batchId: fk(false),
    serialNo: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    retailerToken: { type: DataTypes.STRING(12), allowNull: false, unique: true },
    consumerToken: { type: DataTypes.STRING(12), allowNull: false, unique: true },
    couponCode: { type: DataTypes.STRING(20), allowNull: true, unique: true },
    discountPercent: { type: DataTypes.DECIMAL(5, 2), allowNull: true },
    status: { type: DataTypes.ENUM('allotted', 'sold'), allowNull: false, defaultValue: 'allotted' },
    soldAt: { type: DataTypes.DATE, allowNull: true },
    soldByUserId: fk(),
    saleScanId: fk(),
    tradeScanCount: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    consumerScanCount: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    couponClaimedBy: fk(),
    couponClaimedAt: { type: DataTypes.DATE, allowNull: true },
  },
  opts('chain_units')
);

const ChainScan = sequelize.define(
  'ChainScan',
  {
    id: pk,
    unitId: fk(false),
    qrType: { type: DataTypes.ENUM('retailer', 'consumer'), allowNull: false },
    action: { type: DataTypes.ENUM('scan', 'sold'), allowNull: false, defaultValue: 'scan' },
    actorType: {
      type: DataTypes.ENUM('admin', 'producer', 'distributor', 'retailer', 'consumer', 'guest'),
      allowNull: false,
    },
    userId: fk(),
    token: { type: DataTypes.STRING(36), allowNull: false, unique: true },
    latitude: { type: DataTypes.DECIMAL(9, 6), allowNull: true },
    longitude: { type: DataTypes.DECIMAL(9, 6), allowNull: true },
    locationName: { type: DataTypes.STRING(255), allowNull: true },
  },
  opts('chain_scans')
);

const ChainWarranty = sequelize.define(
  'ChainWarranty',
  {
    id: pk,
    unitId: fk(false),
    addedByType: { type: DataTypes.ENUM('producer', 'retailer', 'admin'), allowNull: false },
    userId: fk(),
    registeredOn: { type: DataTypes.DATEONLY, allowNull: false },
    validTill: { type: DataTypes.DATEONLY, allowNull: true },
    details: { type: DataTypes.TEXT, allowNull: true },
    photos: json('photos'),
  },
  opts('chain_warranties')
);

const ChatThread = sequelize.define(
  'ChatThread',
  {
    id: pk,
    producerId: fk(false),
    consumerId: fk(false),
    unitId: fk(),
    assignedUserId: fk(),
    lastMessageAt: { type: DataTypes.DATE, allowNull: true },
    lastMessagePreview: { type: DataTypes.STRING(200), allowNull: true },
    unreadForProducer: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    unreadForConsumer: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
  },
  opts('brand_chat_threads')
);

const ChatMessage = sequelize.define(
  'ChatMessage',
  {
    id: pk,
    threadId: fk(false),
    senderType: { type: DataTypes.ENUM('consumer', 'producer'), allowNull: false },
    senderUserId: fk(),
    body: { type: DataTypes.TEXT, allowNull: false },
    // An optional photo (connect/chat); a message has text, a photo or both.
    imageUrl: { type: DataTypes.STRING(500), allowNull: true },
    imageName: { type: DataTypes.STRING(200), allowNull: true },
  },
  opts('brand_chat_messages')
);

// One successful sign-in (see ./logins).
const UserLogin = sequelize.define(
  'UserLogin',
  {
    id: pk,
    userId: fk(false),
    producerId: fk(),
    method: { type: DataTypes.ENUM('password', 'otp'), allowNull: false },
    ip: { type: DataTypes.STRING(64), allowNull: true },
    userAgent: { type: DataTypes.STRING(255), allowNull: true },
  },
  opts('user_logins')
);

// A user's request to become a retailer, decided by the OriginHash superadmin.
const PartnerApplication = sequelize.define(
  'PartnerApplication',
  {
    id: pk,
    userId: fk(false),
    role: { type: DataTypes.ENUM('retailer'), allowNull: false, defaultValue: 'retailer' },
    producerId: fk(),
    businessName: { type: DataTypes.STRING(160), allowNull: false },
    city: { type: DataTypes.STRING(120), allowNull: true },
    address: { type: DataTypes.STRING(255), allowNull: true },
    note: { type: DataTypes.STRING(500), allowNull: true },
    status: { type: DataTypes.ENUM('pending', 'approved', 'rejected'), allowNull: false, defaultValue: 'pending' },
    decidedBy: fk(),
    decidedAt: { type: DataTypes.DATE, allowNull: true },
    decisionNote: { type: DataTypes.STRING(500), allowNull: true },
  },
  opts('partner_applications')
);

// Associations. `constraints: false` everywhere: the foreign keys themselves live in the migrations.
const rel = { constraints: false };
Producer.hasMany(User, { foreignKey: 'producerId', as: 'users', ...rel });
User.belongsTo(Producer, { foreignKey: 'producerId', as: 'producer', ...rel });
Producer.belongsTo(User, { foreignKey: 'createdBy', as: 'creator', ...rel });

Producer.hasMany(ProducerProduct, { foreignKey: 'producerId', as: 'products', ...rel });
ProducerProduct.belongsTo(Producer, { foreignKey: 'producerId', as: 'producer', ...rel });
Producer.hasMany(ProducerOffer, { foreignKey: 'producerId', as: 'offers', ...rel });
ProducerOffer.belongsTo(ProducerProduct, { foreignKey: 'productId', as: 'product', ...rel });

Producer.hasMany(ChainBatch, { foreignKey: 'producerId', as: 'batches', ...rel });
ChainBatch.belongsTo(Producer, { foreignKey: 'producerId', as: 'producer', ...rel });
ChainBatch.belongsTo(ProducerProduct, { foreignKey: 'productId', as: 'product', ...rel });
ChainBatch.belongsTo(User, { foreignKey: 'allottedBy', as: 'allotter', ...rel });
ChainBatch.hasMany(ChainUnit, { foreignKey: 'batchId', as: 'units', ...rel });
ChainUnit.belongsTo(ChainBatch, { foreignKey: 'batchId', as: 'batch', ...rel });

ChainBatchRequest.belongsTo(Producer, { foreignKey: 'producerId', as: 'producer', ...rel });
ChainBatchRequest.belongsTo(ProducerProduct, { foreignKey: 'productId', as: 'product', ...rel });
ChainBatchRequest.belongsTo(User, { foreignKey: 'requestedBy', as: 'requester', ...rel });
ChainBatchRequest.belongsTo(ChainBatch, { foreignKey: 'batchId', as: 'batch', ...rel });

ChainUnit.belongsTo(User, { foreignKey: 'soldByUserId', as: 'seller', ...rel });
ChainUnit.belongsTo(ChainScan, { foreignKey: 'saleScanId', as: 'saleScan', ...rel });
ChainUnit.hasMany(ChainScan, { foreignKey: 'unitId', as: 'scans', ...rel });
ChainUnit.hasMany(ChainWarranty, { foreignKey: 'unitId', as: 'warranties', ...rel });

ChainScan.belongsTo(ChainUnit, { foreignKey: 'unitId', as: 'unit', ...rel });
ChainScan.belongsTo(User, { foreignKey: 'userId', as: 'user', ...rel });
ChainWarranty.belongsTo(User, { foreignKey: 'userId', as: 'user', ...rel });

ChatThread.belongsTo(Producer, { foreignKey: 'producerId', as: 'producer', ...rel });
ChatThread.belongsTo(User, { foreignKey: 'consumerId', as: 'consumer', ...rel });
ChatThread.belongsTo(ChainUnit, { foreignKey: 'unitId', as: 'unit', ...rel });
ChatThread.belongsTo(User, { foreignKey: 'assignedUserId', as: 'assignee', ...rel });
ChatThread.hasMany(ChatMessage, { foreignKey: 'threadId', as: 'messages', ...rel });
ChatMessage.belongsTo(User, { foreignKey: 'senderUserId', as: 'sender', ...rel });

PartnerApplication.belongsTo(User, { foreignKey: 'userId', as: 'user', ...rel });
PartnerApplication.belongsTo(Producer, { foreignKey: 'producerId', as: 'producer', ...rel });
PartnerApplication.belongsTo(User, { foreignKey: 'decidedBy', as: 'decider', ...rel });
User.belongsTo(Producer, { foreignKey: 'partnerProducerId', as: 'partnerProducer', ...rel });

module.exports = {
  sequelize,
  User,
  Producer,
  ProducerProduct,
  ProducerOffer,
  ChainBatch,
  ChainBatchRequest,
  ChainUnit,
  ChainScan,
  ChainWarranty,
  ChatThread,
  ChatMessage,
  UserLogin,
  PartnerApplication,
};
