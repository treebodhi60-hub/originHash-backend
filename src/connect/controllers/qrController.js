const crypto = require('crypto');
const { Op } = require('sequelize');
const {
  sequelize,
  Producer,
  ProducerProduct,
  ProducerOffer,
  ChainBatch,
  ChainUnit,
  ChainScan,
  ChainWarranty,
  User,
} = require('../models');
const { reverseGeocode } = require('../../services/geocodeService');
const { fileJson } = require('../files');
const { productJson, scanJson, warrantyJson, sellerJson, locationJson } = require('../serialize');
const { readWarranty } = require('./producerController');
const { cleanToken, coordinate, serialOf, percent, todayIST, fail, httpError } = require('../util');

// What the two QR codes of a unit open.
//   Retailer QR (/rq/:token): for the trade. Producers, distributors and retailers scan it (recorded
//     when the batch has Tracking on). Sold — once, unlocking the consumer QR — is pressed by
//     the unit's own producer (admin or staff), a retailer associated with that producer, a general
//     retailer when the batch allows all retailers, or the OriginHash superadmin. Other producers
//     and other producers' retailers get distributor-level access: they scan it, nothing more.
//   Consumer QR (/cq/:token): for the shopper, once the unit is sold — product info and
//     certificates, the discount coupon, warranty, history and chat with the brand.

// What pages show about a person.
const USER_ATTRS = ['id', 'name', 'username', 'mobile', 'businessName', 'city', 'isSuperAdmin', 'producerId'];
const userInclude = { model: User, as: 'user', attributes: USER_ATTRS };

const LOCATION_WINDOW_MS = 15 * 60 * 1000;
const SALE_SCAN_WINDOW_MS = 60 * 60 * 1000;

const unitIncludes = [
  {
    model: ChainBatch,
    as: 'batch',
    include: [
      { model: Producer, as: 'producer' },
      { model: ProducerProduct, as: 'product' },
    ],
  },
  { model: User, as: 'seller', attributes: USER_ATTRS },
];

const findUnit = async (field, rawToken, options = {}) => {
  const token = cleanToken(rawToken);
  if (!token) throw httpError(404, 'This QR code was not found.');
  const unit = await ChainUnit.findOne({ where: { [field]: token }, include: unitIncludes, ...options });
  if (!unit) throw httpError(404, 'This QR code was not found.');
  return unit;
};

// Who is looking (req.chainRole, see ../access), as a scan records it. Other admins of the main app
// are recorded as guests: they can look, not act.
const scanColumns = (req) => ({
  actorType: req.chainRole === 'viewer' ? 'guest' : req.chainRole,
  userId: req.user ? req.user.id : null,
});
const viewerJson = (req) =>
  req.user ? { role: req.chainRole, name: req.user.businessName || req.user.name || req.user.username || null } : null;

const nameLocation = async (scan) => {
  if (scan.latitude === null || scan.locationName) return;
  try {
    const name = await reverseGeocode(Number(scan.latitude), Number(scan.longitude));
    if (name) await ChainScan.update({ locationName: name }, { where: { id: scan.id } });
  } catch (err) {
    console.error(`Could not name the location of chain scan ${scan.id}:`, err.message);
  }
};
const placeNameSoon = (latitude, longitude) =>
  Promise.race([reverseGeocode(latitude, longitude).catch(() => null), new Promise((r) => setTimeout(() => r(null), 4000))]);

const productBasics = (product, req) =>
  product
    ? { id: product.id, name: product.name, category: product.category, image: product.images?.[0] ? fileJson(product.images[0], req) : null }
    : null;

const ownsUnit = (req, unit) => req.chainRole === 'producer' && req.producer.id === unit.batch.producerId;

// Who may press Sold on a unit of `batch`: the superadmin, the unit's own producer, a retailer
// associated with that producer, and — when the batch's Sold access is 'all' (the default) — every
// other retailer too (general ones and other producers' retailers). Other producers only scan.
const isOwnProducer = (req, producerId) => req.chainRole === 'producer' && Number(req.producer.id) === Number(producerId);
const retailerAccess = (req, batch) => {
  if (req.chainRole !== 'retailer') return null;
  if (Number(req.user.partnerProducerId) === Number(batch.producerId)) return 'ok';
  return batch.soldAccess === 'producer' ? 'producerRetailersOnly' : 'ok';
};
const mayMarkSold = (req, batch) => req.chainRole === 'admin' || isOwnProducer(req, batch.producerId) || retailerAccess(req, batch) === 'ok';
// Why someone in the trade can't sell it: 'otherProducer' | 'producerRetailersOnly' | null.
const sellBlockedReason = (req, batch) => {
  if (req.chainRole === 'producer') return isOwnProducer(req, batch.producerId) ? null : 'otherProducer';
  const access = retailerAccess(req, batch);
  return access && access !== 'ok' ? access : null;
};

// ---------- Retailer QR ----------

const retailerView = async (req, unit, scan) => {
  const { batch } = unit;
  const role = req.chainRole;
  const sold = unit.status === 'sold';
  const canSell = !sold && mayMarkSold(req, batch);
  const sellBlocked = sold ? null : sellBlockedReason(req, batch);
  const sellerIsMe = sold && (role === 'retailer' || role === 'producer') && unit.soldByUserId === req.user.id;
  const canAddWarranty = sold && (sellerIsMe || role === 'admin' || ownsUnit(req, unit));
  const warranties = canAddWarranty
    ? await ChainWarranty.findAll({
        where: { unitId: unit.id },
        include: [userInclude],
        order: [['id', 'DESC']],
      })
    : [];
  return {
    qr: 'retailer',
    serial: serialOf(unit.id),
    unitId: unit.id,
    batchNo: batch.batchNo,
    producer: { id: batch.producerId, name: batch.producer.name },
    product: productBasics(batch.product, req),
    status: unit.status,
    soldAt: unit.soldAt,
    soldBy: sellerJson(unit),
    viewer: viewerJson(req),
    canSell,
    sellBlocked,
    soldAccess: batch.soldAccess || 'all',
    canAddWarranty,
    isOwnProducer: ownsUnit(req, unit),
    trackingEnabled: batch.trackingEnabled !== false,
    scan: scan ? { token: scan.token, at: scan.createdAt, recorded: true } : null,
    warranties: warranties.map((w) => warrantyJson(w, req)),
  };
};

// POST /api/connect/qr/r/:token/open — opening the retailer QR's page. Records the scan for the
// trade (when the batch has Tracking on) and says what the viewer may do.
const openRetailerQr = async (req, res) => {
  try {
    const unit = await findUnit('retailerToken', req.params.token);
    const role = req.chainRole;
    if (role === 'guest' || role === 'consumer' || role === 'viewer') {
      return res.status(200).json({
        qr: 'retailer',
        tradeOnly: true,
        serial: serialOf(unit.id),
        producer: { name: unit.batch.producer.name },
        product: productBasics(unit.batch.product, req),
        status: unit.status,
        viewer: viewerJson(req),
      });
    }
    // Another producer's QR: scanned like a distributor would (recorded, no Sold, no warranty).
    let scan = null;
    if (unit.batch.trackingEnabled !== false) {
      scan = await ChainScan.create({ unitId: unit.id, qrType: 'retailer', action: 'scan', token: crypto.randomUUID(), ...scanColumns(req) });
      await unit.increment('tradeScanCount', { silent: true });
    }
    return res.status(200).json(await retailerView(req, unit, scan));
  } catch (err) {
    return fail(res, err, 'Could not open this QR code.');
  }
};

// POST /api/connect/qr/r/:token/sold { scanToken?, latitude?, longitude? } — a retailer or the
// OriginHash superadmin marks the unit sold. Happens once; unlocks the consumer QR.
const markSold = async (req, res) => {
  try {
    const latitude = coordinate(req.body?.latitude, 90);
    const longitude = coordinate(req.body?.longitude, 180);
    const located = latitude !== null && longitude !== null;

    const { unit, soldScan } = await sequelize.transaction(async (transaction) => {
      const token = cleanToken(req.params.token);
      if (!token) throw httpError(404, 'This QR code was not found.');
      const locked = await ChainUnit.findOne({ where: { retailerToken: token }, transaction, lock: transaction.LOCK.UPDATE });
      if (!locked) throw httpError(404, 'This QR code was not found.');
      if (locked.status === 'sold') throw httpError(409, 'This product has already been marked sold. A consumer QR can be activated only once.');
      const batch = await ChainBatch.findByPk(locked.batchId, { include: [{ model: Producer, as: 'producer' }], transaction });
      if (batch.producer.isBlocked) throw httpError(409, "This producer's account is suspended, so the product can't be sold through OriginHash right now.");
      if (!mayMarkSold(req, batch)) {
        throw httpError(
          403,
          batch.soldAccess === 'producer'
            ? `Only ${batch.producer.name} or its own retailers can mark this product sold.`
            : `Only ${batch.producer.name} or a retailer can mark this product sold.`
        );
      }

      // The scan of this page that led to the sale (who scanned), when it was recorded.
      let earlier = null;
      if (/^[0-9a-f-]{36}$/i.test(req.body?.scanToken || '')) {
        earlier = await ChainScan.findOne({ where: { token: req.body.scanToken, unitId: locked.id, qrType: 'retailer', action: 'scan' }, transaction });
        if (earlier && Date.now() - earlier.createdAt > SALE_SCAN_WINDOW_MS) earlier = null;
      }
      const sold = await ChainScan.create(
        {
          unitId: locked.id,
          qrType: 'retailer',
          action: 'sold',
          token: crypto.randomUUID(),
          ...scanColumns(req),
          latitude: located ? latitude : null,
          longitude: located ? longitude : null,
        },
        { transaction }
      );
      await locked.update(
        {
          status: 'sold',
          soldAt: sold.createdAt,
          soldByUserId: req.user.id,
          saleScanId: earlier ? earlier.id : sold.id,
        },
        { transaction }
      );
      return { unit: locked, soldScan: sold };
    });
    if (located) nameLocation(soldScan);

    const fresh = await findUnit('retailerToken', req.params.token);
    return res.status(200).json({ message: 'Product activated. The consumer QR is now unlocked.', ...(await retailerView(req, fresh, null)), unitId: unit.id });
  } catch (err) {
    return fail(res, err, 'Could not mark this product sold.');
  }
};

// POST /api/connect/qr/r/:token/warranty { registeredOn, validTill?, details?, photos[] } — the
// retailer who sold the unit (or its producer / the superadmin) records the warranty.
const addRetailerWarranty = async (req, res) => {
  try {
    const unit = await findUnit('retailerToken', req.params.token);
    const role = req.chainRole;
    if (unit.status !== 'sold') throw httpError(409, 'Mark the product sold before adding warranty information.');
    const allowed = (role === 'retailer' && unit.soldByUserId === req.user.id) || role === 'admin' || ownsUnit(req, unit);
    if (!allowed) throw httpError(403, 'Only the retailer who sold this product, or its producer, can add its warranty.');
    const warranty = await ChainWarranty.create({
      ...readWarranty(req.body || {}),
      unitId: unit.id,
      addedByType: role === 'retailer' ? 'retailer' : role === 'admin' ? 'admin' : 'producer',
      userId: req.user.id,
    });
    return res.status(201).json({ message: 'Warranty information saved.', ...(await retailerView(req, unit, null)), warrantyId: warranty.id });
  } catch (err) {
    return fail(res, err, 'Could not save the warranty information.');
  }
};

// PATCH /api/connect/qr/scans/:scanToken/location { latitude, longitude } — where a scan the same
// page just recorded happened.
const addScanLocation = async (req, res) => {
  try {
    const latitude = coordinate(req.body?.latitude, 90);
    const longitude = coordinate(req.body?.longitude, 180);
    if (latitude === null || longitude === null) return res.status(400).json({ message: 'Invalid location.' });
    const scan = /^[0-9a-f-]{36}$/i.test(req.params.scanToken || '') ? await ChainScan.findOne({ where: { token: req.params.scanToken } }) : null;
    if (!scan || scan.latitude !== null || Date.now() - scan.createdAt > LOCATION_WINDOW_MS) {
      return res.status(404).json({ message: 'Scan not found.' });
    }
    const locationName = await placeNameSoon(latitude, longitude);
    await scan.update({ latitude, longitude, locationName });
    if (!locationName) nameLocation(scan);
    return res.status(200).json({ location: locationJson(scan) });
  } catch (err) {
    return fail(res, err, 'Could not save the location.');
  }
};

// ---------- Consumer QR ----------

const offersFor = async (producerId, productId, today) =>
  ProducerOffer.findAll({
    where: {
      producerId,
      isActive: true,
      [Op.and]: [
        { [Op.or]: [{ productId: null }, ...(productId ? [{ productId }] : [])] },
        { [Op.or]: [{ validTill: null }, { validTill: { [Op.gte]: today } }] },
      ],
    },
    order: [['createdAt', 'DESC']],
  });

// POST /api/connect/qr/c/:token/open — opening the consumer QR's page (anyone; recorded). Product
// info is public; the coupon code, warranty, chat and history need a login.
const openConsumerQr = async (req, res) => {
  try {
    const unit = await findUnit('consumerToken', req.params.token);
    const { batch } = unit;
    const { producer, product } = batch;
    const activated = unit.status === 'sold';

    const scan = await ChainScan.create({ unitId: unit.id, qrType: 'consumer', action: 'scan', token: crypto.randomUUID(), ...scanColumns(req) });
    await unit.increment('consumerScanCount', { silent: true });

    const base = {
      qr: 'consumer',
      activated,
      serial: serialOf(unit.id),
      batchNo: batch.batchNo,
      producer: { id: producer.id, name: producer.name, website: producer.website },
      product: activated ? productJson(product, req) : productBasics(product, req),
      viewer: viewerJson(req),
      signedIn: Boolean(req.user),
      scan: { token: scan.token, at: scan.createdAt },
    };
    if (!activated) return res.status(200).json(base);

    const today = todayIST();
    const offers = await offersFor(producer.id, batch.productId, today);
    const isConsumer = req.chainRole === 'consumer';
    const pct = percent(unit.discountPercent);
    const discount = {
      percent: pct,
      hasCoupon: Boolean(unit.couponCode),
      validTill: unit.couponCode ? batch.expiryDate : null,
      expired: Boolean(unit.couponCode) && batch.expiryDate < today,
      claimed: Boolean(unit.couponClaimedBy),
      claimedByMe: isConsumer && unit.couponClaimedBy === req.user.id,
      code: isConsumer && unit.couponClaimedBy === req.user.id ? unit.couponCode : null,
    };

    const extra = {
      soldAt: unit.soldAt,
      purchasedFrom: sellerJson(unit),
      features: { chat: batch.chatEnabled !== false && !producer.isBlocked },
      discount,
      offers: offers.map((o) => ({
        id: o.id,
        title: o.title,
        details: o.details,
        validTill: o.validTill,
        couponCode: req.user ? o.couponCode : null,
      })),
    };
    if (req.user) {
      const [warranties, myScans] = await Promise.all([
        ChainWarranty.findAll({
          where: { unitId: unit.id },
          include: [userInclude],
          order: [['id', 'DESC']],
        }),
        ChainScan.findAll({ where: { unitId: unit.id, userId: req.user.id, qrType: 'consumer' }, order: [['id', 'DESC']], limit: 50 }),
      ]);
      extra.warranties = warranties.map((w) => warrantyJson(w, req));
      extra.myScans = myScans.map((s) => ({ id: s.id, at: s.createdAt, location: locationJson(s) }));
    }
    return res.status(200).json({ ...base, ...extra });
  } catch (err) {
    return fail(res, err, 'Could not open this QR code.');
  }
};

// POST /api/connect/qr/c/:token/coupon — a consumer takes the unit's unique coupon code. The first
// consumer to take it keeps it.
const claimCoupon = async (req, res) => {
  try {
    const account = req.user;
    const result = await sequelize.transaction(async (transaction) => {
      const token = cleanToken(req.params.token);
      const unit = token ? await ChainUnit.findOne({ where: { consumerToken: token }, transaction, lock: transaction.LOCK.UPDATE }) : null;
      if (!unit) throw httpError(404, 'This QR code was not found.');
      if (unit.status !== 'sold') throw httpError(409, 'This product has not been activated by a retailer yet.');
      if (!unit.couponCode) throw httpError(409, 'There is no discount on this product.');
      const batch = await ChainBatch.findByPk(unit.batchId, { transaction });
      if (unit.couponClaimedBy && unit.couponClaimedBy !== account.id) {
        throw httpError(409, 'This coupon has already been claimed by another customer.');
      }
      if (!unit.couponClaimedBy) {
        if (batch.expiryDate < todayIST()) throw httpError(409, 'This coupon has expired.');
        await unit.update({ couponClaimedBy: account.id, couponClaimedAt: new Date() }, { transaction });
      }
      return { code: unit.couponCode, percent: percent(unit.discountPercent), validTill: batch.expiryDate };
    });
    return res.status(200).json({ message: 'Coupon is yours.', coupon: result });
  } catch (err) {
    return fail(res, err, 'Could not get the coupon.');
  }
};

// ---------- History ----------

// GET /api/connect/me/history — the signed-in user's scans of retailer / consumer QR codes,
// newest first (consumers see their consumer-QR scans; the trade sees their scans and sales).
const myHistory = async (req, res) => {
  try {
    const scans = await ChainScan.findAll({
      where: { userId: req.user.id, ...(req.chainRole === 'consumer' ? { qrType: 'consumer' } : {}) },
      include: [
        {
          model: ChainUnit,
          as: 'unit',
          attributes: ['id', 'status', 'consumerToken', 'retailerToken', 'batchId'],
          include: [
            {
              model: ChainBatch,
              as: 'batch',
              attributes: ['id', 'batchNo', 'producerId', 'productId'],
              include: [
                { model: Producer, as: 'producer', attributes: ['id', 'name'] },
                { model: ProducerProduct, as: 'product', attributes: ['id', 'name', 'images'] },
              ],
            },
          ],
        },
      ],
      order: [['id', 'DESC']],
      limit: 300,
    });
    return res.status(200).json({
      history: scans.map((s) => ({
        id: s.id,
        at: s.createdAt,
        qrType: s.qrType,
        action: s.action,
        location: locationJson(s),
        serial: serialOf(s.unitId),
        status: s.unit?.status,
        token: s.qrType === 'consumer' ? s.unit?.consumerToken : s.unit?.retailerToken,
        batchNo: s.unit?.batch?.batchNo,
        producer: s.unit?.batch?.producer ? { id: s.unit.batch.producer.id, name: s.unit.batch.producer.name } : null,
        product: productBasics(s.unit?.batch?.product, req),
      })),
    });
  } catch (err) {
    return fail(res, err, 'Could not load your history.');
  }
};

module.exports = { openRetailerQr, markSold, addRetailerWarranty, addScanLocation, openConsumerQr, claimCoupon, myHistory };
