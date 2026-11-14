const Producer = require('./producerModel');

// Who someone is in the supply-chain module, from their existing app account (req.user, set by
// the app's own `protect` / `optionalAuth`):
//   admin        the OriginHash superadmin (users.is_super_admin)
//   producer     a producer's admin or staff (users.producer_id; users.producer_role admin|staff)
//   distributor  registered by the superadmin (users.partner_role)
//   retailer     registered by the superadmin (users.partner_role) — may press Sold
//   viewer       any other admin of the main app (can look, can't act)
//   consumer     every other signed-in user
//   guest        not signed in
const chainRole = (user) => {
  if (!user) return 'guest';
  if (user.isSuperAdmin) return 'admin';
  if (user.producerId) return 'producer';
  if (user.partnerRole) return user.partnerRole;
  if (user.isAdmin) return 'viewer';
  return 'consumer';
};

// Sets req.chainRole (and req.producer for producer users). A blocked producer's users are
// turned away.
const loadChain = async (req, res, next) => {
  try {
    req.chainRole = chainRole(req.user);
    if (req.chainRole === 'producer') {
      const producer = await Producer.findByPk(req.user.producerId);
      if (!producer || producer.isBlocked) {
        return res.status(403).json({ message: 'This producer account has been blocked by OriginHash.' });
      }
      req.producer = producer;
    }
    return next();
  } catch (err) {
    return next(err);
  }
};

const isProducerAdmin = (req) => req.chainRole === 'producer' && req.user.producerRole === 'admin';

// Allows only the given roles; 'producer-admin' means the producer's admin.
const allow =
  (...roles) =>
  (req, res, next) => {
    const ok = roles.some((r) => (r === 'producer-admin' ? isProducerAdmin(req) : req.chainRole === r));
    return ok ? next() : res.status(403).json({ message: "Your account can't do this." });
  };

module.exports = { chainRole, loadChain, allow, isProducerAdmin };
