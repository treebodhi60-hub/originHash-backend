const { fn, col, literal } = require('sequelize');
const { sequelize, ChainBatch, ChainUnit } = require('./models');
const { newToken, newCoupon, serialOf, retailerQrUrl, consumerQrUrl, httpError } = require('./util');
const { pairGridFor, pairSlot, pairBlock, PAGE_SIZE_NAMES, PAIR_ORIENTATIONS, MAX_BULK_PER_PAGE } = require('../utils/stickerLayout');
const QRCode = require('qrcode');
const { labelQrBuffer, streamQrLabelPdf } = require('../utils/stickerPdf');

// Allotting QR batches to producers, and printing them. Every unit is a pair: a retailer QR and
// a consumer QR (so a batch of N units is 2N QR codes), plus a unique coupon code when the batch
// carries a discount.

const MAX_QUANTITY = 5000;

// Batch numbers are typed in by the producer (in a request) or the superadmin (when allotting) and
// don't have to be unique. The OriginHash sequence (OHB-0001, OHB-0002…) is the suggestion, and the
// number used when none is entered. Its counter is a row in oh_sequences, bumped inside the
// allotment's transaction (concurrent allotments wait on that row; a failed one rolls it back).
// Without a transaction, `nextBatchNo()` only peeks — for forms to suggest the number.
const batchNoOf = (n) => `OHB-${String(n).padStart(4, '0')}`;
const nextBatchNo = async (transaction) => {
  if (!transaction) {
    const [rows] = await sequelize.query("SELECT value FROM oh_sequences WHERE name = 'batch_no'");
    return batchNoOf(Number(rows[0]?.value || 0) + 1);
  }
  await sequelize.query(
    "INSERT INTO oh_sequences (name, value) VALUES ('batch_no', LAST_INSERT_ID(1)) ON DUPLICATE KEY UPDATE value = LAST_INSERT_ID(value + 1)",
    { transaction }
  );
  const [rows] = await sequelize.query('SELECT LAST_INSERT_ID() AS n', { transaction });
  return batchNoOf(Number(rows[0].n));
};

// The number a new batch gets: the one typed in, else the next in the sequence. A typed OHB- number
// moves the counter past it, so the next suggestion doesn't repeat it.
const batchNoToUse = async (typed, transaction) => {
  if (!typed) return nextBatchNo(transaction);
  const m = /^OHB-(\d+)$/i.exec(typed);
  if (m) {
    await sequelize.query(
      "INSERT INTO oh_sequences (name, value) VALUES ('batch_no', :n) ON DUPLICATE KEY UPDATE value = GREATEST(value, :n)",
      { replacements: { n: Number(m[1]) }, transaction }
    );
  }
  return typed;
};

// Creates the batch and its units in one transaction. A token or coupon clash is vanishingly rare,
// so on one the whole batch is simply tried again. Resolves to the batch.
const allotBatch = async ({ producerId, productId = null, batchNo: typedBatchNo = null, quantity, maxDiscountPercent, expiryDate, notes = null, allottedBy }, outer) => {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
    throw httpError(400, `A batch can have between 1 and ${MAX_QUANTITY.toLocaleString('en-IN')} units.`, 'quantity');
  }
  const run = async (transaction) => {
    const batchNo = await batchNoToUse(typedBatchNo, transaction);
    const batch = await ChainBatch.create(
      { producerId, productId, batchNo, quantity, maxDiscountPercent, expiryDate, notes, allottedBy },
      { transaction }
    );
    const tokens = new Set();
    while (tokens.size < quantity * 2) tokens.add(newToken());
    const list = [...tokens];
    const coupons = new Set();
    if (maxDiscountPercent) while (coupons.size < quantity) coupons.add(newCoupon());
    const couponList = [...coupons];
    const units = Array.from({ length: quantity }, (_, i) => ({
      batchId: batch.id,
      serialNo: i + 1,
      retailerToken: list[i * 2],
      consumerToken: list[i * 2 + 1],
      couponCode: maxDiscountPercent ? couponList[i] : null,
      discountPercent: maxDiscountPercent || null,
    }));
    for (let i = 0; i < units.length; i += 1000) await ChainUnit.bulkCreate(units.slice(i, i + 1000), { transaction });
    return batch;
  };

  if (outer) return run(outer);
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await sequelize.transaction(run);
    } catch (err) {
      if (err.name !== 'SequelizeUniqueConstraintError' || attempt >= 2) throw err;
    }
  }
};

// Per batch: units sold, scans, coupons claimed, and the first and last unit IDs.
const batchTotals = async (batchIds) => {
  if (!batchIds.length) return new Map();
  const rows = await ChainUnit.findAll({
    where: { batchId: batchIds },
    attributes: [
      'batchId',
      [fn('SUM', literal("status = 'sold'")), 'sold'],
      [fn('SUM', col('consumer_scan_count')), 'consumerScans'],
      [fn('SUM', col('trade_scan_count')), 'tradeScans'],
      [fn('SUM', literal('coupon_claimed_by IS NOT NULL')), 'claimed'],
      [fn('MIN', col('id')), 'firstId'],
      [fn('MAX', col('id')), 'lastId'],
    ],
    group: ['batchId'],
    raw: true,
  });
  return new Map(rows.map((r) => [r.batchId, r]));
};

const safeName = (s) => String(s).replace(/[^a-zA-Z0-9-]+/g, '_');

// The batch's print layout (set by the OriginHash superadmin): paper, QR labels per page (even, so
// pairs never split) and orientation. Default A4, 40 per page, horizontal.
const PRINT_DEFAULTS = { pageSize: 'A4', perPage: 40, orientation: 'horizontal' };
const layoutOf = (batch) => ({
  pageSize: PAGE_SIZE_NAMES.includes(batch.printPageSize) ? batch.printPageSize : PRINT_DEFAULTS.pageSize,
  perPage: batch.printPerPage || PRINT_DEFAULTS.perPage,
  orientation: PAIR_ORIENTATIONS.includes(batch.printOrientation) ? batch.printOrientation : PRINT_DEFAULTS.orientation,
});

// { pageSize, perPage, orientation } from a request body, checked; resolves to the batch columns.
const readPrintLayout = (body = {}) => {
  const pageSize = body.pageSize || PRINT_DEFAULTS.pageSize;
  if (!PAGE_SIZE_NAMES.includes(pageSize)) throw httpError(400, 'Choose A4 or A3.', 'pageSize');
  const perPage = Number(body.perPage ?? PRINT_DEFAULTS.perPage);
  if (!Number.isInteger(perPage) || perPage < 2 || perPage > MAX_BULK_PER_PAGE || perPage % 2) {
    throw httpError(400, `QR codes per page: an even number from 2 to ${MAX_BULK_PER_PAGE}.`, 'perPage');
  }
  const orientation = body.orientation || PRINT_DEFAULTS.orientation;
  if (!PAIR_ORIENTATIONS.includes(orientation)) throw httpError(400, 'Choose horizontal or vertical.', 'orientation');
  return { printPageSize: pageSize, printPerPage: perPage, printOrientation: orientation };
};

const streamBatchPdf = async (res, batch, producerName, units) => {
  const { pageSize, perPage, orientation } = layoutOf(batch);
  const layout = pairGridFor(pageSize, perPage, orientation);
  return streamQrLabelPdf(res, {
    layout,
    count: units.length * 2,
    title: 'Retailer + consumer QR pairs',
    subtitle: `${producerName} · Batch ${batch.batchNo} · ${units.length} units`,
    fileName: `${safeName(batch.batchNo)}-qr-pairs.pdf`,
    slotOf: (n) => pairSlot(layout, n),
    cutSlots: (k) => pairBlock(layout, k),
    labelAt: async (i, doc) => {
      const unit = units[Math.floor(i / 2)];
      const retailer = i % 2 === 0;
      const url = retailer ? retailerQrUrl(unit.retailerToken) : consumerQrUrl(unit.consumerToken);
      return {
        heading: `${retailer ? 'RETAILER QR' : 'CONSUMER QR'}  ·  ${batch.batchNo}`,
        number: `${serialOf(unit.id)}  ·  ${retailer ? 'Retailer (activation)' : 'Consumer (after sale)'}`,
        qrImage: doc.openImage(await labelQrBuffer(url, 360)),
      };
    },
  });
};

const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const batchCsv = (batch, units) => {
  const head = ['serial', 'batch_no', 'retailer_qr_url', 'consumer_qr_url', 'coupon_code', 'discount_percent', 'coupon_valid_till', 'status', 'sold_at'];
  const rows = units.map((u) => [
    serialOf(u.id),
    batch.batchNo,
    retailerQrUrl(u.retailerToken),
    consumerQrUrl(u.consumerToken),
    u.couponCode || '',
    u.discountPercent === null ? '' : Number(u.discountPercent),
    u.couponCode ? batch.expiryDate : '',
    u.status,
    u.soldAt ? new Date(u.soldAt).toISOString() : '',
  ]);
  return [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\n');
};

// A unit's two QR codes as PNG images (data URLs), drawn like the printed labels (same ink colour,
// error correction H), for showing and downloading in the app.
const PRINT_INK = '#163832';
const qrImage = (url) => QRCode.toDataURL(url, { errorCorrectionLevel: 'H', margin: 2, width: 480, color: { dark: PRINT_INK, light: '#ffffff' } });
const unitQrJson = async (unit) => {
  const retailerUrl = retailerQrUrl(unit.retailerToken);
  const consumerUrl = consumerQrUrl(unit.consumerToken);
  const [retailer, consumer] = await Promise.all([qrImage(retailerUrl), qrImage(consumerUrl)]);
  return {
    serial: serialOf(unit.id),
    status: unit.status,
    retailer: { image: retailer, url: retailerUrl },
    consumer: { image: consumer, url: consumerUrl },
  };
};

// GET …/units/:id/qr and …/units/:id/pdf: one unit's QR pair, as images or as a printable label pair.
const sendUnitQr = async (req, res, unit, producerName) => {
  if (req.params.format === 'pdf') {
    const batch = unit.batch;
    const layout = pairGridFor('A4', 2, layoutOf(batch).orientation);
    return streamQrLabelPdf(res, {
      layout,
      count: 2,
      slotOf: (n) => pairSlot(layout, n),
      cutSlots: (k) => pairBlock(layout, k),
      title: 'Retailer + consumer QR pair',
      subtitle: `${producerName} · Batch ${batch.batchNo} · ${serialOf(unit.id)}`,
      fileName: `${serialOf(unit.id)}-qr-pair.pdf`,
      labelAt: async (i, doc) => {
        const retailer = i === 0;
        const url = retailer ? retailerQrUrl(unit.retailerToken) : consumerQrUrl(unit.consumerToken);
        return {
          heading: `${retailer ? 'RETAILER QR' : 'CONSUMER QR'}  ·  ${batch.batchNo}`,
          number: `${serialOf(unit.id)}  ·  ${retailer ? 'Retailer (activation)' : 'Consumer (after sale)'}`,
          qrImage: doc.openImage(await labelQrBuffer(url, 360)),
        };
      },
    });
  }
  return res.status(200).json(await unitQrJson(unit));
};

const sendBatchFile = async (req, res, batch, producerName) => {
  const units = await ChainUnit.findAll({ where: { batchId: batch.id }, order: [['serialNo', 'ASC']] });
  if (req.params.format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName(batch.batchNo)}-qr-pairs.csv"`);
    return res.send(batchCsv(batch, units));
  }
  return streamBatchPdf(res, batch, producerName, units);
};

module.exports = { MAX_QUANTITY, PRINT_DEFAULTS, nextBatchNo, allotBatch, batchTotals, sendBatchFile, sendUnitQr, readPrintLayout };
