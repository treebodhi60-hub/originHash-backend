const sequelize = require('../config/db');
const User = require('./User');
const Otp = require('./Otp');
const ImageFolder = require('./ImageFolder');
const ImageAsset = require('./ImageAsset');
const QrBatch = require('./QrBatch');
const QrCode = require('./QrCode');
const Scan = require('./Scan');
const ScanReport = require('./ScanReport');
const UserProfileVersion = require('./UserProfileVersion');
const StickerPack = require('./StickerPack');
const StickerPurchase = require('./StickerPurchase');
const StickerTransaction = require('./StickerTransaction');
const BulkQrBatch = require('./BulkQrBatch');
const BulkQrScan = require('./BulkQrScan');
const { LightQrBatch, LightQrCode, LightQrScan, LightQrUpdate } = require('./LightQr');

ImageFolder.hasMany(ImageAsset, { foreignKey: 'folderId', as: 'images', onDelete: 'CASCADE' });
ImageAsset.belongsTo(ImageFolder, { foreignKey: 'folderId', as: 'folder' });

ImageFolder.hasMany(QrBatch, { foreignKey: 'folderId', as: 'qrBatches' });
QrBatch.belongsTo(ImageFolder, { foreignKey: 'folderId', as: 'folder' });

User.hasMany(QrBatch, { foreignKey: 'createdBy', as: 'qrBatches', onDelete: 'SET NULL' });
QrBatch.belongsTo(User, { foreignKey: 'createdBy', as: 'creator' });

User.hasMany(UserProfileVersion, { foreignKey: 'userId', as: 'profileVersions', onDelete: 'CASCADE' });
UserProfileVersion.belongsTo(User, { foreignKey: 'userId', as: 'user' });
// The admin behind an 'admin' change; the history row stays if that admin is deleted.
UserProfileVersion.belongsTo(User, { foreignKey: 'changedBy', as: 'editor', onDelete: 'SET NULL' });

UserProfileVersion.hasMany(QrBatch, { foreignKey: 'creatorProfileVersionId', as: 'qrBatches', onDelete: 'SET NULL' });
QrBatch.belongsTo(UserProfileVersion, { foreignKey: 'creatorProfileVersionId', as: 'creatorProfile' });

QrBatch.hasMany(QrCode, { foreignKey: 'batchId', as: 'codes', onDelete: 'CASCADE' });
QrCode.belongsTo(QrBatch, { foreignKey: 'batchId', as: 'batch' });

User.hasMany(Scan, { foreignKey: 'userId', as: 'scans', onDelete: 'CASCADE' });
Scan.belongsTo(User, { foreignKey: 'userId', as: 'user' });
// The scanner's details at the time of the scan (see Scan.scannerProfileVersionId).
UserProfileVersion.hasMany(Scan, { foreignKey: 'scannerProfileVersionId', as: 'scans', onDelete: 'SET NULL' });
Scan.belongsTo(UserProfileVersion, { foreignKey: 'scannerProfileVersionId', as: 'scannerProfile' });

// A deleted sticker leaves its scan history in place, just unlinked.
QrCode.hasMany(Scan, { foreignKey: 'qrCodeId', as: 'scans', onDelete: 'SET NULL' });
Scan.belongsTo(QrCode, { foreignKey: 'qrCodeId', as: 'qrCode' });

Scan.hasOne(ScanReport, { foreignKey: 'scanId', as: 'report', onDelete: 'CASCADE' });
ScanReport.belongsTo(Scan, { foreignKey: 'scanId', as: 'scan' });

User.hasMany(StickerPack, { foreignKey: 'userId', as: 'stickerPacks', onDelete: 'CASCADE' });
StickerPack.belongsTo(User, { foreignKey: 'userId', as: 'user' });

User.hasMany(StickerPurchase, { foreignKey: 'userId', as: 'stickerPurchases', onDelete: 'CASCADE' });
StickerPurchase.belongsTo(User, { foreignKey: 'userId', as: 'user' });

User.hasMany(StickerTransaction, { foreignKey: 'userId', as: 'stickerTransactions', onDelete: 'CASCADE' });
StickerTransaction.belongsTo(User, { foreignKey: 'userId', as: 'user' });
// The ledger keeps its row if the pack, purchase or batch behind it is ever removed.
StickerTransaction.belongsTo(StickerPack, { foreignKey: 'packId', as: 'pack', onDelete: 'SET NULL' });
StickerTransaction.belongsTo(StickerPurchase, { foreignKey: 'purchaseId', as: 'purchase', onDelete: 'SET NULL' });
StickerTransaction.belongsTo(QrBatch, { foreignKey: 'batchId', as: 'batch', onDelete: 'SET NULL' });

User.hasMany(BulkQrBatch, { foreignKey: 'createdBy', as: 'bulkQrBatches', onDelete: 'SET NULL' });
BulkQrBatch.belongsTo(User, { foreignKey: 'createdBy', as: 'creator' });

BulkQrBatch.hasMany(BulkQrScan, { foreignKey: 'batchId', as: 'scans', onDelete: 'CASCADE' });
BulkQrScan.belongsTo(BulkQrBatch, { foreignKey: 'batchId', as: 'batch' });
// A deleted account leaves its scans in place, as a guest's.
User.hasMany(BulkQrScan, { foreignKey: 'userId', as: 'bulkQrScans', onDelete: 'SET NULL' });
BulkQrScan.belongsTo(User, { foreignKey: 'userId', as: 'user' });

User.hasMany(LightQrBatch, { foreignKey: 'createdBy', as: 'lightQrBatches', onDelete: 'SET NULL' });
LightQrBatch.belongsTo(User, { foreignKey: 'createdBy', as: 'creator' });
LightQrBatch.hasMany(LightQrCode, { foreignKey: 'batchId', as: 'codes', onDelete: 'CASCADE' });
LightQrCode.belongsTo(LightQrBatch, { foreignKey: 'batchId', as: 'batch' });
LightQrCode.hasMany(LightQrScan, { foreignKey: 'codeId', as: 'scans', onDelete: 'CASCADE' });
LightQrScan.belongsTo(LightQrCode, { foreignKey: 'codeId', as: 'code' });
LightQrCode.hasMany(LightQrUpdate, { foreignKey: 'codeId', as: 'updates', onDelete: 'CASCADE' });
LightQrUpdate.belongsTo(LightQrCode, { foreignKey: 'codeId', as: 'code' });
// A deleted account leaves its scans as a guest's; its updates go with it.
User.hasMany(LightQrScan, { foreignKey: 'userId', as: 'lightQrScans', onDelete: 'SET NULL' });
LightQrScan.belongsTo(User, { foreignKey: 'userId', as: 'user' });
User.hasMany(LightQrUpdate, { foreignKey: 'userId', as: 'lightQrUpdates', onDelete: 'CASCADE' });
LightQrUpdate.belongsTo(User, { foreignKey: 'userId', as: 'user' });

module.exports = {
  sequelize,
  User,
  Otp,
  ImageFolder,
  ImageAsset,
  QrBatch,
  QrCode,
  Scan,
  ScanReport,
  UserProfileVersion,
  StickerPack,
  StickerPurchase,
  StickerTransaction,
  BulkQrBatch,
  BulkQrScan,
  LightQrBatch,
  LightQrCode,
  LightQrScan,
  LightQrUpdate,
};
