const multer = require('multer');
const { Op, QueryTypes } = require('sequelize');
const { sequelize, User, Producer, ChainBatch, ProducerProduct } = require('../models');
const { accountJson, batchJson } = require('../serialize');
const { batchTotals } = require('../batches');
const { readRetailer, saveRetailer, readSheet, importRetailers, sendTemplate } = require('../retailers');
const { text, fail, httpError } = require('../util');

// Retailers created by a producer (associated with them) or by the superadmin (any producer, or
// general), one by one or from an Excel / CSV sheet — auto-approved. And each QR batch's Sold access.

// The uploaded sheet: memory only, up to 5 MB.
const sheetUpload = (req, res, next) =>
  multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }).single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ message: err.code === 'LIMIT_FILE_SIZE' ? 'The file is larger than 5 MB.' : 'Could not read the upload.' });
    return next();
  });

const OUTCOME_TEXT = {
  created: (n) => `${n} added`,
  upgraded: (n) => `${n} existing app account${n === 1 ? '' : 's'} made retailer${n === 1 ? '' : 's'}`,
  associated: (n) => `${n} general retailer${n === 1 ? '' : 's'} associated`,
  updated: (n) => `${n} already retailer${n === 1 ? '' : 's'} (details updated)`,
};
const importMessage = (r) => {
  const parts = Object.keys(OUTCOME_TEXT).filter((k) => r[k]).map((k) => OUTCOME_TEXT[k](r[k]));
  const done = parts.length ? parts.join(', ') : 'No retailers saved';
  return r.skipped.length ? `${done}. ${r.skipped.length} row${r.skipped.length === 1 ? '' : 's'} skipped — see below.` : `${done}.`;
};
const singleMessage = (user, outcome, producerName) => {
  const label = user.businessName || user.name || user.mobile;
  const whose = producerName ? `a retailer of ${producerName}` : 'a general retailer';
  if (outcome === 'created') return `${label} added as ${whose}.`;
  if (outcome === 'upgraded') return `The existing app account of ${label} is now ${whose}.`;
  if (outcome === 'associated') return `${label} (a general retailer) is now ${whose}.`;
  return `${label} is ${whose}; details updated.`;
};

// ---------- Producer ----------

const pidOf = (req) => req.producer.id;

// Units of this producer each retailer marked sold.
const soldCounts = async (producerId, userIds) => {
  if (!userIds.length) return new Map();
  const rows = await sequelize.query(
    `SELECT u.sold_by_user_id AS userId, COUNT(*) AS n FROM chain_units u JOIN chain_batches b ON b.id = u.batch_id
      WHERE b.producer_id = :pid AND u.sold_by_user_id IN (:ids) GROUP BY u.sold_by_user_id`,
    { replacements: { pid: producerId, ids: userIds }, type: QueryTypes.SELECT }
  );
  return new Map(rows.map((r) => [r.userId, Number(r.n)]));
};

// GET /api/connect/producer/retailers?search=
const listMine = async (req, res) => {
  try {
    const search = text(req.query.search, 100);
    const retailers = await User.findAll({
      where: {
        partnerRole: 'retailer',
        partnerProducerId: pidOf(req),
        ...(search ? { [Op.or]: ['mobile', 'name', 'businessName', 'city', 'email'].map((f) => ({ [f]: { [Op.like]: `%${search}%` } })) } : {}),
      },
      order: [['createdAt', 'DESC']],
      limit: 2000,
    });
    const sold = await soldCounts(pidOf(req), retailers.map((r) => r.id));
    return res.status(200).json({ retailers: retailers.map((r) => ({ ...accountJson(r, req), sold: sold.get(r.id) || 0 })) });
  } catch (err) {
    return fail(res, err, 'Could not load your retailers.');
  }
};

// POST /api/connect/producer/retailers { name, mobile, email?, businessName?, city?, address? }
const createMine = async (req, res) => {
  try {
    const { user, outcome } = await saveRetailer(readRetailer(req.body || {}), pidOf(req), req.user.id);
    return res.status(201).json({ message: singleMessage(user, outcome, req.producer.name), retailer: accountJson(user, req) });
  } catch (err) {
    return fail(res, err, 'Could not add the retailer.');
  }
};

const myRetailer = async (req) => {
  const user = await User.findOne({ where: { id: req.params.id, partnerRole: 'retailer', partnerProducerId: pidOf(req) } });
  if (!user) throw httpError(404, 'Retailer not found.');
  return user;
};

// PUT /api/connect/producer/retailers/:id { name, email?, businessName?, city?, address? } (not the mobile: it's their login)
const updateMine = async (req, res) => {
  try {
    const user = await myRetailer(req);
    const body = req.body || {};
    const fields = readRetailer({ ...body, mobile: user.mobile });
    await user.update({ name: fields.name, email: fields.email, businessName: fields.businessName, city: fields.city, address: fields.address, ...(fields.identity || {}) });
    return res.status(200).json({ message: 'Retailer saved.', retailer: accountJson(user, req) });
  } catch (err) {
    return fail(res, err, 'Could not save the retailer.');
  }
};

// DELETE /api/connect/producer/retailers/:id — no longer this producer's retailer (they stay a
// general retailer).
const removeMine = async (req, res) => {
  try {
    const user = await myRetailer(req);
    await user.update({ partnerProducerId: null });
    return res.status(200).json({ message: `${user.businessName || user.name || user.mobile} is no longer your retailer.` });
  } catch (err) {
    return fail(res, err, 'Could not remove the retailer.');
  }
};

// POST /api/connect/producer/retailers/bulk  multipart: file (.xlsx / .csv)
const importMine = async (req, res) => {
  try {
    const rows = await readSheet(req.file);
    const result = await importRetailers(rows, pidOf(req), req.user.id);
    return res.status(200).json({ message: importMessage(result), result });
  } catch (err) {
    return fail(res, err, 'Could not import the retailers.');
  }
};

// ---------- OriginHash superadmin ----------

// POST /api/connect/admin/retailers/bulk  multipart: file, producerId? (empty = general retailers)
const importAny = async (req, res) => {
  try {
    const producerId = Number(req.body?.producerId) || null;
    if (producerId && !(await Producer.findByPk(producerId, { attributes: ['id'] }))) throw httpError(400, 'Choose one of the producers.', 'producerId');
    const rows = await readSheet(req.file);
    const result = await importRetailers(rows, producerId, req.user.id);
    return res.status(200).json({ message: importMessage(result), result });
  } catch (err) {
    return fail(res, err, 'Could not import the retailers.');
  }
};

// GET …/retailers/template
const template = async (req, res) => {
  try {
    await sendTemplate(res);
  } catch (err) {
    if (!res.headersSent) return fail(res, err, 'Could not prepare the template.');
    return res.end();
  }
};

// ---------- Batch Sold access (producer and superadmin) ----------

const SOLD_ACCESS = ['all', 'producer'];
const batchIncludes = [
  { model: Producer, as: 'producer', attributes: ['id', 'name'] },
  { model: ProducerProduct, as: 'product', attributes: ['id', 'name'] },
];
const setSoldAccess = (scope) => async (req, res) => {
  try {
    const soldAccess = req.body?.soldAccess;
    if (!SOLD_ACCESS.includes(soldAccess)) throw httpError(400, 'Choose who can mark sold.', 'soldAccess');
    const where = { id: req.params.id, ...(scope === 'producer' ? { producerId: pidOf(req) } : {}) };
    const batch = await ChainBatch.findOne({ where, include: batchIncludes });
    if (!batch) throw httpError(404, 'Batch not found.');
    await batch.update({ soldAccess });
    const totals = await batchTotals([batch.id]);
    return res.status(200).json({
      message:
        soldAccess === 'all'
          ? `Every retailer on OriginHash (${batch.producer.name}'s, other producers' and general retailers) can now mark this batch's products sold.`
          : `Only retailers of ${batch.producer.name} can now mark this batch's products sold.`,
      batch: batchJson(batch, totals.get(batch.id)),
    });
  } catch (err) {
    return fail(res, err, 'Could not save who can mark sold.');
  }
};

// PUT …/batches/:id/features { trackingEnabled?, chatEnabled? } — the batch's Tracking and Chat with
// brand switches (producer admin or superadmin).
const FEATURE_NAMES = { trackingEnabled: 'Tracking', chatEnabled: 'Chat with brand' };
const setFeatures = (scope) => async (req, res) => {
  try {
    const body = req.body || {};
    const changes = {};
    for (const key of Object.keys(FEATURE_NAMES)) {
      if (body[key] === undefined) continue;
      if (typeof body[key] !== 'boolean') throw httpError(400, `${FEATURE_NAMES[key]}: on or off.`, key);
      changes[key] = body[key];
    }
    if (!Object.keys(changes).length) throw httpError(400, 'Nothing to change.');
    const where = { id: req.params.id, ...(scope === 'producer' ? { producerId: pidOf(req) } : {}) };
    const batch = await ChainBatch.findOne({ where, include: batchIncludes });
    if (!batch) throw httpError(404, 'Batch not found.');
    await batch.update(changes);
    const totals = await batchTotals([batch.id]);
    const said = Object.entries(changes).map(([k, v]) => `${FEATURE_NAMES[k]} ${v ? 'on' : 'off'}`);
    return res.status(200).json({ message: `${said.join(', ')} for batch ${batch.batchNo}.`, batch: batchJson(batch, totals.get(batch.id)) });
  } catch (err) {
    return fail(res, err, 'Could not save the batch settings.');
  }
};

module.exports = {
  sheetUpload,
  listMine,
  createMine,
  updateMine,
  removeMine,
  importMine,
  importAny,
  template,
  setProducerSoldAccess: setSoldAccess('producer'),
  setAdminSoldAccess: setSoldAccess('admin'),
  setProducerFeatures: setFeatures('producer'),
  setAdminFeatures: setFeatures('admin'),
};
