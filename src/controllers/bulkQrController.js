const crypto = require('crypto');
const { BulkQrBatch, BulkQrScan, User } = require('../models');
const { isAdminUser, userCode } = require('../utils/roles');
const { nameBulkScanLocation } = require('../utils/locationNames');
const { PAGE_SIZE_NAMES, DEFAULT_PER_PAGE, gridFor, maxPerPage } = require('../utils/stickerLayout');
const { labelQrBuffer, streamQrLabelPdf } = require('../utils/stickerPdf');

const MAX_QUANTITY = 5000;
const SCANS_SHOWN = 5000; // newest scans listed on a batch's page
const LOCATION_WINDOW_MS = 15 * 60 * 1000; // a scan's location can be added this long after it
const SPLIT = 'bulk';

// What the QR is for. Shown on the details page the QR opens.
const PURPOSES = {
  PRODUCT_AUTHENTICATION: 'Product authentication',
  PRODUCT_INFORMATION: 'Product information',
  TRACEABILITY: 'Traceability',
  MARKETING: 'Marketing & promotions',
  WARRANTY: 'Warranty registration',
};

// OHB- plus 8 characters from an alphabet without look-alikes (no 0/O, 1/I/L), e.g. OHB-7K2M9QXA.
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const newCode = () => `OHB-${Array.from(crypto.randomBytes(8), (b) => ALPHABET[b % ALPHABET.length]).join('')}`;

// The QR opens the public details page; a bare code (no app URL set) is still read by the in-app scanner.
const bulkQrPayload = (code) => {
  const appUrl = (process.env.PUBLIC_APP_URL || '').replace(/\/+$/, '');
  return appUrl ? `${appUrl}/b/${encodeURIComponent(code)}` : code;
};

const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

const batchJson = (b) => ({
  id: b.id,
  code: b.code,
  brandName: b.brandName,
  productName: b.productName,
  batchNo: b.batchNo,
  packSize: b.packSize,
  purpose: b.purpose,
  purposeLabel: b.purpose ? PURPOSES[b.purpose] : null,
  expiryDate: b.expiryDate,
  quantity: b.quantity,
  pageSize: b.pageSize,
  labelsPerPage: b.labelsPerPage,
  scanCount: b.scanCount,
  lastScannedAt: b.lastScannedAt,
  createdAt: b.createdAt,
  createdBy: b.createdBy,
  creatorName: b.creator ? b.creator.name || b.creator.username || null : undefined,
});

// POST /api/bulk-qr — a new run of identical QR labels.
const createBulkBatch = async (req, res) => {
  try {
    const body = req.body || {};
    const brandName = text(body.brandName, 120);
    const productName = text(body.productName, 160);
    const batchNo = text(body.batchNo, 80);
    const packSize = text(body.packSize, 60);
    if (!brandName || !productName || !batchNo || !packSize) {
      return res.status(400).json({ message: 'Brand name, product name, batch and pack size are required.' });
    }

    const purpose = body.purpose || null;
    if (purpose && !PURPOSES[purpose]) return res.status(400).json({ message: 'Choose a valid QR code purpose.' });

    let expiryDate = null;
    if (body.expiryDate) {
      const valid = /^\d{4}-\d{2}-\d{2}$/.test(body.expiryDate) && !Number.isNaN(new Date(`${body.expiryDate}T00:00:00Z`).getTime());
      if (!valid) return res.status(400).json({ message: 'Enter the expiry date as a valid date.' });
      expiryDate = body.expiryDate;
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

    // A clash on the random code is vanishingly rare; try again rather than fail.
    let batch = null;
    for (let attempt = 0; !batch && attempt < 5; attempt += 1) {
      try {
        batch = await BulkQrBatch.create({
          code: newCode(),
          brandName,
          productName,
          batchNo,
          packSize,
          purpose,
          expiryDate,
          quantity,
          pageSize,
          labelsPerPage,
          createdBy: req.user.id,
        });
      } catch (err) {
        if (err.name !== 'SequelizeUniqueConstraintError') throw err;
      }
    }
    if (!batch) return res.status(500).json({ message: 'Could not create the batch. Please try again.' });

    return res.status(201).json({ message: `${quantity.toLocaleString('en-IN')} identical QR codes ready.`, batch: batchJson(batch) });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Could not generate the QR codes.' });
  }
};

// GET /api/bulk-qr — the user's bulk batches (every user's for admins), newest first.
const listBulkBatches = async (req, res) => {
  try {
    const admin = isAdminUser(req.user);
    const batches = await BulkQrBatch.findAll({
      where: admin ? {} : { createdBy: req.user.id },
      include: admin ? [{ model: User, as: 'creator', attributes: ['id', 'name', 'username'] }] : [],
      order: [['createdAt', 'DESC']],
      limit: 1000,
    });
    return res.status(200).json({ batches: batches.map(batchJson) });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Could not load your bulk QR batches.' });
  }
};

const findByCode = (raw) => {
  const code = String(raw || '').toUpperCase();
  return /^OHB-[A-Z0-9]{8}$/.test(code) ? BulkQrBatch.findOne({ where: { code } }) : null;
};

// Coordinates from the browser, or null when missing or out of range.
const coordinate = (value, limit) => {
  const n = Number(value);
  return value !== null && value !== undefined && value !== '' && Number.isFinite(n) && Math.abs(n) <= limit ? n : null;
};

// GET /api/bulk-qr/public/:code — what the QR opens. Public: anyone holding the product can read it.
// Reading doesn't count as a scan; the page records one with POST …/scans.
const getPublicBulkBatch = async (req, res) => {
  try {
    const batch = await findByCode(req.params.code);
    if (!batch) return res.status(404).json({ message: 'This QR code was not found.' });

    const today = new Date().toISOString().slice(0, 10);
    return res.status(200).json({
      code: batch.code,
      brandName: batch.brandName,
      productName: batch.productName,
      batchNo: batch.batchNo,
      packSize: batch.packSize,
      purpose: batch.purpose,
      purposeLabel: batch.purpose ? PURPOSES[batch.purpose] : null,
      expiryDate: batch.expiryDate,
      expired: Boolean(batch.expiryDate && batch.expiryDate < today),
      quantity: batch.quantity,
      generatedAt: batch.createdAt,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Could not load this QR code.' });
  }
};

// POST /api/bulk-qr/public/:code/scans  { latitude?, longitude? } — the page records that it was
// opened: by whom when signed in (optional sign-in), and where when the location is already known.
// Returns a token the same page uses to add the location once the browser shares it.
const recordBulkScan = async (req, res) => {
  try {
    const batch = await findByCode(req.params.code);
    if (!batch) return res.status(404).json({ message: 'This QR code was not found.' });
    const latitude = coordinate(req.body?.latitude, 90);
    const longitude = coordinate(req.body?.longitude, 180);
    const located = latitude !== null && longitude !== null;
    const scan = await BulkQrScan.create({
      batchId: batch.id,
      userId: req.user?.id ?? null,
      token: crypto.randomUUID(),
      latitude: located ? latitude : null,
      longitude: located ? longitude : null,
    });
    await batch.increment('scanCount', { silent: true });
    await batch.update({ lastScannedAt: scan.createdAt }, { silent: true });
    if (located) nameBulkScanLocation(scan);
    return res.status(201).json({ scanToken: scan.token });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Could not record the scan.' });
  }
};

// PATCH /api/bulk-qr/public/scans/:token/location  { latitude, longitude } — the location for a
// scan just recorded, once the person allows it. Only that page has the token, only once, and
// only shortly after the scan.
const addBulkScanLocation = async (req, res) => {
  try {
    const latitude = coordinate(req.body?.latitude, 90);
    const longitude = coordinate(req.body?.longitude, 180);
    if (latitude === null || longitude === null) return res.status(400).json({ message: 'Invalid location.' });
    const scan = /^[0-9a-f-]{36}$/i.test(req.params.token || '') ? await BulkQrScan.findOne({ where: { token: req.params.token } }) : null;
    if (!scan || scan.latitude !== null || Date.now() - scan.createdAt > LOCATION_WINDOW_MS) {
      return res.status(404).json({ message: 'Scan not found.' });
    }
    await scan.update({ latitude, longitude });
    nameBulkScanLocation(scan);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Could not save the location.' });
  }
};

const scanJson = (scan) => ({
  id: scan.id,
  at: scan.createdAt,
  user: scan.user
    ? { id: scan.user.id, code: userCode(scan.user.id), name: scan.user.name || scan.user.username || null, userType: scan.user.userType || null }
    : null,
  location:
    scan.latitude !== null && scan.longitude !== null
      ? { latitude: Number(scan.latitude), longitude: Number(scan.longitude), name: scan.locationName ?? null }
      : null,
});

// GET /api/bulk-qr/:id — one batch with everyone who scanned it (newest first): the creator's own
// batches, any batch for admins.
const getBulkBatch = async (req, res) => {
  try {
    const admin = isAdminUser(req.user);
    const batch = await BulkQrBatch.findByPk(req.params.id, {
      include: [{ model: User, as: 'creator', attributes: ['id', 'name', 'username'] }],
    });
    if (!batch || (!admin && batch.createdBy !== req.user.id)) return res.status(404).json({ message: 'Batch not found.' });

    const scans = await BulkQrScan.findAll({
      where: { batchId: batch.id },
      include: [{ model: User, as: 'user', attributes: ['id', 'name', 'username', 'userType'] }],
      order: [['id', 'DESC']],
      limit: SCANS_SHOWN,
    });
    // Name any locations still waiting for a place name (in the background; rate-limited).
    scans.filter((s) => s.latitude !== null && !s.locationName).slice(0, 25).forEach(nameBulkScanLocation);

    return res.status(200).json({ batch: batchJson(batch), scans: scans.map(scanJson), total: batch.scanCount, limit: SCANS_SHOWN });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Could not load this batch.' });
  }
};

// ---------- PDF ----------

// GET /api/bulk-qr/:id/pdf — every label of the batch, on its paper size and labels per page.
// The same QR on every label: embedded once, placed many times; each label has its own number.
const downloadBulkPdf = async (req, res) => {
  try {
    const batch = await BulkQrBatch.findByPk(req.params.id);
    if (!batch || (!isAdminUser(req.user) && batch.createdBy !== req.user.id)) {
      return res.status(404).json({ message: 'Batch not found.' });
    }
    const qrBuffer = await labelQrBuffer(bulkQrPayload(batch.code));
    const digits = Math.max(4, String(batch.quantity).length);
    let qrImage = null;
    await streamQrLabelPdf(res, {
      layout: gridFor(batch.pageSize, SPLIT, batch.labelsPerPage),
      count: batch.quantity,
      title: 'Bulk QR stickers',
      subtitle: `${batch.brandName} · ${batch.productName} · Batch ${batch.batchNo} · ${batch.pageSize}`,
      fileName: `${batch.batchNo.replace(/[^a-zA-Z0-9-]+/g, '_')}-bulk-qr-${batch.pageSize}.pdf`,
      labelAt: (i, doc) => {
        qrImage ||= doc.openImage(qrBuffer);
        return {
          heading: `${batch.brandName}  ·  Batch ${batch.batchNo}`,
          number: `${batch.code}  ·  No. ${String(i + 1).padStart(digits, '0')}`,
          qrImage,
        };
      },
    });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ message: 'Could not generate the PDF.' });
    else res.end();
  }
};

module.exports = {
  PURPOSES,
  createBulkBatch,
  listBulkBatches,
  getBulkBatch,
  getPublicBulkBatch,
  recordBulkScan,
  addBulkScanLocation,
  downloadBulkPdf,
};
