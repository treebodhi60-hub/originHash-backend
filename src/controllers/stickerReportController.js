const { User } = require('../models');
const { billingConfig, stickerUsage, recentExpiries } = require('../services/stickerService');
const { userCode } = require('../utils/roles');

const USER_ATTRIBUTES = ['id', 'name', 'username', 'mobile', 'userType', 'isAdmin', 'isSuperAdmin', 'isBlocked'];

const userJson = (user) =>
  user && {
    id: user.id,
    code: userCode(user.id),
    name: user.name || user.username || null,
    mobile: user.mobile || null,
    userType: user.userType || null,
    role: user.isSuperAdmin ? 'superadmin' : user.isAdmin ? 'admin' : 'user',
    isBlocked: Boolean(user.isBlocked),
  };

// GET /api/stickers/usage (admins) — every user who has bought stickers: bought, used, expired and
// left, per plan and in total, plus what expires in the next 30 days.
const getUsage = async (req, res) => {
  try {
    if (!billingConfig().enabled) return res.status(200).json({ enabled: false });
    const usage = await stickerUsage();
    const ids = usage.users.map((u) => u.userId);
    const people = ids.length ? await User.findAll({ where: { id: ids }, attributes: USER_ATTRIBUTES, paranoid: false }) : [];
    const byId = new Map(people.map((u) => [u.id, u]));
    return res.status(200).json({
      enabled: true,
      generatedAt: new Date(),
      expiringSoonDays: usage.expiringSoonDays,
      totals: usage.totals,
      byPlan: usage.byPlan,
      users: usage.users.map((u) => ({ user: userJson(byId.get(u.userId)) || { id: u.userId, code: userCode(u.userId) }, plans: u.plans, totals: u.totals })),
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Could not load the sticker report.' });
  }
};

// GET /api/stickers/usage/:userId (admins) — one user's figures per plan and their latest expiries.
const getUserUsage = async (req, res) => {
  try {
    if (!billingConfig().enabled) return res.status(200).json({ enabled: false });
    const userId = Number(req.params.userId);
    if (!Number.isInteger(userId) || userId < 1) return res.status(400).json({ message: 'Invalid user.' });
    // In order: stickerUsage first records any expiries that are due, so the list includes them.
    const usage = await stickerUsage({ userId });
    const expiries = await recentExpiries(userId);
    const entry = usage.users[0];
    return res.status(200).json({
      enabled: true,
      expiringSoonDays: usage.expiringSoonDays,
      plans: entry?.plans || {},
      totals: entry?.totals || usage.totals,
      expiries,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Could not load this user's stickers." });
  }
};

module.exports = { getUsage, getUserUsage };
