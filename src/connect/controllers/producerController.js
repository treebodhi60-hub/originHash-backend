const bcrypt = require('bcryptjs');
const { Op, QueryTypes } = require('sequelize');
const {
  sequelize,
  ProducerProduct,
  ProducerOffer,
  ChainBatch,
  ChainBatchRequest,
  ChainUnit,
  ChainScan,
  ChainWarranty,
  User,
} = require('../models');
const { batchTotals, sendBatchFile, sendUnitQr, MAX_QUANTITY } = require('../batches');
const { withLoginStats, loginHistory } = require('../logins');
const { storeFile, fileJson, isStoredRef, refsFrom } = require('../files');
const { publicUser } = require('../../controllers/authController');
const { recordProfileVersion } = require('../../utils/profileHistory');
const {
  producerJson,
  producerUserJson,
  productJson,
  offerJson,
  batchJson,
  requestJson,
  unitJson,
  scanJson,
  warrantyJson,
} = require('../serialize');
const { MOBILE_REGEX, EMAIL_REGEX, USERNAME_REGEX, text, opt, bool, validDate, todayIST, discount, unitIdFromSerial, serialOf, fail, httpError } = require('../util');

// A producer's side of the supply-chain module. Every query is limited to the signed-in user's own
// producer. The producer admin also manages the team and the Tracking / Chat switches.

const producerIdOf = (req) => req.producer.id;
// What timelines show about a person.
const USER_ATTRS = ['id', 'name', 'username', 'mobile', 'businessName', 'city', 'isSuperAdmin'];

// ---------- Account, settings and analytics ----------

// GET /api/connect/producer/me
const me = async (req, res) => res.status(200).json({ user: publicUser(req.user), producer: producerJson(req.producer, req) });

// PUT /api/connect/producer/settings { trackingEnabled?, chatEnabled? } — producer admin only.
const updateSettings = async (req, res) => {
  try {
    const body = req.body || {};
    const changes = {};
    if (body.trackingEnabled !== undefined) changes.trackingEnabled = bool(body.trackingEnabled);
    if (body.chatEnabled !== undefined) changes.chatEnabled = bool(body.chatEnabled);
    await req.producer.update(changes);
    return res.status(200).json({ message: 'Settings saved.', producer: producerJson(req.producer, req) });
  } catch (err) {
    return fail(res, err, 'Could not save the settings.');
  }
};

const UNITS_OF = 'SELECT u.id FROM chain_units u JOIN chain_batches b ON b.id = u.batch_id WHERE b.producer_id = :pid';

// GET /api/connect/producer/overview — the numbers on the producer's dashboard.
const overview = async (req, res) => {
  try {
    const pid = producerIdOf(req);
    const q = (sql) => sequelize.query(sql, { replacements: { pid }, type: QueryTypes.SELECT });
    const [[units], [scans], daily, dailyScans, retailers, places, recent, [chats], [products]] = await Promise.all([
      q(`SELECT COUNT(*) AS total, COALESCE(SUM(u.status = 'sold'), 0) AS sold,
                COALESCE(SUM(u.coupon_claimed_by IS NOT NULL), 0) AS couponsClaimed,
                COALESCE(SUM(u.coupon_code IS NOT NULL), 0) AS coupons
           FROM chain_units u JOIN chain_batches b ON b.id = u.batch_id WHERE b.producer_id = :pid`),
      q(`SELECT COALESCE(SUM(s.qr_type = 'consumer'), 0) AS consumerScans,
                COALESCE(SUM(s.qr_type = 'retailer' AND s.action = 'scan'), 0) AS tradeScans,
                COUNT(DISTINCT CASE WHEN s.actor_type = 'consumer' THEN s.user_id END) AS consumers,
                (SELECT COUNT(*) FROM chain_warranties w WHERE w.unit_id IN (${UNITS_OF})) AS warranties
           FROM chain_scans s WHERE s.unit_id IN (${UNITS_OF})`),
      q(`SELECT DATE(u.sold_at) AS day, COUNT(*) AS n FROM chain_units u JOIN chain_batches b ON b.id = u.batch_id
          WHERE b.producer_id = :pid AND u.sold_at >= DATE_SUB(CURDATE(), INTERVAL 13 DAY) GROUP BY DATE(u.sold_at)`),
      q(`SELECT DATE(s.created_at) AS day, COUNT(*) AS n FROM chain_scans s
          WHERE s.qr_type = 'consumer' AND s.created_at >= DATE_SUB(CURDATE(), INTERVAL 13 DAY) AND s.unit_id IN (${UNITS_OF})
          GROUP BY DATE(s.created_at)`),
      q(`SELECT a.id, a.business_name AS businessName, a.name, a.city, COUNT(*) AS sold
           FROM chain_units u JOIN chain_batches b ON b.id = u.batch_id JOIN users a ON a.id = u.sold_by_user_id AND a.partner_role = 'retailer'
          WHERE b.producer_id = :pid GROUP BY a.id ORDER BY sold DESC LIMIT 8`),
      q(`SELECT s.location_name AS place, COUNT(*) AS n FROM chain_scans s
          WHERE s.location_name IS NOT NULL AND s.unit_id IN (${UNITS_OF}) GROUP BY s.location_name ORDER BY n DESC LIMIT 8`),
      ChainScan.findAll({
        where: { unitId: { [Op.in]: sequelize.literal(`(${UNITS_OF.replace(':pid', Number(pid))})`) } },
        include: [
          { model: User, as: 'user', attributes: USER_ATTRS },
          { model: ChainUnit, as: 'unit', attributes: ['id', 'batchId'] },
        ],
        order: [['id', 'DESC']],
        limit: 12,
      }),
      q(`SELECT COALESCE(SUM(t.unread_for_producer), 0) AS unread, COUNT(*) AS threads FROM brand_chat_threads t WHERE t.producer_id = :pid`),
      q(`SELECT COUNT(*) AS n FROM producer_products p WHERE p.producer_id = :pid`),
    ]);

    // The last 14 days, oldest first, with zeros filled in.
    const key = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
    const soldBy = new Map(daily.map((r) => [key(r.day), Number(r.n)]));
    const scansBy = new Map(dailyScans.map((r) => [key(r.day), Number(r.n)]));
    const days = Array.from({ length: 14 }, (_, i) => {
      const d = new Date();
      d.setDate(d.getDate() - (13 - i));
      const day = d.toISOString().slice(0, 10);
      return { day, sold: soldBy.get(day) || 0, consumerScans: scansBy.get(day) || 0 };
    });

    return res.status(200).json({
      units: { total: Number(units.total), sold: Number(units.sold), unsold: Number(units.total) - Number(units.sold) },
      coupons: { total: Number(units.coupons), claimed: Number(units.couponsClaimed) },
      consumerScans: Number(scans.consumerScans),
      tradeScans: Number(scans.tradeScans),
      consumers: Number(scans.consumers),
      warranties: Number(scans.warranties),
      products: Number(products.n),
      chats: { threads: Number(chats.threads), unread: Number(chats.unread) },
      days,
      topRetailers: retailers.map((r) => ({ id: r.id, name: r.businessName || r.name, city: r.city, sold: Number(r.sold) })),
      topPlaces: places.map((p) => ({ place: p.place, scans: Number(p.n) })),
      recent: recent.map((s) => ({ ...scanJson(s), unitId: s.unitId, serial: serialOf(s.unitId) })),
      trackingEnabled: req.producer.trackingEnabled,
    });
  } catch (err) {
    return fail(res, err, 'Could not load the dashboard.');
  }
};

// POST /api/connect/producer/uploads  multipart: file, folder (products|certificates|warranty)
const uploadFile = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'Choose a file to upload.' });
    const folder = ['products', 'certificates', 'warranty'].includes(req.body?.folder) ? req.body.folder : 'products';
    const ref = await storeFile(req.file, folder);
    return res.status(201).json({ file: fileJson(ref, req, req.file.originalname) });
  } catch (err) {
    return fail(res, err, "Couldn't upload the file. Please try again.");
  }
};

// ---------- Team (producer admin) ----------

// GET /api/connect/producer/users
const listUsers = async (req, res) => {
  try {
    const users = await User.findAll({ where: { producerId: producerIdOf(req) }, order: [['producerRole', 'ASC'], ['createdAt', 'ASC']] });
    return res.status(200).json({ users: await withLoginStats(users, producerUserJson) });
  } catch (err) {
    return fail(res, err, 'Could not load your team.');
  }
};

// GET /api/connect/producer/users/:id/logins — a team member's sign-ins, newest first. The producer
// admin sees anyone's; staff see only their own.
const userLogins = async (req, res) => {
  try {
    const user = await teamMember(req);
    if (req.user.producerRole !== 'admin' && user.id !== req.user.id) {
      return res.status(403).json({ message: 'Only your admin can see other users’ logins.' });
    }
    const [summary] = await withLoginStats([user], producerUserJson);
    return res.status(200).json({ user: summary, logins: await loginHistory(user.id) });
  } catch (err) {
    return fail(res, err, 'Could not load the login history.');
  }
};

const readUserFields = (body) => {
  const name = text(body.name, 120);
  if (!name) throw httpError(400, 'Enter the name.', 'name');
  const mobile = opt(body.mobile, 15);
  if (mobile && !MOBILE_REGEX.test(mobile)) throw httpError(400, 'Enter a valid 10-digit mobile number.', 'mobile');
  const email = opt(body.email, 150);
  if (email && !EMAIL_REGEX.test(email)) throw httpError(400, 'Enter a valid email address.', 'email');
  return { name, mobile, email, canChat: bool(body.canChat) };
};

// POST /api/connect/producer/users { username, password, name, mobile?, email?, canChat? }
const createUser = async (req, res) => {
  try {
    const body = req.body || {};
    const username = text(body.username, 50);
    if (!USERNAME_REGEX.test(username)) throw httpError(400, 'Username: 3–50 letters, numbers, dots, dashes or underscores.', 'username');
    const password = String(body.password || '');
    if (password.length < 8) throw httpError(400, 'The password must be at least 8 characters.', 'password');
    if (await User.findOne({ where: { username }, attributes: ['id'] })) throw httpError(409, 'That username is already taken.', 'username');
    const fields = readUserFields(body);
    await mobileUnused(fields.mobile);
    const user = await sequelize.transaction(async (transaction) => {
      const made = await User.create(
        {
          ...fields,
          producerId: producerIdOf(req),
          producerRole: 'staff',
          username,
          passwordHash: await bcrypt.hash(password, 10),
          countryCode: '+91',
          isAdmin: false,
          profileCompleted: true,
        },
        { transaction }
      );
      await recordProfileVersion(made, { source: 'admin', changedBy: req.user.id, transaction });
      return made;
    });
    return res.status(201).json({ message: `${user.name} can now log in as ${username}.`, user: producerUserJson(user) });
  } catch (err) {
    return fail(res, err, 'Could not add the user.');
  }
};

// A mobile can belong to one app account only.
const mobileUnused = async (mobile, exceptId) => {
  if (mobile && (await User.findOne({ where: { mobile, ...(exceptId ? { id: { [Op.ne]: exceptId } } : {}) }, attributes: ['id'] }))) {
    throw httpError(409, 'This mobile already has an OriginHash account.', 'mobile');
  }
};

const teamMember = async (req) => {
  const user = await User.findOne({ where: { id: req.params.id, producerId: producerIdOf(req) } });
  if (!user) throw httpError(404, 'User not found.');
  return user;
};

// PUT /api/connect/producer/users/:id { name, mobile, email, canChat, password? }
const updateUser = async (req, res) => {
  try {
    const user = await teamMember(req);
    const body = req.body || {};
    const changes = readUserFields(body);
    await mobileUnused(changes.mobile, user.id);
    if (user.producerRole === 'admin') changes.canChat = true;
    if (body.password) {
      if (String(body.password).length < 8) throw httpError(400, 'The password must be at least 8 characters.', 'password');
      changes.passwordHash = await bcrypt.hash(String(body.password), 10);
    }
    await sequelize.transaction(async (transaction) => {
      await user.update(changes, { transaction });
      await recordProfileVersion(user, { source: 'admin', changedBy: req.user.id, transaction });
    });
    return res.status(200).json({ message: 'Saved.', user: producerUserJson(user) });
  } catch (err) {
    return fail(res, err, 'Could not save the user.');
  }
};

// PATCH /api/connect/producer/users/:id/block { blocked }
const blockUser = async (req, res) => {
  try {
    const user = await teamMember(req);
    if (user.producerRole === 'admin') throw httpError(400, "The producer admin can't be blocked here.");
    await user.update({ isBlocked: bool(req.body?.blocked) });
    return res.status(200).json({ message: user.isBlocked ? `${user.name} is blocked.` : `${user.name} is unblocked.`, user: producerUserJson(user) });
  } catch (err) {
    return fail(res, err, 'Could not update the user.');
  }
};

// ---------- Products ----------

const readProductFields = (body, categories) => {
  const name = text(body.name, 160);
  if (!name) throw httpError(400, 'Enter the product name.', 'name');
  const category = opt(body.category, 80);
  if (category && categories.length && !categories.includes(category)) {
    throw httpError(400, 'Choose one of your categories.', 'category');
  }
  const nabl = body.nablCertificate;
  const nablRef = nabl ? (typeof nabl === 'string' ? nabl : nabl.ref) : null;
  if (nablRef && !isStoredRef(nablRef)) throw httpError(400, 'Upload the NABL certificate again.', 'nablCertificate');
  // Titled documents: [{ title, ref, name }], only files uploaded through /uploads.
  const docs = (list, fallbackTitle) =>
    (Array.isArray(list) ? list : [])
      .filter((c) => c && isStoredRef(c.ref))
      .slice(0, 12)
      .map((c) => ({ title: text(c.title, 120) || fallbackTitle, ref: c.ref, name: opt(c.name, 200) }));
  const certifications = docs(body.certifications, 'Certificate');
  return {
    name,
    category,
    description: opt(body.description, 5000),
    website: opt(body.website, 255),
    nablCertificateUrl: nablRef || null,
    nablCertificateName: nablRef ? opt(nabl?.name, 200) : null,
    certifications,
    images: refsFrom(body.images, 10),
    warrantyTerms: opt(body.warrantyTerms, 3000),
    warrantyDocs: docs(body.warrantyDocs, 'Warranty document'),
    isActive: body.isActive === undefined ? true : bool(body.isActive),
  };
};

// GET /api/connect/producer/products
const listProducts = async (req, res) => {
  try {
    const products = await ProducerProduct.findAll({ where: { producerId: producerIdOf(req) }, order: [['createdAt', 'DESC']] });
    return res.status(200).json({ products: products.map((p) => productJson(p, req)) });
  } catch (err) {
    return fail(res, err, 'Could not load products.');
  }
};

// POST /api/connect/producer/products
const createProduct = async (req, res) => {
  try {
    const product = await ProducerProduct.create({
      ...readProductFields(req.body || {}, req.producer.categories || []),
      producerId: producerIdOf(req),
      createdBy: req.user.id,
    });
    return res.status(201).json({ message: 'Product added.', product: productJson(product, req) });
  } catch (err) {
    return fail(res, err, 'Could not add the product.');
  }
};

const ownProduct = async (req, id = req.params.id) => {
  const product = await ProducerProduct.findOne({ where: { id, producerId: producerIdOf(req) } });
  if (!product) throw httpError(404, 'Product not found.');
  return product;
};

// GET /api/connect/producer/products/:id
const getProduct = async (req, res) => {
  try {
    return res.status(200).json({ product: productJson(await ownProduct(req), req) });
  } catch (err) {
    return fail(res, err, 'Could not load the product.');
  }
};

// PUT /api/connect/producer/products/:id
const updateProduct = async (req, res) => {
  try {
    const product = await ownProduct(req);
    await product.update(readProductFields(req.body || {}, req.producer.categories || []));
    return res.status(200).json({ message: 'Product saved.', product: productJson(product, req) });
  } catch (err) {
    return fail(res, err, 'Could not save the product.');
  }
};

// PATCH /api/connect/producer/products/:id/active { active } — the product page's Active switch,
// saved on its own as soon as it's flipped.
const setProductActive = async (req, res) => {
  try {
    const product = await ownProduct(req);
    const active = bool((req.body || {}).active);
    await product.update({ isActive: active });
    return res.status(200).json({
      message: active ? `${product.name} is active again.` : `${product.name} is now inactive. It can’t be chosen for new QR batch requests.`,
      product: productJson(product, req),
    });
  } catch (err) {
    return fail(res, err, 'Could not change the product.');
  }
};

// ---------- Discounts / loyalty offers ----------

// A product's discount: { productId, couponCode, discountPercent, validTill }. One per product; the
// title is made from the percentage and product. `existing` is the offer being edited.
const readOfferFields = async (req, existing = null) => {
  const body = req.body || {};
  const productId = Number(body.productId) || null;
  if (!productId) throw httpError(400, 'Choose the product.', 'productId');
  const product = await ownProduct(req, productId).catch(() => {
    throw httpError(400, 'Choose one of your products.', 'productId');
  });
  if (!product.isActive && productId !== existing?.productId) {
    throw httpError(400, `${product.name} is inactive. Activate it in Products first.`, 'productId');
  }
  const clash = await ProducerOffer.findOne({
    where: { producerId: producerIdOf(req), productId, ...(existing ? { id: { [Op.ne]: existing.id } } : {}) },
    attributes: ['id', 'couponCode'],
  });
  if (clash) throw httpError(409, `${product.name} already has a discount (${clash.couponCode}). Edit that one instead.`, 'productId');

  const couponCode = opt(body.couponCode, 60);
  if (!couponCode) throw httpError(400, 'Enter the coupon code.', 'couponCode');
  if (/\s/.test(couponCode)) throw httpError(400, 'A coupon code has no spaces.', 'couponCode');
  const discountPercent = discount(body.discountPercent);
  if (!discountPercent) throw httpError(400, 'Enter a discount between 0.01 and 100%.', 'discountPercent');
  if (!validDate(body.validTill)) throw httpError(400, 'Choose the expiry date.', 'validTill');
  if (body.validTill < todayIST() && body.validTill !== existing?.validTill) {
    throw httpError(400, 'The expiry date can’t be in the past.', 'validTill');
  }
  return {
    productId,
    couponCode,
    discountPercent,
    validTill: body.validTill,
    title: `${discountPercent}% off ${product.name}`.slice(0, 160),
    ...(body.details !== undefined ? { details: opt(body.details, 2000) } : {}),
    // Saving a discount (re)activates it; it ends on its expiry date.
    isActive: true,
  };
};

const offerInclude = [{ model: ProducerProduct, as: 'product', attributes: ['id', 'name'] }];

// GET /api/connect/producer/offers
const listOffers = async (req, res) => {
  try {
    const offers = await ProducerOffer.findAll({ where: { producerId: producerIdOf(req) }, include: offerInclude, order: [['createdAt', 'DESC']] });
    return res.status(200).json({ offers: offers.map(offerJson) });
  } catch (err) {
    return fail(res, err, 'Could not load offers.');
  }
};

// POST /api/connect/producer/offers { productId, couponCode, discountPercent, validTill }
const createOffer = async (req, res) => {
  try {
    const offer = await ProducerOffer.create({ ...(await readOfferFields(req)), producerId: producerIdOf(req), createdBy: req.user.id });
    await offer.reload({ include: offerInclude });
    return res.status(201).json({ message: 'Discount added.', offer: offerJson(offer) });
  } catch (err) {
    return fail(res, err, 'Could not add the offer.');
  }
};

const ownOffer = async (req) => {
  const offer = await ProducerOffer.findOne({ where: { id: req.params.id, producerId: producerIdOf(req) } });
  if (!offer) throw httpError(404, 'Discount not found.');
  return offer;
};

// PUT /api/connect/producer/offers/:id
const updateOffer = async (req, res) => {
  try {
    const offer = await ownOffer(req);
    await offer.update(await readOfferFields(req, offer));
    await offer.reload({ include: offerInclude });
    return res.status(200).json({ message: 'Discount saved.', offer: offerJson(offer) });
  } catch (err) {
    return fail(res, err, 'Could not save the offer.');
  }
};

// DELETE /api/connect/producer/offers/:id
const deleteOffer = async (req, res) => {
  try {
    const offer = await ownOffer(req);
    await offer.destroy();
    return res.status(200).json({ message: 'Discount deleted.' });
  } catch (err) {
    return fail(res, err, 'Could not delete the offer.');
  }
};

// ---------- QR batches ----------

const requestIncludes = [
  { model: ProducerProduct, as: 'product', attributes: ['id', 'name'] },
  { model: User, as: 'requester', attributes: ['id', 'name', 'username'] },
];

// GET /api/connect/producer/batch-requests
const listRequests = async (req, res) => {
  try {
    const requests = await ChainBatchRequest.findAll({ where: { producerId: producerIdOf(req) }, include: requestIncludes, order: [['createdAt', 'DESC']], limit: 200 });
    return res.status(200).json({ requests: requests.map(requestJson) });
  } catch (err) {
    return fail(res, err, 'Could not load your requests.');
  }
};

// The product's discount that applies today (Discounts tab): active and not expired.
const currentOfferOf = (req, productId) =>
  ProducerOffer.findOne({
    where: {
      producerId: producerIdOf(req),
      productId,
      isActive: true,
      [Op.or]: [{ validTill: null }, { validTill: { [Op.gte]: todayIST() } }],
    },
    order: [['updatedAt', 'DESC']],
  });

// POST /api/connect/producer/batch-requests { productId, quantity, expiryDate, batchNo?, note? }
// The max discount is always the product's current discount (set only in the Discounts tab).
// QR codes are free for now; the OriginHash superadmin allots the batch.
const createRequest = async (req, res) => {
  try {
    const body = req.body || {};
    const productId = Number(body.productId) || null;
    if (!productId) throw httpError(400, 'Choose the product.', 'productId');
    const product = await ownProduct(req, productId).catch(() => {
      throw httpError(400, 'Choose one of your products.', 'productId');
    });
    if (!product.isActive) throw httpError(400, `${product.name} is inactive. Activate it in Products first.`, 'productId');
    const quantity = Number(body.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
      throw httpError(400, `Request between 1 and ${MAX_QUANTITY.toLocaleString('en-IN')} units.`, 'quantity');
    }
    const offer = await currentOfferOf(req, productId);
    const maxDiscountPercent = offer ? discount(offer.discountPercent) || null : null;
    if (!validDate(body.expiryDate)) throw httpError(400, 'Choose the expiry date.', 'expiryDate');
    const batchNo = opt(body.batchNo, 80);
    if (batchNo && (await ChainBatch.findOne({ where: { producerId: producerIdOf(req), batchNo }, attributes: ['id'] }))) {
      throw httpError(409, 'You already have a batch with this number.', 'batchNo');
    }
    const request = await ChainBatchRequest.create({
      producerId: producerIdOf(req),
      productId,
      quantity,
      maxDiscountPercent,
      expiryDate: body.expiryDate,
      batchNo,
      note: opt(body.note, 500),
      requestedBy: req.user.id,
    });
    await request.reload({ include: requestIncludes });
    return res.status(201).json({
      message: `Requested ${quantity} units (${quantity * 2} QR codes). OriginHash will allot the batch.`,
      request: requestJson(request),
    });
  } catch (err) {
    return fail(res, err, 'Could not send the request.');
  }
};

const ownBatch = async (req) => {
  const batch = await ChainBatch.findOne({
    where: { id: req.params.id, producerId: producerIdOf(req) },
    include: [{ model: ProducerProduct, as: 'product', attributes: ['id', 'name'] }],
  });
  if (!batch) throw httpError(404, 'Batch not found.');
  return batch;
};

// GET /api/connect/producer/batches
const listBatches = async (req, res) => {
  try {
    const batches = await ChainBatch.findAll({
      where: { producerId: producerIdOf(req) },
      include: [{ model: ProducerProduct, as: 'product', attributes: ['id', 'name'] }],
      order: [['createdAt', 'DESC']],
    });
    const totals = await batchTotals(batches.map((b) => b.id));
    return res.status(200).json({ batches: batches.map((b) => batchJson(b, totals.get(b.id))) });
  } catch (err) {
    return fail(res, err, 'Could not load your batches.');
  }
};

// GET /api/connect/producer/batches/:id — the batch and its units.
const getBatch = async (req, res) => {
  try {
    const batch = await ownBatch(req);
    const units = await ChainUnit.findAll({
      where: { batchId: batch.id },
      include: [{ model: User, as: 'seller', attributes: USER_ATTRS }],
      order: [['serialNo', 'ASC']],
    });
    const totals = await batchTotals([batch.id]);
    return res.status(200).json({ batch: batchJson(batch, totals.get(batch.id)), units: units.map((u) => unitJson(u, { withTokens: true })) });
  } catch (err) {
    return fail(res, err, 'Could not load the batch.');
  }
};

// GET /api/connect/producer/batches/:id/file/:format (pdf|csv)
const downloadBatch = async (req, res) => {
  try {
    const batch = await ownBatch(req);
    await sendBatchFile(req, res, batch, req.producer.name);
  } catch (err) {
    if (err.status && !res.headersSent) return res.status(err.status).json({ message: err.message });
    console.error(err);
    if (!res.headersSent) return res.status(500).json({ message: 'Could not prepare the file.' });
    return res.end();
  }
};

// ---------- Units: tracking and warranty ----------

const ownUnit = async (req, id) => {
  const unit = await ChainUnit.findOne({
    where: { id },
    include: [
      { model: ChainBatch, as: 'batch', where: { producerId: producerIdOf(req) }, include: [{ model: ProducerProduct, as: 'product' }] },
      { model: User, as: 'seller', attributes: USER_ATTRS },
    ],
  });
  if (!unit) throw httpError(404, 'Unit not found.');
  return unit;
};

// GET /api/connect/producer/units/lookup?serial=OH000123
const lookupUnit = async (req, res) => {
  try {
    const id = unitIdFromSerial(req.query.serial);
    if (!id) throw httpError(400, 'Enter a serial like OH000123.');
    const unit = await ownUnit(req, id);
    return res.status(200).json({ unitId: unit.id });
  } catch (err) {
    return fail(res, err, 'Could not find the unit.');
  }
};

const scanIncludes = [{ model: User, as: 'user', attributes: USER_ATTRS }];
const warrantyIncludes = scanIncludes;

// GET /api/connect/producer/units/:id — the unit's journey (every scan, the sale), warranty, coupon.
const getUnit = async (req, res) => {
  try {
    const unit = await ownUnit(req, req.params.id);
    const [scans, warranties, claimer] = await Promise.all([
      ChainScan.findAll({ where: { unitId: unit.id }, include: scanIncludes, order: [['id', 'ASC']] }),
      ChainWarranty.findAll({ where: { unitId: unit.id }, include: warrantyIncludes, order: [['id', 'DESC']] }),
      unit.couponClaimedBy ? User.findByPk(unit.couponClaimedBy, { attributes: ['id', 'name', 'mobile'] }) : null,
    ]);
    const saleScan = scans.find((s) => s.id === unit.saleScanId);
    const soldScan = scans.find((s) => s.action === 'sold');
    return res.status(200).json({
      unit: unitJson(unit, { withTokens: true }),
      batch: batchJson(unit.batch),
      product: productJson(unit.batch.product, req),
      sale:
        unit.status === 'sold'
          ? {
              at: unit.soldAt,
              scannedBy: saleScan ? scanJson(saleScan).by : null,
              soldBy: soldScan ? scanJson(soldScan).by : null,
              location: soldScan ? scanJson(soldScan).location : null,
            }
          : null,
      couponClaimedBy: claimer ? { name: claimer.name, mobile: claimer.mobile } : null,
      scans: scans.map(scanJson),
      warranties: warranties.map((w) => warrantyJson(w, req)),
      trackingEnabled: req.producer.trackingEnabled,
    });
  } catch (err) {
    return fail(res, err, 'Could not load the unit.');
  }
};

// GET /api/connect/producer/units/:id/qr/:format (json|pdf) — the unit's retailer + consumer QR codes.
const unitQr = async (req, res) => {
  try {
    const unit = await ownUnit(req, req.params.id);
    await sendUnitQr(req, res, unit, req.producer.name);
  } catch (err) {
    if (res.headersSent) return res.end();
    return fail(res, err, 'Could not prepare the QR codes.');
  }
};

// Warranty fields from a form: { registeredOn, validTill?, details?, photos: [ref] }.
const readWarranty = (body) => {
  if (!validDate(body.registeredOn)) throw httpError(400, 'Choose the warranty registration date.', 'registeredOn');
  if (body.validTill && !validDate(body.validTill)) throw httpError(400, 'Choose a valid "valid till" date.', 'validTill');
  if (body.validTill && body.validTill < body.registeredOn) throw httpError(400, '"Valid till" must be after the registration date.', 'validTill');
  const photos = refsFrom(body.photos, 10);
  const details = opt(body.details, 3000);
  if (!photos.length && !details) throw httpError(400, 'Add photos or details for the warranty.', 'photos');
  return { registeredOn: body.registeredOn, validTill: body.validTill || null, details, photos };
};

// POST /api/connect/producer/units/:id/warranty
const addWarranty = async (req, res) => {
  try {
    const unit = await ownUnit(req, req.params.id);
    const warranty = await ChainWarranty.create({
      ...readWarranty(req.body || {}),
      unitId: unit.id,
      addedByType: 'producer',
      userId: req.user.id,
    });
    await warranty.reload({ include: warrantyIncludes });
    return res.status(201).json({ message: 'Warranty information saved.', warranty: warrantyJson(warranty, req) });
  } catch (err) {
    return fail(res, err, 'Could not save the warranty information.');
  }
};

// POST /api/connect/producer/password { currentPassword, newPassword } — the signed-in user's own password.
const changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (typeof newPassword !== 'string' || newPassword.length < 8) {
      throw httpError(400, 'The new password must be at least 8 characters.', 'newPassword');
    }
    if (!(await bcrypt.compare(String(currentPassword || ''), req.user.passwordHash || ''))) {
      throw httpError(400, 'Your current password is incorrect.', 'currentPassword');
    }
    await req.user.update({ passwordHash: await bcrypt.hash(newPassword, 10) });
    return res.status(200).json({ message: 'Password changed.' });
  } catch (err) {
    return fail(res, err, 'Could not change the password.');
  }
};

module.exports = {
  me,
  changePassword,
  updateSettings,
  overview,
  uploadFile,
  listUsers,
  userLogins,
  createUser,
  updateUser,
  blockUser,
  listProducts,
  createProduct,
  getProduct,
  updateProduct,
  setProductActive,
  listOffers,
  createOffer,
  updateOffer,
  deleteOffer,
  listRequests,
  createRequest,
  listBatches,
  getBatch,
  downloadBatch,
  lookupUnit,
  getUnit,
  unitQr,
  addWarranty,
  readWarranty,
};
