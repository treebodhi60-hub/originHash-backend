const { sequelize, User, Producer, PartnerApplication } = require('../models');
const { recordProfileVersion } = require('../../utils/profileHistory');
const { EMAIL_REGEX, maskMobile, text, opt, fail, httpError } = require('../util');
const { fileJson, identityDocFrom, storeFile } = require('../files');

// Retailer self-registration: any signed-in ordinary user registers (name, email, shop, city, an
// identity document and, optionally, the producer they sell for). That is only a request: they
// become a retailer when the OriginHash superadmin approves it — as a general retailer (no producer)
// or a retailer of one producer. Declined, they stay an ordinary customer. A general retailer can
// also ask to be associated with a producer the same way.

const applicationJson = (a, { forAdmin = false, req = null } = {}) =>
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
            identityDoc: req ? fileJson(a.user.identityDocUrl, req, a.user.identityDocName) : null,
          },
        }
      : {}),
  };

const producerInclude = { model: Producer, as: 'producer', attributes: ['id', 'name'] };
const activeProducers = () => Producer.findAll({ where: { isBlocked: false }, attributes: ['id', 'name'], order: [['name', 'ASC']] });

// Ordinary users, and general retailers (not yet associated with a producer), can apply.
const mayApply = (req) => req.chainRole === 'consumer' || (req.chainRole === 'retailer' && !req.user.partnerProducerId);

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
      producerId: req.user.partnerProducerId || null,
      producerName: req.user.partnerProducerId ? (await Producer.findByPk(req.user.partnerProducerId, { attributes: ['name'] }))?.name || null : null,
      application: applicationJson(application),
      // Their identity document, if they've given one (needed to register).
      identityDoc: fileJson(req.user.identityDocUrl, req, req.user.identityDocName),
      producers: producers.map((p) => ({ id: p.id, name: p.name })),
    });
  } catch (err) {
    return fail(res, err, 'Could not load your application.');
  }
};

// POST /api/connect/me/identity — upload an identity document (image or PDF) before registering.
const uploadIdentity = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'Choose an image or PDF of your ID.' });
    const ref = await storeFile(req.file, 'identity');
    return res.status(201).json({ file: fileJson(ref, req, req.file.originalname) });
  } catch (err) {
    return fail(res, err, "Couldn't upload the file. Please try again.");
  }
};

// POST /api/connect/me/retailer-application { name, email?, businessName?, city, address?, producerId?, note?, identityDoc }
// Saves their details and the request; nothing changes in what they may do until OriginHash
// approves it. An identity document is required (unless they already gave one).
const apply = async (req, res) => {
  try {
    if (!mayApply(req)) throw httpError(409, req.chainRole === 'retailer' ? 'You are already a retailer of a producer.' : "Your account can't register as a retailer.");
    const body = req.body || {};
    const identity = identityDocFrom(body.identityDoc);
    if (!identity && !req.user.identityDocUrl) throw httpError(400, 'Upload an identity document (an image or PDF of your ID).', 'identityDoc');
    const name = text(body.name, 120) || req.user.name;
    if (!name) throw httpError(400, 'Enter your name.', 'name');
    const email = opt(body.email, 150);
    if (email && !EMAIL_REGEX.test(email)) throw httpError(400, 'Enter a valid email address.', 'email');
    const businessName = opt(body.businessName, 160);
    const city = text(body.city, 120);
    if (!city) throw httpError(400, 'Enter your city.', 'city');
    const address = opt(body.address, 255);
    const producerId = Number(body.producerId) || null;
    if (producerId && !(await Producer.findOne({ where: { id: producerId, isBlocked: false }, attributes: ['id'] }))) {
      throw httpError(400, 'Choose one of the producers.', 'producerId');
    }
    if (await PartnerApplication.findOne({ where: { userId: req.user.id, status: 'pending' }, attributes: ['id'] })) {
      throw httpError(409, 'Your request is already waiting for OriginHash.');
    }
    const application = await sequelize.transaction(async (transaction) => {
      const user = await User.findByPk(req.user.id, { transaction, lock: transaction.LOCK.UPDATE });
      await user.update(
        {
          name,
          ...(email ? { email } : {}),
          ...(businessName ? { businessName } : {}),
          city,
          ...(address ? { address } : {}),
          ...(identity || {}),
          profileCompleted: true,
        },
        { transaction }
      );
      await recordProfileVersion(user, { source: 'self', changedBy: user.id, transaction });
      return PartnerApplication.create(
        { userId: user.id, role: 'retailer', producerId, businessName: businessName || name, city, address, note: opt(body.note, 500) },
        { transaction }
      );
    });
    await application.reload({ include: [producerInclude] });
    return res.status(201).json({
      message:
        req.chainRole === 'retailer'
          ? 'Request sent. OriginHash will review it and associate you with a producer.'
          : 'Request sent. OriginHash will review it; once approved you are a retailer and can mark products sold.',
      application: applicationJson(application),
    });
  } catch (err) {
    return fail(res, err, 'Could not register you as a retailer.');
  }
};

// ---------- OriginHash superadmin ----------

const adminIncludes = [
  producerInclude,
  { model: User, as: 'user', attributes: ['id', 'name', 'mobile', 'email', 'partnerRole', 'isBlocked', 'identityDocUrl', 'identityDocName'] },
];

// GET /api/connect/admin/retailer-applications?status=pending|approved|rejected
const listApplications = async (req, res) => {
  try {
    const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
    const [applications, pending] = await Promise.all([
      PartnerApplication.findAll({ where: { status }, include: adminIncludes, order: [['id', status === 'pending' ? 'ASC' : 'DESC']], limit: 500 }),
      PartnerApplication.count({ where: { status: 'pending' } }),
    ]);
    return res.status(200).json({ pending, applications: applications.map((a) => applicationJson(a, { forAdmin: true, req })) });
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
// Makes the applicant a retailer: of the chosen producer, or a general retailer (producerId empty).
// Without producerId at all, the producer they asked for (if any).
const approve = async (req, res) => {
  try {
    const body = req.body || {};
    const result = await sequelize.transaction(async (transaction) => {
      const application = await pendingApplication(req.params.id, transaction);
      const producerId = body.producerId === undefined ? application.producerId : Number(body.producerId) || null;
      const producer = producerId ? await Producer.findByPk(producerId, { attributes: ['id', 'name', 'isBlocked'], transaction }) : null;
      if (producerId && !producer) throw httpError(400, 'Choose one of the producers.', 'producerId');
      const user = await User.findByPk(application.userId, { transaction, lock: transaction.LOCK.UPDATE });
      if (!user) throw httpError(404, 'The applicant no longer has an account.');
      if (user.isAdmin || user.isSuperAdmin || user.producerId) throw httpError(409, 'The applicant is now an admin or producer account.');
      if (user.partnerRole && user.partnerRole !== 'retailer') throw httpError(409, `The applicant is already a ${user.partnerRole}.`);
      const businessName = opt(body.businessName, 160) || user.businessName || null;
      const city = opt(body.city ?? application.city, 120);
      const address = opt(body.address ?? application.address, 255);
      await user.update(
        { partnerRole: 'retailer', userType: 'retailer', partnerProducerId: producer ? producer.id : null, businessName, city, ...(address ? { address } : {}), profileCompleted: true },
        { transaction }
      );
      await recordProfileVersion(user, { source: 'admin', changedBy: req.user.id, transaction });
      await application.update(
        {
          status: 'approved',
          producerId: producer ? producer.id : null,
          businessName: businessName || application.businessName,
          city,
          address,
          decidedBy: req.user.id,
          decidedAt: new Date(),
          decisionNote: opt(body.decisionNote, 500),
        },
        { transaction }
      );
      return { application, user, producer };
    });
    const who = result.user.businessName || result.user.name || maskMobile(result.user.mobile);
    return res.status(200).json({
      message: result.producer ? `${who} is now a retailer of ${result.producer.name}.` : `${who} is now a general retailer (not associated with any producer).`,
    });
  } catch (err) {
    return fail(res, err, 'Could not approve the application.');
  }
};

// POST /api/connect/admin/retailer-applications/:id/reject { decisionNote? }
const reject = async (req, res) => {
  try {
    const user = await sequelize.transaction(async (transaction) => {
      const application = await pendingApplication(req.params.id, transaction);
      await application.update(
        { status: 'rejected', decidedBy: req.user.id, decidedAt: new Date(), decisionNote: opt(req.body?.decisionNote, 500) },
        { transaction }
      );
      return User.findByPk(application.userId, { attributes: ['partnerRole'], transaction });
    });
    return res.status(200).json({
      message:
        user?.partnerRole === 'retailer'
          ? 'Request declined. They stay a general retailer, not associated with any producer.'
          : 'Request declined. They stay a customer and are not a retailer.',
    });
  } catch (err) {
    return fail(res, err, 'Could not reject the application.');
  }
};

// For the superadmin overview: how many are waiting.
const pendingCount = () => PartnerApplication.count({ where: { status: 'pending' } });

module.exports = { myApplication, uploadIdentity, apply, listApplications, approve, reject, pendingCount };
