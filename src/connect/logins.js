const { fn, col } = require('sequelize');
const { UserLogin } = require('./models');

// Login history (table user_logins): written on every successful sign-in, read by the producer's
// Team page (first login, last login, history).

const clientIp = (req) => String(req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '').slice(0, 64) || null;

// Saves one sign-in. Never throws: a failed write must not stop the person logging in.
const recordLogin = async (user, req, method) => {
  try {
    await UserLogin.create({
      userId: user.id,
      producerId: user.producerId || null,
      method,
      ip: clientIp(req),
      userAgent: String(req.get('user-agent') || '').slice(0, 255) || null,
    });
  } catch (err) {
    console.error('Could not record the login:', err.message);
  }
};

// "Chrome on Windows", "Safari on iPhone"… from a user-agent string.
const deviceOf = (ua) => {
  if (!ua) return null;
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\/|Opera/.test(ua)
      ? 'Opera'
      : /SamsungBrowser/.test(ua)
        ? 'Samsung Internet'
        : /Firefox\/|FxiOS/.test(ua)
          ? 'Firefox'
          : /Chrome\/|CriOS/.test(ua)
            ? 'Chrome'
            : /Safari\//.test(ua)
              ? 'Safari'
              : null;
  const os = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Mac OS X|Macintosh/.test(ua)
            ? 'Mac'
            : /Linux/.test(ua)
              ? 'Linux'
              : null;
  if (browser && os) return `${browser} on ${os}`;
  return browser || os || 'Unknown device';
};

const loginJson = (l) => ({
  id: l.id,
  at: l.createdAt,
  method: l.method,
  ip: l.ip,
  device: deviceOf(l.userAgent),
});

// userId → { loginCount, firstLoginAt, lastLoginAt }
const loginStats = async (userIds) => {
  if (!userIds.length) return new Map();
  const rows = await UserLogin.findAll({
    where: { userId: userIds },
    attributes: ['userId', [fn('COUNT', col('id')), 'count'], [fn('MIN', col('created_at')), 'first'], [fn('MAX', col('created_at')), 'last']],
    group: ['userId'],
    raw: true,
  });
  return new Map(rows.map((r) => [r.userId, { loginCount: Number(r.count), firstLoginAt: r.first, lastLoginAt: r.last }]));
};

const NO_LOGINS = { loginCount: 0, firstLoginAt: null, lastLoginAt: null };
const withLoginStats = async (users, toJson) => {
  const stats = await loginStats(users.map((u) => u.id));
  return users.map((u) => ({ ...toJson(u), ...(stats.get(u.id) || NO_LOGINS) }));
};

const loginHistory = async (userId, limit = 100) =>
  (await UserLogin.findAll({ where: { userId }, order: [['id', 'DESC']], limit })).map(loginJson);

module.exports = { recordLogin, withLoginStats, loginHistory };
