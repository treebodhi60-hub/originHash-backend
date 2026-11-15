const { sequelize, User, Producer, PartnerApplication } = require('../models');
const { recordProfileVersion } = require('../../utils/profileHistory');
const { maskMobile, text, opt, fail, httpError } = require('../util');

// Retailer sign-up: any signed-in ordinary user applies (business, city, address, the producer
// they sell for); the OriginHash superadmin approves — making them a retailer associated with one
// producer, whose products they may mark sold — or rejects.

const applicationJson = (a, { forAdmin = false } = {}) =>
  a && {
    id: a.id,
    role: a.role,
    status: a.status,
    businessName: a.businessName,
    city: a.city,
    address: a.address,
    note: a.note,
    producer: a.producer ? { id: a.producer.id, name: a.producer.name } : null,
    decisionNote: a.decisionNote,
    decidedAt: a.decidedAt,
    createdAt: a.createdAt,
    ...(forAdmin && a.user
      ? {
          user: {
            id: a.user.id,
            name: a.user.name,
            mobile: a.user.mobile,
            email: a.user.email,
            partnerRole: a.user.partnerRole,
            isBlocked: a.user.isBlocked,
          },
        }
      : {}),
  };

const producerInclude = { model: Producer, as: 'producer', attributes: ['id', 'name'] };
const activeProducers = () => Producer.findAll({ where: { isBlocked: false }, attributes: ['id', 'name'], order: [['name', 'ASC']] });

// Only ordinary users (not producers, admins or existing distributors / retailers) can apply.
const mayApply = (req) => req.chainRole === 'consumer';

// GET /api/connect/me/retailer-application — the latest application and the producers to pick from.
const myApplication = async (req, res) => {
  try {
    const [application, producers] = await Promise.all([
      PartnerApplication.findOne({ where: { userId: req.user.id }, include: [producerInclude], order: [['id', 'DESC']] }),
      activeProducers(),
    ]);
    return res.status(200).json({
      canApply: mayApply(req),
      role: req.chainRole,
      producerName: req.user.partnerProducerId ? (await Producer.findByPk(req.user.partnerProducerId, { attributes: ['name'] }))?.name || null : null,
      application: applicationJson(application),
      producers: producers.map((p) => ({ id: p.id, name: p.name })),
    });
  } catch (err) {
    return fail(res, err, 'Could not load your application.');
  }
};

// POST /api/connect/me/retailer-application { businessName, city, address?, producerId, note? }
const apply = async (req, res) => {
  try {
    if (!mayApply(req)) throw httpError(409, req.chainRole === 'retailer' ? 'You are already a retailer.' : "Your account can't apply to be a retailer.");
    const body = req.body || {};
    const businessName = text(body.businessName, 160);
    if (!businessName) throw httpError(400, 'Enter your shop or business name.', 'businessName');
    const city = text(body.city, 120);
    if (!city) throw httpError(400, 'Enter your city.', 'city');
    const producerId = Number(body.producerId) || null;
    if (!producerId) throw httpError(400, 'Choose the producer whose products you sell.', 'producerId');
    if (!(await Producer.findOne({ where: { id: producerId, isBlocked: false }, attributes: ['id'] }))) {
      throw httpError(400, 'Choose one of the producers.', 'producerId');
    }
    if (await PartnerApplication.findOne({ where: { userId: req.user.id, status: 'pending' }, attributes: ['id'] })) {
      throw httpError(409, 'Your application is already waiting for OriginHash. You can apply again if it is rejected.');
    }
    const application = await PartnerApplication.create({
      userId: req.user.id,
      role: 'retailer',
      producerId,
      businessName,
      city,
      address: opt(body.address, 255),
      note: opt(body.note, 500),
    });
    await application.reload({ include: [producerInclude] });
    return res.status(201).json({
      message: 'Application sent. OriginHash will review it; once approved you can mark products sold.',
      application: applicationJson(application),
    });
  } catch (err) {
    return fail(res, err, 'Could not send your application.');
  }
};

// ---------- OriginHash superadmin ----------

const adminIncludes = [producerInclude, { model: User, as: 'user', attributes: ['id', 'name', 'mobile', 'email', 'partnerRole', 'isBlocked'] }];

// GET /api/connect/admin/retailer-applications?status=pending|approved|rejected
const listApplications = async (req, res) => {
  try {
    const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
    const [applications, pending] = await Promise.all([
      PartnerApplication.findAll({ where: { status }, include: adminIncludes, order: [['id', status === 'pending' ? 'ASC' : 'DESC']], limit: 500 }),
      PartnerApplication.count({ where: { status: 'pending' } }),
    ]);
    return res.status(200).json({ pending, applications: applications.map((a) => applicationJson(a, { forAdmin: true })) });
  } catch (err) {
    return fail(res, err, 'Could not load the applications.');
  }
};

const pendingApplication = async (id, transaction) => {
  const application = await PartnerApplication.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
  if (!application) throw httpError(404, 'Application not found.');
  if (application.status !== 'pending') throw httpError(409, `This application was already ${application.status}.`);
  return application;
};

// POST /api/connect/admin/retailer-applications/:id/approve { producerId?, businessName?, city?, address? }
// Makes the applicant a retailer associated with the producer.
const approve = async (req, res) => {
  try {
    const body = req.body || {};
    const result = await sequelize.transaction(async (transaction) => {
      const application = await pendingApplication(req.params.id, transaction);
      const producerId = Number(body.producerId) || application.producerId;
      if (!producerId) throw httpError(400, 'Choose the producer this retailer sells for.', 'producerId');
      const producer = await Producer.findByPk(producerId, { attributes: ['id', 'name', 'isBlocked'], transaction });
      if (!producer) throw httpError(400, 'Choose one of the producers.', 'producerId');
      const user = await User.findByPk(application.userId, { transaction, lock: transaction.LOCK.UPDATE });
      if (!user) throw httpError(404, 'The applicant no longer has an account.');
      if (user.isAdmin || user.isSuperAdmin || user.producerId) throw httpError(409, 'The applicant is now an admin or producer account.');
      if (user.partnerRole && user.partnerRole !== 'retailer') throw httpError(409, `The applicant is already a ${user.partnerRole}.`);
      const businessName = text(body.businessName ?? application.businessName, 160) || application.businessName;
      const city = opt(body.city ?? application.city, 120);
      const address = opt(body.address ?? application.address, 255);
      await user.update(
        { partnerRole: 'retailer', userType: 'retailer', partnerProducerId: producer.id, businessName, city, ...(address ? { address } : {}), profileCompleted: true },
        { transaction }
      );
      await recordProfileVersion(user, { source: 'admin', changedBy: req.user.id, transaction });
      await application.update(
        { status: 'approved', producerId: producer.id, businessName, city, address, decidedBy: req.user.id, decidedAt: new Date(), decisionNote: opt(body.decisionNote, 500) },
        { transaction }
      );
      return { application, user, producer };
    });
    return res.status(200).json({
      message: `${result.user.businessName || result.user.name || maskMobile(result.user.mobile)} is now a retailer of ${result.producer.name}.`,
    });
  } catch (err) {
    return fail(res, err, 'Could not approve the application.');
  }
};

// POST /api/connect/admin/retailer-applications/:id/reject { decisionNote? }
const reject = async (req, res) => {
  try {
    await sequelize.transaction(async (transaction) => {
      const application = await pendingApplication(req.params.id, transaction);
      await application.update(
        { status: 'rejected', decidedBy: req.user.id, decidedAt: new Date(), decisionNote: opt(req.body?.decisionNote, 500) },
        { transaction }
      );
    });
    return res.status(200).json({ message: 'Application rejected.' });
  } catch (err) {
    return fail(res, err, 'Could not reject the application.');
  }
};

// For the superadmin overview: how many are waiting.
const pendingCount = () => PartnerApplication.count({ where: { status: 'pending' } });

module.exports = { myApplication, apply, listApplications, approve, reject, pendingCount };
