const bcrypt = require('bcryptjs');
const { Op, fn, col } = require('sequelize');
const { sequelize, User, Producer, ProducerProduct, ChainBatch, ChainBatchRequest, ChainUnit, PartnerApplication } = require('../models');
const { recordProfileVersion } = require('../../utils/profileHistory');
const { allotBatch, batchTotals, sendBatchFile, sendUnitQr, readPrintLayout } = require('../batches');
const { withLoginStats, loginHistory } = require('../logins');
const { queryHistory } = require('../history');
const { readRetailer, saveRetailer } = require('../retailers');
const { isStoredRef, storeFile, fileJson } = require('../files');
const { producerJson, producerUserJson, accountJson, batchJson, requestJson, unitJson, productJson } = require('../serialize');
const { MOBILE_REGEX, EMAIL_REGEX, USERNAME_REGEX, text, opt, bool, validDate, discount, fail, httpError } = require('../util');

// The OriginHash superadmin's side of the supply-chain module: producers, distributors / retailers /
// consumers (all of them existing app users), batch requests and QR batch allotment.

const ROLES = ['distributor', 'retailer', 'consumer'];
// Consumers: every ordinary app user (not an admin, producer user, distributor or retailer).
const CONSUMER_WHERE = { isAdmin: false, isSuperAdmin: false, producerId: null, partnerRole: null };

const categoriesFrom = (value) =>
  [...new Set((Array.isArray(value) ? value : String(value || '').split(',')).map((c) => text(String(c), 60)).filter(Boolean))].slice(0, 20);

// ---------- Overview ----------

// GET /api/connect/admin/overview
const overview = async (req, res) => {
  try {
    const [producers, accounts, batches, units, sold, pending] = await Promise.all([
      Producer.count(),
      User.findAll({
        where: { partnerRole: { [Op.ne]: null } },
        attributes: ['partnerRole', [fn('COUNT', col('id')), 'n']],
        group: ['partnerRole'],
        raw: true,
      }),
      ChainBatch.count(),
      ChainUnit.count(),
      ChainUnit.count({ where: { status: 'sold' } }),
      ChainBatchRequest.count({ where: { status: 'pending' } }),
    ]);
    const byRole = Object.fromEntries(ROLES.map((r) => [r, 0]));
    accounts.forEach((a) => {
      byRole[a.partnerRole] = Number(a.n);
    });
    byRole.consumer = await User.count({ where: CONSUMER_WHERE });
    const pendingRetailers = await PartnerApplication.count({ where: { status: 'pending' } });
    return res.status(200).json({ producers, accounts: byRole, batches, units, sold, pendingRequests: pending, pendingRetailers });
  } catch (err) {
    return fail(res, err, 'Could not load the overview.');
  }
};

// POST /api/connect/admin/uploads  multipart: file, folder (documents|products|certificates|warranty)
const uploadFile = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'Choose a file to upload.' });
    const ref = await storeFile(req.file, text(req.body?.folder, 20) || 'documents');
    return res.status(201).json({ file: fileJson(ref, req, req.file.originalname) });
  } catch (err) {
    return fail(res, err, "Couldn't upload the file. Please try again.");
  }
};

// ---------- Producers ----------

const producerTotals = async (ids) => {
  if (!ids.length) return new Map();
  const [users, batches, units] = await Promise.all([
    User.findAll({ where: { producerId: ids }, attributes: ['producerId', [fn('COUNT', col('id')), 'n']], group: ['producerId'], raw: true }),
    ChainBatch.findAll({
      where: { producerId: ids },
      attributes: ['producerId', [fn('COUNT', col('id')), 'n'], [fn('SUM', col('quantity')), 'units']],
      group: ['producerId'],
      raw: true,
    }),
    ChainUnit.findAll({
      attributes: [[col('batch.producer_id'), 'producerId'], [fn('COUNT', col('ChainUnit.id')), 'sold']],
      include: [{ model: ChainBatch, as: 'batch', attributes: [], where: { producerId: ids } }],
      where: { status: 'sold' },
      group: [col('batch.producer_id')],
      raw: true,
    }),
  ]);
  const map = new Map(ids.map((id) => [id, { users: 0, batches: 0, units: 0, sold: 0 }]));
  users.forEach((r) => (map.get(r.producerId).users = Number(r.n)));
  batches.forEach((r) => Object.assign(map.get(r.producerId), { batches: Number(r.n), units: Number(r.units || 0) }));
  units.forEach((r) => (map.get(r.producerId).sold = Number(r.sold)));
  return map;
};

// GET /api/connect/admin/producers?search=
const listProducers = async (req, res) => {
  try {
    const search = text(req.query.search, 100);
    const where = search
      ? { [Op.or]: [{ name: { [Op.like]: `%${search}%` } }, { mobile: { [Op.like]: `%${search}%` } }, { email: { [Op.like]: `%${search}%` } }] }
      : {};
    const producers = await Producer.findAll({ where, order: [['createdAt', 'DESC']], limit: 500 });
    const totals = await producerTotals(producers.map((p) => p.id));
    const admins = await User.findAll({ where: { producerId: producers.map((p) => p.id), producerRole: 'admin' } });
    const adminOf = new Map(admins.map((a) => [a.producerId, a]));
    return res.status(200).json({
      producers: producers.map((p) => producerJson(p, req, { totals: totals.get(p.id), admin: producerUserJson(adminOf.get(p.id)) })),
    });
  } catch (err) {
    return fail(res, err, 'Could not load producers.');
  }
};

const readProducerFields = (body) => {
  const name = text(body.name, 160);
  if (!name) throw httpError(400, 'Enter the producer (company) name.', 'name');
  const mobile = text(body.mobile, 15);
  if (!MOBILE_REGEX.test(mobile)) throw httpError(400, 'Enter a valid 10-digit mobile number.', 'mobile');
  const email = text(body.email, 150);
  if (!EMAIL_REGEX.test(email)) throw httpError(400, 'Enter a valid email address.', 'email');
  const categories = categoriesFrom(body.categories);
  if (!categories.length) throw httpError(400, 'Add at least one category (e.g. Honey, Wine).', 'categories');
  const doc = body.verificationDoc;
  const docRef = doc ? (typeof doc === 'string' ? doc : doc.ref) : null;
  if (docRef && !isStoredRef(docRef)) throw httpError(400, 'Upload the verification document again.', 'verificationDoc');
  return {
    name,
    mobile,
    email,
    categories,
    address: opt(body.address, 255),
    website: opt(body.website, 255),
    verificationDocUrl: docRef || null,
    verificationDocName: docRef ? opt(doc?.name, 200) : null,
  };
};

const usernameTaken = async (username, exceptId, transaction) =>
  Boolean(await User.findOne({ where: { username, ...(exceptId ? { id: { [Op.ne]: exceptId } } : {}) }, attributes: ['id'], transaction }));
const mobileFree = async (mobile, transaction) => !(await User.findOne({ where: { mobile }, attributes: ['id'], transaction }));

// POST /api/connect/admin/producers — registers a producer and its admin login.
// { name, categories, mobile, email, address?, website?, verificationDoc: {ref,name}, username, password, adminName? }
const createProducer = async (req, res) => {
  try {
    const body = req.body || {};
    const fields = readProducerFields(body);
    if (!fields.verificationDocUrl) throw httpError(400, 'Upload the verification document.', 'verificationDoc');
    const username = text(body.username, 50);
    if (!USERNAME_REGEX.test(username)) {
      throw httpError(400, 'Username: 3–50 letters, numbers, dots, dashes or underscores.', 'username');
    }
    const password = String(body.password || '');
    if (password.length < 8) throw httpError(400, 'The password must be at least 8 characters.', 'password');

    const result = await sequelize.transaction(async (transaction) => {
      if (await usernameTaken(username, null, transaction)) throw httpError(409, 'That username is already taken.', 'username');
      const producer = await Producer.create({ ...fields, createdBy: req.user.id }, { transaction });
      // The producer admin is an app account (username + password on the normal login page). Its
      // mobile is set only when no other account uses it already.
      const admin = await User.create(
        {
          username,
          passwordHash: await bcrypt.hash(password, 10),
          name: opt(body.adminName, 120) || fields.name,
          mobile: (await mobileFree(fields.mobile, transaction)) ? fields.mobile : null,
          countryCode: '+91',
          email: fields.email,
          producerId: producer.id,
          producerRole: 'admin',
          canChat: true,
          isAdmin: false,
          profileCompleted: true,
        },
        { transaction }
      );
      await recordProfileVersion(admin, { source: 'admin', changedBy: req.user.id, transaction });
      return { producer, admin };
    });
    return res.status(201).json({
      message: `${result.producer.name} registered. They can log in as ${username}.`,
      producer: producerJson(result.producer, req, { admin: producerUserJson(result.admin) }),
    });
  } catch (err) {
    return fail(res, err, 'Could not register the producer.');
  }
};

// GET /api/connect/admin/producers/:id — the producer, its users, products and batches.
const getProducer = async (req, res) => {
  try {
    const producer = await Producer.findByPk(req.params.id);
    if (!producer) return res.status(404).json({ message: 'Producer not found.' });
    const [users, products, batches, requests] = await Promise.all([
      User.findAll({ where: { producerId: producer.id }, order: [['producerRole', 'ASC'], ['createdAt', 'ASC']] }),
      ProducerProduct.findAll({ where: { producerId: producer.id }, order: [['createdAt', 'DESC']] }),
      ChainBatch.findAll({ where: { producerId: producer.id }, include: [{ model: ProducerProduct, as: 'product', attributes: ['id', 'name'] }], order: [['createdAt', 'DESC']] }),
      ChainBatchRequest.findAll({
        where: { producerId: producer.id },
        include: [
          { model: ProducerProduct, as: 'product', attributes: ['id', 'name'] },
          { model: User, as: 'requester', attributes: ['id', 'name', 'username'] },
        ],
        order: [['createdAt', 'DESC']],
        limit: 50,
      }),
    ]);
    const totals = await batchTotals(batches.map((b) => b.id));
    return res.status(200).json({
      producer: producerJson(producer, req, { totals: (await producerTotals([producer.id])).get(producer.id) }),
      users: await withLoginStats(users, producerUserJson),
      products: products.map((p) => productJson(p, req)),
      batches: batches.map((b) => batchJson(b, totals.get(b.id))),
      requests: requests.map(requestJson),
    });
  } catch (err) {
    return fail(res, err, 'Could not load the producer.');
  }
};

// GET /api/connect/admin/producers/:id/users/:userId/logins — a producer user's sign-ins.
const producerUserLogins = async (req, res) => {
  try {
    const user = await User.findOne({ where: { id: req.params.userId, producerId: req.params.id } });
    if (!user) return res.status(404).json({ message: 'User not found.' });
    const [summary] = await withLoginStats([user], producerUserJson);
    return res.status(200).json({ user: summary, logins: await loginHistory(user.id) });
  } catch (err) {
    return fail(res, err, 'Could not load the login history.');
  }
};

// PUT /api/connect/admin/producers/:id — company details (and the admin's login name).
const updateProducer = async (req, res) => {
  try {
    const producer = await Producer.findByPk(req.params.id);
    if (!producer) return res.status(404).json({ message: 'Producer not found.' });
    const fields = readProducerFields(req.body || {});
    if (!fields.verificationDocUrl) {
      fields.verificationDocUrl = producer.verificationDocUrl;
      fields.verificationDocName = producer.verificationDocName;
    }
    await producer.update(fields);
    return res.status(200).json({ message: 'Producer saved.', producer: producerJson(producer, req) });
  } catch (err) {
    return fail(res, err, 'Could not save the producer.');
  }
};

// PATCH /api/connect/admin/producers/:id/block { blocked } — blocks every login of the producer.
const blockProducer = async (req, res) => {
  try {
    const producer = await Producer.findByPk(req.params.id);
    if (!producer) return res.status(404).json({ message: 'Producer not found.' });
    await producer.update({ isBlocked: bool(req.body?.blocked) });
    return res.status(200).json({
      message: producer.isBlocked ? `${producer.name} is blocked.` : `${producer.name} is unblocked.`,
      producer: producerJson(producer, req),
    });
  } catch (err) {
    return fail(res, err, 'Could not update the producer.');
  }
};

// PUT /api/connect/admin/producers/:id/admin { username?, password?, name? } — the producer admin's
// login (e.g. a forgotten password).
const updateProducerAdmin = async (req, res) => {
  try {
    const admin = await User.findOne({ where: { producerId: req.params.id, producerRole: 'admin' } });
    if (!admin) return res.status(404).json({ message: 'Producer admin not found.' });
    const body = req.body || {};
    const changes = {};
    if (body.username !== undefined) {
      const username = text(body.username, 50);
      if (!USERNAME_REGEX.test(username)) throw httpError(400, 'Username: 3–50 letters, numbers, dots, dashes or underscores.', 'username');
      if (await usernameTaken(username, admin.id)) throw httpError(409, 'That username is already taken.', 'username');
      changes.username = username;
    }
    if (body.password) {
      if (String(body.password).length < 8) throw httpError(400, 'The password must be at least 8 characters.', 'password');
      changes.passwordHash = await bcrypt.hash(String(body.password), 10);
    }
    if (body.name !== undefined) changes.name = opt(body.name, 120);
    await admin.update(changes);
    return res.status(200).json({ message: 'Producer admin saved.', user: producerUserJson(admin) });
  } catch (err) {
    return fail(res, err, 'Could not save the producer admin.');
  }
};

// ---------- Distributors, retailers, consumers ----------
// All of them are app users who log in with mobile + OTP. Distributors and retailers are marked by
// users.partner_role, which only the superadmin sets; consumers are every other ordinary user.

const whereForRole = (role) => (role === 'consumer' ? CONSUMER_WHERE : { partnerRole: role });

// GET /api/connect/admin/accounts?role=&search=
const listAccounts = async (req, res) => {
  try {
    const role = ROLES.includes(req.query.role) ? req.query.role : 'retailer';
    const search = text(req.query.search, 100);
    const where = {
      ...whereForRole(role),
      ...(search
        ? { [Op.or]: ['mobile', 'name', 'businessName', 'city', 'email'].map((f) => ({ [f]: { [Op.like]: `%${search}%` } })) }
        : {}),
    };
    const accounts = await User.findAll({ where, include: accountInclude, order: [['createdAt', 'DESC']], limit: 1000 });
    return res.status(200).json({ accounts: accounts.map(accountJson) });
  } catch (err) {
    return fail(res, err, 'Could not load accounts.');
  }
};

const readAccountFields = (body, role) => {
  const name = text(body.name, 120);
  if (!name) throw httpError(400, 'Enter the name.', 'name');
  const email = opt(body.email, 150);
  if (email && !EMAIL_REGEX.test(email)) throw httpError(400, 'Enter a valid email address.', 'email');
  const businessName = opt(body.businessName, 160);
  if (role === 'distributor' && !businessName) throw httpError(400, 'Enter the business name.', 'businessName');
  return { name, email, businessName, city: opt(body.city, 120), address: opt(body.address, 255) };
};

const roleColumns = (role) => (role === 'consumer' ? { partnerRole: null, userType: 'consumer' } : { partnerRole: role, userType: role });

// A retailer's producer, or none: a general retailer (may sell any producer's batch that allows all
// retailers). Distributors and consumers: none.
const readPartnerProducer = async (body, role) => {
  if (role !== 'retailer') return { partnerProducerId: null };
  const producerId = Number(body.producerId) || null;
  if (producerId && !(await Producer.findByPk(producerId, { attributes: ['id'] }))) throw httpError(400, 'Choose one of the producers.', 'producerId');
  return { partnerProducerId: producerId };
};
const accountInclude = [{ model: Producer, as: 'partnerProducer', attributes: ['id', 'name'] }];

// POST /api/connect/admin/accounts { role, mobile, name, businessName?, email?, city?, address? }
// A mobile that already has an app account (e.g. a customer) is made a distributor / retailer.
const createAccount = async (req, res) => {
  try {
    const body = req.body || {};
    const role = body.role;
    if (!ROLES.includes(role)) throw httpError(400, 'Choose distributor, retailer or consumer.', 'role');
    // Retailers: name, mobile, email (+ optional shop details) and their producer, or general.
    if (role === 'retailer') {
      const { partnerProducerId } = await readPartnerProducer(body, role);
      const { user, outcome } = await saveRetailer(readRetailer(body), partnerProducerId, req.user.id);
      await user.reload({ include: accountInclude });
      const label = user.businessName || user.name;
      const whose = user.partnerProducer ? `a retailer of ${user.partnerProducer.name}` : 'a general retailer';
      return res.status(201).json({
        message: outcome === 'created' ? `${label} added as ${whose}.` : outcome === 'upgraded' ? `The existing account of ${label} is now ${whose}.` : `${label} is now ${whose}.`,
        account: accountJson(user),
      });
    }
    const mobile = text(body.mobile, 15);
    if (!MOBILE_REGEX.test(mobile)) throw httpError(400, 'Enter a valid 10-digit mobile number.', 'mobile');
    const fields = { ...readAccountFields(body, role), ...(await readPartnerProducer(body, role)) };

    const { user, upgraded } = await sequelize.transaction(async (transaction) => {
      const existing = await User.findOne({ where: { mobile }, transaction, lock: transaction.LOCK.UPDATE });
      if (existing) {
        if (existing.isAdmin || existing.isSuperAdmin || existing.producerId) {
          throw httpError(409, 'This mobile belongs to an admin or producer account.', 'mobile');
        }
        if (role === 'consumer' || existing.partnerRole) {
          throw httpError(409, existing.partnerRole ? `This mobile is already registered as a ${existing.partnerRole}.` : 'This mobile is already registered.', 'mobile');
        }
        await existing.update({ ...fields, ...roleColumns(role), profileCompleted: true }, { transaction });
        await recordProfileVersion(existing, { source: 'admin', changedBy: req.user.id, transaction });
        return { user: existing, upgraded: true };
      }
      const created = await User.create(
        { mobile, countryCode: '+91', ...fields, ...roleColumns(role), isAdmin: false, isBlocked: false, profileCompleted: true },
        { transaction }
      );
      await recordProfileVersion(created, { source: 'admin', changedBy: req.user.id, transaction });
      return { user: created, upgraded: false };
    });
    const label = user.businessName || user.name;
    await user.reload({ include: accountInclude });
    return res.status(201).json({
      message: upgraded ? `The existing account of ${label} is now a ${role}.` : `${label} added as a ${role}.`,
      account: accountJson(user),
    });
  } catch (err) {
    return fail(res, err, 'Could not add the account.');
  }
};

const ownAccount = async (id) => {
  const user = await User.findByPk(id);
  if (!user || user.isAdmin || user.isSuperAdmin || user.producerId) throw httpError(404, 'Account not found.');
  return user;
};

// PUT /api/connect/admin/accounts/:id { role, name, businessName, email, city, address, mobile? }
const updateAccount = async (req, res) => {
  try {
    const account = await ownAccount(req.params.id);
    const body = req.body || {};
    const role = ROLES.includes(body.role) ? body.role : account.partnerRole || 'consumer';
    const changes = { ...readAccountFields(body, role), ...roleColumns(role), ...(await readPartnerProducer(body, role)) };
    if (body.mobile !== undefined && body.mobile !== account.mobile) {
      const mobile = text(body.mobile, 15);
      if (!MOBILE_REGEX.test(mobile)) throw httpError(400, 'Enter a valid 10-digit mobile number.', 'mobile');
      if (await User.findOne({ where: { mobile, id: { [Op.ne]: account.id } }, attributes: ['id'] })) {
        throw httpError(409, 'This mobile is already registered.', 'mobile');
      }
      changes.mobile = mobile;
    }
    await sequelize.transaction(async (transaction) => {
      await account.update(changes, { transaction });
      await recordProfileVersion(account, { source: 'admin', changedBy: req.user.id, transaction });
    });
    await account.reload({ include: accountInclude });
    return res.status(200).json({ message: 'Saved.', account: accountJson(account) });
  } catch (err) {
    return fail(res, err, 'Could not save the account.');
  }
};

// PATCH /api/connect/admin/accounts/:id/block { blocked } — blocks the person's app login.
const blockAccount = async (req, res) => {
  try {
    const account = await ownAccount(req.params.id);
    await account.update({ isBlocked: bool(req.body?.blocked) });
    return res.status(200).json({ message: account.isBlocked ? 'Blocked.' : 'Unblocked.', account: accountJson(account) });
  } catch (err) {
    return fail(res, err, 'Could not update the account.');
  }
};

// ---------- Batch requests and batches ----------

const requestIncludes = [
  { model: Producer, as: 'producer', attributes: ['id', 'name'] },
  { model: ProducerProduct, as: 'product', attributes: ['id', 'name'] },
  { model: User, as: 'requester', attributes: ['id', 'name', 'username'] },
];

// GET /api/connect/admin/batch-requests?status=pending
const listRequests = async (req, res) => {
  try {
    const status = ['pending', 'allotted', 'rejected'].includes(req.query.status) ? req.query.status : null;
    const requests = await ChainBatchRequest.findAll({
      where: status ? { status } : {},
      include: requestIncludes,
      order: [['createdAt', status === 'pending' ? 'ASC' : 'DESC']],
      limit: 500,
    });
    return res.status(200).json({ requests: requests.map(requestJson) });
  } catch (err) {
    return fail(res, err, 'Could not load batch requests.');
  }
};

// The batch fields the superadmin confirms: quantity, max discount (0 / empty = no discount),
// expiry date, batch number and product. `fallback` fills in whatever the body leaves out.
const readBatchFields = async (body, producerId, fallback = {}) => {
  const pick = (key) => (body[key] !== undefined ? body[key] : fallback[key]);
  const quantity = Number(pick('quantity'));
  const maxDiscountPercent = discount(pick('maxDiscountPercent'));
  if (maxDiscountPercent === undefined) throw httpError(400, 'Max discount must be between 0 and 100%.', 'maxDiscountPercent');
  const expiryDate = pick('expiryDate');
  if (!validDate(expiryDate)) throw httpError(400, 'Choose the expiry date.', 'expiryDate');
  // The product is fixed when the batch is allotted (producers can't change it afterwards).
  const productId = Number(pick('productId')) || null;
  if (!productId) throw httpError(400, 'Choose the product for this batch.', 'productId');
  if (!(await ProducerProduct.findOne({ where: { id: productId, producerId }, attributes: ['id'] }))) {
    throw httpError(400, "That product doesn't belong to this producer.", 'productId');
  }
  return {
    quantity,
    maxDiscountPercent,
    expiryDate,
    productId,
    batchNo: opt(pick('batchNo'), 80),
    notes: opt(body.notes, 500),
  };
};

// POST /api/connect/admin/batch-requests/:id/allot { quantity?, maxDiscountPercent?, expiryDate?, batchNo?, productId?, notes? }
const allotRequest = async (req, res) => {
  try {
    const batch = await sequelize.transaction(async (transaction) => {
      const request = await ChainBatchRequest.findByPk(req.params.id, { transaction, lock: transaction.LOCK.UPDATE });
      if (!request) throw httpError(404, 'Request not found.');
      if (request.status !== 'pending') throw httpError(409, `This request was already ${request.status}.`);
      const producer = await Producer.findByPk(request.producerId, { transaction });
      if (producer.isBlocked) throw httpError(409, 'This producer is blocked. Unblock them first.');
      const fields = await readBatchFields(req.body || {}, request.producerId, request.get({ plain: true }));
      const made = await allotBatch({ ...fields, producerId: request.producerId, allottedBy: req.user.id }, transaction);
      await request.update(
        { status: 'allotted', decidedBy: req.user.id, decidedAt: new Date(), decisionNote: opt(req.body?.decisionNote, 500), batchId: made.id },
        { transaction }
      );
      return made;
    });
    const totals = await batchTotals([batch.id]);
    return res.status(201).json({
      message: `Batch ${batch.batchNo} allotted: ${batch.quantity} units (${batch.quantity * 2} QR codes).`,
      batch: batchJson(batch, totals.get(batch.id)),
    });
  } catch (err) {
    return fail(res, err, 'Could not allot the batch.');
  }
};

// POST /api/connect/admin/batch-requests/:id/reject { decisionNote? }
const rejectRequest = async (req, res) => {
  try {
    const request = await ChainBatchRequest.findByPk(req.params.id);
    if (!request) return res.status(404).json({ message: 'Request not found.' });
    if (request.status !== 'pending') return res.status(409).json({ message: `This request was already ${request.status}.` });
    await request.update({ status: 'rejected', decidedBy: req.user.id, decidedAt: new Date(), decisionNote: opt(req.body?.decisionNote, 500) });
    return res.status(200).json({ message: 'Request rejected.', request: requestJson(request) });
  } catch (err) {
    return fail(res, err, 'Could not reject the request.');
  }
};

// GET /api/connect/admin/batches?producerId=
const listBatches = async (req, res) => {
  try {
    const producerId = Number(req.query.producerId) || null;
    const batches = await ChainBatch.findAll({
      where: producerId ? { producerId } : {},
      include: [
        { model: Producer, as: 'producer', attributes: ['id', 'name'] },
        { model: ProducerProduct, as: 'product', attributes: ['id', 'name'] },
      ],
      order: [['createdAt', 'DESC']],
      limit: 1000,
    });
    const totals = await batchTotals(batches.map((b) => b.id));
    return res.status(200).json({ batches: batches.map((b) => batchJson(b, totals.get(b.id))) });
  } catch (err) {
    return fail(res, err, 'Could not load batches.');
  }
};

// POST /api/connect/admin/batches { producerId, quantity, maxDiscountPercent, expiryDate, batchNo?, productId?, notes? }
// — allots a batch without a request.
const createBatch = async (req, res) => {
  try {
    const producer = await Producer.findByPk(Number(req.body?.producerId) || 0);
    if (!producer) throw httpError(400, 'Choose the producer.', 'producerId');
    if (producer.isBlocked) throw httpError(409, 'This producer is blocked. Unblock them first.');
    const fields = await readBatchFields(req.body || {}, producer.id);
    const batch = await allotBatch({ ...fields, producerId: producer.id, allottedBy: req.user.id });
    const totals = await batchTotals([batch.id]);
    return res.status(201).json({
      message: `Batch ${batch.batchNo} allotted to ${producer.name}: ${batch.quantity} units (${batch.quantity * 2} QR codes).`,
      batch: batchJson(batch, totals.get(batch.id)),
    });
  } catch (err) {
    return fail(res, err, 'Could not allot the batch.');
  }
};

// GET /api/connect/admin/batches/:id — the batch and every unit in it.
const getBatch = async (req, res) => {
  try {
    const batch = await ChainBatch.findByPk(req.params.id, {
      include: [
        { model: Producer, as: 'producer', attributes: ['id', 'name'] },
        { model: ProducerProduct, as: 'product', attributes: ['id', 'name'] },
      ],
    });
    if (!batch) return res.status(404).json({ message: 'Batch not found.' });
    const units = await ChainUnit.findAll({
      where: { batchId: batch.id },
      include: [{ model: User, as: 'seller', attributes: ['id', 'name', 'businessName', 'city', 'isSuperAdmin', 'producerId'] }],
      order: [['serialNo', 'ASC']],
    });
    const totals = await batchTotals([batch.id]);
    return res.status(200).json({ batch: batchJson(batch, totals.get(batch.id)), units: units.map((u) => unitJson(u, { withTokens: true })) });
  } catch (err) {
    return fail(res, err, 'Could not load the batch.');
  }
};

// GET /api/connect/admin/batches/:id/file/:format (pdf|csv)
const downloadBatch = async (req, res) => {
  try {
    const batch = await ChainBatch.findByPk(req.params.id, { include: [{ model: Producer, as: 'producer', attributes: ['name'] }] });
    if (!batch) return res.status(404).json({ message: 'Batch not found.' });
    await sendBatchFile(req, res, batch, batch.producer?.name || 'Producer');
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ message: 'Could not prepare the file.' });
    else res.end();
  }
};

// GET /api/connect/admin/history?producerId=&filter=&q=&page=&pageSize= — the supply-chain history of
// every producer's QR codes (or one producer's).
const history = async (req, res) => {
  try {
    const producerId = Number(req.query.producerId) || null;
    return res.status(200).json(await queryHistory({ producerId, me: req.user.id, query: req.query }));
  } catch (err) {
    return fail(res, err, 'Could not load the history.');
  }
};

// PUT /api/connect/admin/batches/:id/print-layout { pageSize, perPage, orientation } — how the batch's
// QR PDF is laid out, for the superadmin and the producer alike.
const updatePrintLayout = async (req, res) => {
  try {
    const batch = await ChainBatch.findByPk(req.params.id, {
      include: [
        { model: Producer, as: 'producer', attributes: ['id', 'name'] },
        { model: ProducerProduct, as: 'product', attributes: ['id', 'name'] },
      ],
    });
    if (!batch) return res.status(404).json({ message: 'Batch not found.' });
    await batch.update(readPrintLayout(req.body || {}));
    const totals = await batchTotals([batch.id]);
    return res.status(200).json({ message: 'Print layout saved. Downloads use it from now on.', batch: batchJson(batch, totals.get(batch.id)) });
  } catch (err) {
    return fail(res, err, 'Could not save the print layout.');
  }
};

// GET /api/connect/admin/units/:id/qr/:format (json|pdf) — a unit's retailer + consumer QR codes.
const unitQr = async (req, res) => {
  try {
    const unit = await ChainUnit.findByPk(req.params.id, {
      include: [{ model: ChainBatch, as: 'batch', include: [{ model: Producer, as: 'producer', attributes: ['name'] }] }],
    });
    if (!unit) throw httpError(404, 'Unit not found.');
    await sendUnitQr(req, res, unit, unit.batch.producer?.name || 'Producer');
  } catch (err) {
    if (res.headersSent) return res.end();
    return fail(res, err, 'Could not prepare the QR codes.');
  }
};

module.exports = {
  unitQr,
  history,
  updatePrintLayout,
  overview,
  uploadFile,
  listProducers,
  createProducer,
  getProducer,
  producerUserLogins,
  updateProducer,
  blockProducer,
  updateProducerAdmin,
  listAccounts,
  createAccount,
  updateAccount,
  blockAccount,
  listRequests,
  allotRequest,
  rejectRequest,
  listBatches,
  createBatch,
  getBatch,
  downloadBatch,
};
