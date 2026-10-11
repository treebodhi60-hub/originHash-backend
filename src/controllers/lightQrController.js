const crypto = require('crypto');
const { fn, col } = require('sequelize');
const { sequelize, User, LightQrBatch, LightQrCode, LightQrScan, LightQrUpdate } = require('../models');
const { isAdminUser, userCode } = require('../utils/roles');
const { PAGE_SIZE_NAMES, DEFAULT_PER_PAGE, gridFor, maxPerPage } = require('../utils/stickerLayout');
const { labelQrBuffer, streamQrLabelPdf } = require('../utils/stickerPdf');
const { nameLightScanLocation, nameLightUpdateLocation } = require('../utils/locationNames');
const { reverseGeocode } = require('../services/geocodeService');
const { uploadFileToS3, signedUrlFor } = require('../services/s3Service');
const { billingConfig, lockUser, refreshPacks, balanceOf, useStickers } = require('../services/stickerService');

const MAX_QUANTITY = 5000;
const SPLIT = 'bulk'; // light labels are the same size and design as bulk ones
const LOCATION_WINDOW_MS = 15 * 60 * 1000;
const COMMENT_MAX = 500;

// The printed ID of a code: QR-00427.
const displayCode = (id) => `QR-${String(id).padStart(5, '0')}`;

// 10 characters from an alphabet without look-alikes (no 0/O, 1/I/L): about 10^15 possibilities.
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const newToken = () => Array.from(crypto.randomBytes(10), (b) => ALPHABET[b % ALPHABET.length]).join('');

// The QR opens the code's public page; a bare token (no app URL set) is still read by the in-app scanner.
const lightQrPayload = (token) => {
  const appUrl = (process.env.PUBLIC_APP_URL || '').replace(/\/+$/, '');
  return appUrl ? `${appUrl}/l/${token}` : `OHL-${token}`;
};

const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const coordinate = (value, limit) => {
  const n = Number(value);
  return value !== null && value !== undefined && value !== '' && Number.isFinite(n) && Math.abs(n) <= limit ? n : null;
};
const locationJson = (row) =>
  row.latitude !== null && row.longitude !== null
    ? { latitude: Number(row.latitude), longitude: Number(row.longitude), name: row.locationName ?? null }
    : null;
const personJson = (user) =>
  user ? { id: user.id, code: userCode(user.id), name: user.name || user.username || null, userType: user.userType || null } : null;

const canManage = (user, batch) => isAdminUser(user) || (Boolean(batch.createdBy) && batch.createdBy === user?.id);

const batchJson = (b, totals = {}) => ({
  id: b.id,
  brandName: b.brandName,
  productName: b.productName,
  batchNo: b.batchNo,
  packSize: b.packSize,
  quantity: b.quantity,
  pageSize: b.pageSize,
  labelsPerPage: b.labelsPerPage,
  createdAt: b.createdAt,
  createdBy: b.createdBy,
  creatorName: b.creator ? b.creator.name || b.creator.username || null : undefined,
  scanCount: Number(totals.scans || 0),
  updateCount: Number(totals.updates || 0),
  scannedCodes: Number(totals.scanned || 0),
  firstCode: totals.firstId ? displayCode(totals.firstId) : null,
  lastCode: totals.lastId ? displayCode(totals.lastId) : null,
});

// Per batch: scans, updates, codes scanned at least once, and the first and last code IDs.
const batchTotals = async (batchIds) => {
  if (!batchIds.length) return new Map();
  const rows = await LightQrCode.findAll({
    where: { batchId: batchIds },
    attributes: [
      'batchId',
      [fn('SUM', col('scan_count')), 'scans'],
      [fn('SUM', col('update_count')), 'updates'],
      [fn('SUM', sequelize.literal('scan_count > 0')), 'scanned'],
      [fn('MIN', col('id')), 'firstId'],
      [fn('MAX', col('id')), 'lastId'],
    ],
    group: ['batchId'],
    raw: true,
  });
  return new Map(rows.map((r) => [r.batchId, r]));
};

// ---------- The creator's side ----------

// POST /api/light-qr — a batch of unique QR codes.
const createLightBatch = async (req, res) => {
  try {
    const body = req.body || {};
    const brandName = text(body.brandName, 120);
    const productName = text(body.productName, 160);
    const batchNo = text(body.batchNo, 80);
    const packSize = text(body.packSize, 60);
    if (!brandName || !productName || !batchNo || !packSize) {
      return res.status(400).json({ message: 'Brand name, product name, batch and pack size are required.' });
    }
    const quantity = Number(body.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
      return res.status(400).json({ message: `Generate between 1 and ${MAX_QUANTITY.toLocaleString('en-IN')} QR codes.`, field: 'quantity' });
    }
    const pageSize = body.pageSize || 'A4';
    if (!PAGE_SIZE_NAMES.includes(pageSize)) return res.status(400).json({ message: 'Paper size must be A4 or A3.' });
    const labelsPerPage = body.labelsPerPage == null ? DEFAULT_PER_PAGE : Number(body.labelsPerPage);
    const most = maxPerPage(pageSize, SPLIT);
    if (!Number.isInteger(labelsPerPage) || labelsPerPage < 1 || labelsPerPage > most) {
      return res.status(400).json({ message: `Labels per page must be between 1 and ${most}.`, field: 'labelsPerPage' });
    }

    // Once billing is on, each code takes one sticker from the user's Light QR balance.
    const billing = billingConfig().enabled;

    // All or nothing; a token clash is vanishingly rare, so try the whole batch again.
    let batch = null;
    let shortOf = null;
    for (let attempt = 0; !batch && !shortOf && attempt < 3; attempt += 1) {
      try {
        batch = await sequelize.transaction(async (transaction) => {
          let packs = null;
          if (billing) {
            // The user is locked until the end: the check and taking the stickers commit together.
            await lockUser(req.user.id, transaction);
            packs = await refreshPacks(req.user.id, transaction);
            const available = balanceOf(packs, 'LIGHT');
            if (available < quantity) {
              shortOf = { available };
              return null;
            }
          }
          const made = await LightQrBatch.create(
            { brandName, productName, batchNo, packSize, quantity, pageSize, labelsPerPage, createdBy: req.user.id },
            { transaction }
          );
          const tokens = new Set();
          while (tokens.size < quantity) tokens.add(newToken());
          const codes = [...tokens].map((token, i) => ({ batchId: made.id, sequenceNo: i + 1, token }));
          for (let i = 0; i < codes.length; i += 1000) await LightQrCode.bulkCreate(codes.slice(i, i + 1000), { transaction });
          if (packs) await useStickers(packs, 'LIGHT', quantity, { batchNo, label: 'Light batch' }, transaction);
          return made;
        });
      } catch (err) {
        if (err.name !== 'SequelizeUniqueConstraintError') throw err;
      }
    }
    if (shortOf) {
      return res.status(402).json({
        code: 'INSUFFICIENT_STICKERS',
        available: shortOf.available,
        message: `Not enough light QR stickers: this batch needs ${quantity.toLocaleString('en-IN')} and your balance has ${shortOf.available.toLocaleString('en-IN')}. Buy more to continue.`,
      });
    }
    if (!batch) return res.status(500).json({ message: 'Could not create the batch. Please try again.' });

    const totals = await batchTotals([batch.id]);
    return res.status(201).json({
      message: `${quantity.toLocaleString('en-IN')} unique QR codes ready.`,
      batch: batchJson(batch, totals.get(batch.id)),
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Could not generate the QR codes.' });
  }
};

// GET /api/light-qr — the user's batches (every user's for admins), newest first, with totals.
const listLightBatches = async (req, res) => {
  try {
    const admin = isAdminUser(req.user);
    const batches = await LightQrBatch.findAll({
      where: admin ? {} : { createdBy: req.user.id },
      include: admin ? [{ model: User, as: 'creator', attributes: ['id', 'name', 'username'] }] : [],
      order: [['createdAt', 'DESC']],
      limit: 1000,
    });
    const totals = await batchTotals(batches.map((b) => b.id));
    return res.status(200).json({ batches: batches.map((b) => batchJson(b, totals.get(b.id))) });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Could not load your batches.' });
  }
};

// GET /api/light-qr/:id — one batch and every code in it, with each code's activity.
const getLightBatch = async (req, res) => {
  try {
    const batch = await LightQrBatch.findByPk(req.params.id, {
      include: [{ model: User, as: 'creator', attributes: ['id', 'name', 'username'] }],
    });
    if (!batch || !canManage(req.user, batch)) return res.status(404).json({ message: 'Batch not found.' });
    const [codes, totals] = await Promise.all([
      LightQrCode.findAll({ where: { batchId: batch.id }, order: [['sequenceNo', 'ASC']] }),
      batchTotals([batch.id]),
    ]);
    return res.status(200).json({
      batch: batchJson(batch, totals.get(batch.id)),
      codes: codes.map((c) => ({
        id: c.id,
        code: displayCode(c.id),
        token: c.token,
        sequenceNo: c.sequenceNo,
        scanCount: c.scanCount,
        updateCount: c.updateCount,
        lastScannedAt: c.lastScannedAt,
      })),
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Could not load this batch.' });
  }
};

const labelFor = (batch, code) => async () => ({
  heading: `${batch.brandName}  ·  Batch ${batch.batchNo}`,
  number: displayCode(code.id),
  qrBuffer: await labelQrBuffer(lightQrPayload(code.token), 360),
});

// GET /api/light-qr/:id/pdf — every code of the batch as a label; GET /api/light-qr/codes/:codeId/pdf
// — just one. Same layout, cut lines and design as the other sticker PDFs.
const sendLabels = async (res, batch, codes, fileName) =>
  streamQrLabelPdf(res, {
    layout: gridFor(batch.pageSize, SPLIT, codes.length === 1 ? 1 : batch.labelsPerPage),
    count: codes.length,
    title: 'Light QR stickers',
    subtitle: `${batch.brandName} · ${batch.productName} · Batch ${batch.batchNo} · ${batch.pageSize}`,
    fileName,
    labelAt: async (i, doc) => {
      const { heading, number, qrBuffer } = await labelFor(batch, codes[i])();
      return { heading, number, qrImage: doc.openImage(qrBuffer) };
    },
  });

const safeName = (s) => s.replace(/[^a-zA-Z0-9-]+/g, '_');

const downloadLightPdf = async (req, res) => {
  try {
    const batch = await LightQrBatch.findByPk(req.params.id);
    if (!batch || !canManage(req.user, batch)) return res.status(404).json({ message: 'Batch not found.' });
    const codes = await LightQrCode.findAll({ where: { batchId: batch.id }, order: [['sequenceNo', 'ASC']] });
    await sendLabels(res, batch, codes, `${safeName(batch.batchNo)}-light-qr-${batch.pageSize}.pdf`);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ message: 'Could not generate the PDF.' });
    else res.end();
  }
};

const downloadLightCodePdf = async (req, res) => {
  try {
    const code = await LightQrCode.findByPk(req.params.codeId, { include: [{ model: LightQrBatch, as: 'batch' }] });
    if (!code || !canManage(req.user, code.batch)) return res.status(404).json({ message: 'QR code not found.' });
    await sendLabels(res, code.batch, [code], `${displayCode(code.id)}.pdf`);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ message: 'Could not generate the PDF.' });
    else res.end();
  }
};

// ---------- The public side: what a code's QR opens ----------

const findCode = (token) =>
  /^[A-Z0-9]{10}$/.test(String(token || '').toUpperCase())
    ? LightQrCode.findOne({ where: { token: String(token).toUpperCase() }, include: [{ model: LightQrBatch, as: 'batch' }] })
    : null;

const updateJson = (u) => ({
  id: u.id,
  at: u.createdAt,
  comment: u.comment,
  photoUrl: signedUrlFor(u.photoUrl),
  location: locationJson(u),
  user: personJson(u.user),
});

// GET /api/light-qr/public/:token — the product, the code's ID, and (for a signed-in user) whether
// they've already added their update and may see the history. Reading isn't a scan.
const getPublicCode = async (req, res) => {
  try {
    const code = await findCode(req.params.token);
    if (!code) return res.status(404).json({ message: 'This QR code was not found.' });
    const { batch } = code;
    const mine = req.user
      ? await LightQrUpdate.findOne({ where: { codeId: code.id, userId: req.user.id }, include: [{ model: User, as: 'user' }] })
      : null;
    return res.status(200).json({
      code: displayCode(code.id),
      token: code.token,
      brandName: batch.brandName,
      productName: batch.productName,
      batchNo: batch.batchNo,
      packSize: batch.packSize,
      generatedAt: code.createdAt,
      signedIn: Boolean(req.user),
      canSeeHistory: Boolean(req.user) && canManage(req.user, batch),
      myUpdate: mine ? updateJson(mine) : null,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Could not load this QR code.' });
  }
};

// POST /api/light-qr/public/:token/scans — the page records that the code was scanned (by whom,
// when signed in). Returns a token the same page uses to add the location.
const recordLightScan = async (req, res) => {
  try {
    const code = await findCode(req.params.token);
    if (!code) return res.status(404).json({ message: 'This QR code was not found.' });
    const scan = await LightQrScan.create({ codeId: code.id, userId: req.user?.id ?? null, token: crypto.randomUUID() });
    await code.increment('scanCount', { silent: true });
    await code.update({ lastScannedAt: scan.createdAt }, { silent: true });
    return res.status(201).json({ scanToken: scan.token, scannedAt: scan.createdAt });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Could not record the scan.' });
  }
};

// The place name now (waiting a few seconds at most), so the page can show it straight away;
// left for the background lookup if it takes longer.
const placeNameSoon = (latitude, longitude) =>
  Promise.race([reverseGeocode(latitude, longitude).catch(() => null), new Promise((r) => setTimeout(() => r(null), 5000))]);

// PATCH /api/light-qr/public/scans/:scanToken/location — where a scan just recorded happened.
const addLightScanLocation = async (req, res) => {
  try {
    const latitude = coordinate(req.body?.latitude, 90);
    const longitude = coordinate(req.body?.longitude, 180);
    if (latitude === null || longitude === null) return res.status(400).json({ message: 'Invalid location.' });
    const scan = /^[0-9a-f-]{36}$/i.test(req.params.scanToken || '')
      ? await LightQrScan.findOne({ where: { token: req.params.scanToken } })
      : null;
    if (!scan || scan.latitude !== null || Date.now() - scan.createdAt > LOCATION_WINDOW_MS) {
      return res.status(404).json({ message: 'Scan not found.' });
    }
    const locationName = await placeNameSoon(latitude, longitude);
    await scan.update({ latitude, longitude, locationName });
    if (!locationName) nameLightScanLocation(scan);
    return res.status(200).json({ location: locationJson(scan) });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Could not save the location.' });
  }
};

// POST /api/light-qr/public/:token/updates  multipart: photo, comment, latitude?, longitude?
// A signed-in user's one photo and comment on this code.
const addLightUpdate = async (req, res) => {
  try {
    const code = await findCode(req.params.token);
    if (!code) return res.status(404).json({ message: 'This QR code was not found.' });
    const comment = text(req.body?.comment, COMMENT_MAX + 1);
    if (!req.file) return res.status(400).json({ message: 'Add a photo.', field: 'photo' });
    if (!comment) return res.status(400).json({ message: 'Write a comment.', field: 'comment' });
    if (comment.length > COMMENT_MAX) return res.status(400).json({ message: `Keep the comment to ${COMMENT_MAX} characters.`, field: 'comment' });
    if (await LightQrUpdate.findOne({ where: { codeId: code.id, userId: req.user.id }, attributes: ['id'] })) {
      return res.status(409).json({ message: "You've already added your update to this QR code." });
    }

    let photoUrl;
    try {
      photoUrl = await uploadFileToS3(req.file, 'light-qr-updates');
    } catch (err) {
      console.error('Light QR photo upload failed:', err.message);
      return res.status(502).json({ message: "Couldn't upload the photo. Please try again." });
    }

    const latitude = coordinate(req.body?.latitude, 90);
    const longitude = coordinate(req.body?.longitude, 180);
    const located = latitude !== null && longitude !== null;
    let update;
    try {
      update = await LightQrUpdate.create({
        codeId: code.id,
        userId: req.user.id,
        photoUrl,
        comment,
        latitude: located ? latitude : null,
        longitude: located ? longitude : null,
        locationName: located ? await placeNameSoon(latitude, longitude) : null,
      });
    } catch (err) {
      // Two saves at once from the same user: the second one loses.
      if (err.name === 'SequelizeUniqueConstraintError') {
        return res.status(409).json({ message: "You've already added your update to this QR code." });
      }
      throw err;
    }
    await code.increment('updateCount', { silent: true });
    if (located && !update.locationName) nameLightUpdateLocation(update);
    update.user = req.user;
    return res.status(201).json({ message: 'Update saved.', update: updateJson(update) });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Could not save your update.' });
  }
};

// GET /api/light-qr/public/:token/history — the code's journey, oldest first: created, every scan,
// every update. Admins, super-admins and the user who generated the batch only.
const getLightHistory = async (req, res) => {
  try {
    const code = await findCode(req.params.token);
    if (!code) return res.status(404).json({ message: 'This QR code was not found.' });
    if (!canManage(req.user, code.batch)) {
      return res.status(403).json({ message: 'Only the person who generated this batch and OriginHash admins can see its history.' });
    }
    const [scans, updates] = await Promise.all([
      LightQrScan.findAll({ where: { codeId: code.id }, include: [{ model: User, as: 'user' }], order: [['id', 'ASC']] }),
      LightQrUpdate.findAll({ where: { codeId: code.id }, include: [{ model: User, as: 'user' }], order: [['id', 'ASC']] }),
    ]);
    scans.filter((s) => s.latitude !== null && !s.locationName).slice(0, 20).forEach(nameLightScanLocation);
    updates.filter((u) => u.latitude !== null && !u.locationName).slice(0, 20).forEach(nameLightUpdateLocation);

    const { batch } = code;
    const events = [
      { type: 'CREATED', at: code.createdAt, batchNo: batch.batchNo },
      ...scans.map((s) => ({ type: 'SCAN', id: `s${s.id}`, at: s.createdAt, user: personJson(s.user), location: locationJson(s) })),
      ...updates.map((u) => ({ type: 'UPDATE', id: `u${u.id}`, ...updateJson(u) })),
    ].sort((a, b) => new Date(a.at) - new Date(b.at));

    return res.status(200).json({
      code: displayCode(code.id),
      token: code.token,
      brandName: batch.brandName,
      productName: batch.productName,
      batchNo: batch.batchNo,
      packSize: batch.packSize,
      generatedAt: code.createdAt,
      batchId: batch.id,
      scanCount: scans.length,
      updateCount: updates.length,
      events,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Could not load the history.' });
  }
};

module.exports = {
  createLightBatch,
  listLightBatches,
  getLightBatch,
  downloadLightPdf,
  downloadLightCodePdf,
  getPublicCode,
  recordLightScan,
  addLightScanLocation,
  addLightUpdate,
  getLightHistory,
};
