const { Op, QueryTypes } = require('sequelize');
const { sequelize, User, StickerPack, StickerPurchase, StickerTransaction } = require('../models');
const { PLAN_TYPES, PLAN_NAMES, planConfig, quotePurchase } = require('../config/plans');
const razorpay = require('./razorpayService');

const SWEEP_EVERY_MS = 15 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const EXPIRING_SOON_DAYS = 30; // "expiring soon" in the admin report

// Sticker billing is on once Razorpay keys are configured, so the code can ship before the keys
// do: until then stickers stay free, exactly as before.
const billingConfig = () => ({ enabled: razorpay.isConfigured(), currency: 'INR' });

const formatRupees = (paise) =>
  `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const qty = (n) => n.toLocaleString('en-IN');

const httpError = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });

// One line for the server log: is billing on, with which kind of keys, and is anything missing.
const billingStatus = () => {
  const { keyId, webhookSecret } = razorpay.config();
  if (!billingConfig().enabled) {
    return keyId
      ? 'Sticker billing: OFF — RAZORPAY_KEY_SECRET is missing.'
      : 'Sticker billing: OFF (stickers are free) — set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET to turn it on.';
  }
  const mode = keyId.startsWith('rzp_live_') ? 'LIVE' : keyId.startsWith('rzp_test_') ? 'TEST' : 'UNKNOWN';
  const notes = [];
  if (mode === 'UNKNOWN') notes.push('RAZORPAY_KEY_ID should start with rzp_test_ or rzp_live_');
  if (!webhookSecret) notes.push('RAZORPAY_WEBHOOK_SECRET is not set, so payments are only confirmed while the payer keeps the page open');
  return `Sticker billing: ON (${mode} keys, ${formatRupees(planConfig().payg.pricePerQrPaise)} per Pay As You Go sticker)${
    notes.length ? ` — warning: ${notes.join('; ')}.` : ''
  }`;
};

// Calendar months in UTC; a day that doesn't exist clamps to the month's end (31 Jan + 1 → 28/29 Feb).
const addMonths = (date, months) => {
  const d = new Date(date);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
};

// The user's row locked for update until `transaction` ends. Every change to a user's stickers
// runs under this lock, so two requests can't spend the same stickers or credit a payment twice.
const lockUser = async (userId, transaction) => {
  const user = await User.findByPk(userId, { attributes: ['id'], transaction, lock: transaction.LOCK.UPDATE });
  if (!user) throw httpError(404, 'User not found.');
  return user;
};

// Packs that expire first come first (any without an expiry date last).
const PACK_ORDER = [[sequelize.literal('cycle_end IS NULL'), 'ASC'], ['cycleEnd', 'ASC'], ['id', 'ASC']];

const findActivePacks = (userId, transaction) =>
  StickerPack.findAll({
    where: { userId, status: 'ACTIVE' },
    order: PACK_ORDER,
    transaction,
    ...(transaction && { lock: transaction.LOCK.UPDATE }),
  });

const balanceOf = (packs, planType) =>
  packs.filter((p) => p.planType === planType && p.status === 'ACTIVE').reduce((sum, p) => sum + p.stickersLeft, 0);

const record = (packs, pack, entry, transaction) =>
  StickerTransaction.create(
    { userId: pack.userId, planType: pack.planType, packId: pack.id, balanceAfter: balanceOf(packs, pack.planType), ...entry },
    { transaction }
  );

// Brings the user's packs up to date (user locked): unused stickers expire at the end of their
// month, a yearly Subscription refills for its next month, and finished packs end.
// Returns the ACTIVE packs.
const refreshPacks = async (userId, transaction, now = new Date()) => {
  const packs = await findActivePacks(userId, transaction);
  for (const pack of packs) {
    if (!pack.cycleEnd || pack.cycleEnd > now) continue;
    const left = pack.stickersLeft;
    const finished = !pack.periodEnd || pack.periodEnd <= now;
    if (finished) {
      await pack.update({ stickersLeft: 0, status: 'ENDED', endedReason: 'EXPIRED', endedAt: now }, { transaction });
    } else {
      // Which month of the period are we in? (Unused stickers from earlier months expire.)
      let k = 1;
      while (addMonths(pack.periodStart, k + 1) <= now) k += 1;
      const cycleEnd = addMonths(pack.periodStart, k + 1);
      await pack.update({ stickersLeft: 0, cycleEnd: cycleEnd > pack.periodEnd ? pack.periodEnd : cycleEnd }, { transaction });
    }
    if (left) {
      await record(packs, pack, { type: 'EXPIRE', stickers: -left, description: `${qty(left)} unused stickers expired` }, transaction);
    }
    if (!finished) {
      await pack.update({ stickersLeft: pack.monthlyQuota }, { transaction });
      await record(
        packs,
        pack,
        { type: 'REFILL', stickers: pack.monthlyQuota, description: `${qty(pack.monthlyQuota)} stickers for the new month` },
        transaction
      );
    }
  }
  return packs.filter((p) => p.status === 'ACTIVE');
};

// ---------- What the user sees ----------

const packJson = (pack) => ({
  id: pack.id,
  stickersLeft: pack.stickersLeft,
  billingCycle: pack.billingCycle,
  monthlyQuota: pack.monthlyQuota,
  extrasBought: pack.extrasBought,
  expiresAt: pack.cycleEnd, // null = never
  periodEnd: pack.periodEnd,
  boughtAt: pack.periodStart,
});

// One tab per plan the user has stickers from (in a fixed order), with the packs behind it.
const tabsJson = (packs) =>
  PLAN_TYPES.map((planType) => {
    const own = packs.filter((p) => p.planType === planType && p.status === 'ACTIVE');
    if (!own.length) return null;
    return { planType, name: PLAN_NAMES[planType], stickers: balanceOf(own, planType), packs: own.map(packJson) };
  }).filter(Boolean);

// Read-only look for display: one plain query, no locks. `stale` means a month has ended and the
// packs must be brought up to date (with the user locked) first.
const peekPacks = async (userId) => {
  const packs = await findActivePacks(userId);
  const now = new Date();
  return { packs, stale: packs.some((p) => p.cycleEnd && p.cycleEnd <= now) };
};

const currentTabs = async (userId) => {
  const { packs, stale } = await peekPacks(userId);
  if (!stale) return tabsJson(packs);
  return sequelize.transaction(async (transaction) => {
    await lockUser(userId, transaction);
    return tabsJson(await refreshPacks(userId, transaction));
  });
};

// ---------- Buying ----------

// The running Fixed + Variable month a purchase would add to (the one that ends last), if any.
const runningFixedPack = (packs) =>
  packs
    .filter((p) => p.planType === 'FIXED_VARIABLE' && p.status === 'ACTIVE')
    .sort((a, b) => b.periodEnd - a.periodEnd)[0] || null;

// What a purchase request buys and costs for this user right now (Fixed + Variable adds to a
// running month instead of starting a new one).
const quoteFor = async (userId, request) => {
  const { packs } = await peekPacks(userId);
  const running = request.planType === 'FIXED_VARIABLE' ? runningFixedPack(packs) : null;
  return quotePurchase(request, { fixedExtrasBought: running ? running.extrasBought : null });
};

// Puts a paid purchase's stickers into a pack (user locked, packs refreshed).
const creditPurchase = async (packs, purchase, transaction, now = new Date()) => {
  const { planType } = purchase;
  let pack = null;
  if (planType === 'FIXED_VARIABLE' && purchase.addOn) pack = runningFixedPack(packs);

  if (pack) {
    await pack.update(
      { stickersLeft: pack.stickersLeft + purchase.stickers, extrasBought: pack.extrasBought + purchase.quantity },
      { transaction }
    );
  } else {
    // Pay As You Go lasts its whole validity in one go; plans run month by month.
    const config = planConfig();
    const months =
      planType === 'PAYG'
        ? config.payg.validityMonths
        : planType === 'LIGHT'
          ? config.light.validityMonths
          : purchase.billingCycle === 'YEARLY'
            ? 12
            : 1;
    pack = await StickerPack.create(
      {
        userId: purchase.userId,
        planType,
        billingCycle: purchase.billingCycle,
        monthlyQuota: planType === 'SUBSCRIPTION' ? purchase.quantity : null,
        stickersLeft: purchase.stickers,
        extrasBought: planType === 'FIXED_VARIABLE' ? purchase.quantity : 0,
        periodStart: now,
        periodEnd: addMonths(now, months),
        // Pay As You Go (regular and light) lasts its whole validity in one go; plans run month by month.
        cycleEnd: addMonths(now, planType === 'PAYG' || planType === 'LIGHT' ? months : 1),
      },
      { transaction }
    );
    packs.push(pack);
  }
  await record(
    packs,
    pack,
    {
      type: 'PURCHASE',
      stickers: purchase.stickers,
      amountPaise: purchase.amountPaise,
      purchaseId: purchase.id,
      description: purchase.description,
    },
    transaction
  );
  return pack;
};

const PAYMENT_METHODS = { upi: 'UPI', card: 'card', netbanking: 'net banking', wallet: 'wallet', emi: 'EMI', paylater: 'pay later' };

// Credits a purchase from a Razorpay payment — exactly once. Called by both the browser's verify
// step and the webhook (whichever arrives first wins; the other finds it already PAID).
// `payment` must come from Razorpay itself (API fetch or a signature-checked webhook), never
// from the browser.
const settlePurchase = async ({ orderId, payment, userId = null }) => {
  const pending = await StickerPurchase.findOne({ where: { razorpayOrderId: orderId } });
  // Someone else's order looks exactly like a missing one.
  if (!pending || (userId !== null && pending.userId !== userId)) throw httpError(404, 'Payment not found.');

  return sequelize.transaction(async (transaction) => {
    const purchase = await StickerPurchase.findOne({ where: { id: pending.id }, transaction, lock: transaction.LOCK.UPDATE });

    if (purchase.status === 'PAID') {
      return { purchase, tabs: tabsJson(await findActivePacks(purchase.userId, transaction)), alreadyPaid: true };
    }

    if (payment.order_id !== orderId) throw httpError(400, 'This payment belongs to a different order.');
    if (payment.currency !== purchase.currency || Number(payment.amount) !== purchase.amountPaise) {
      throw httpError(400, 'The paid amount does not match this purchase. Contact support.');
    }
    if (payment.status !== 'captured') throw httpError(409, 'The payment has not been completed yet.');

    await lockUser(purchase.userId, transaction);
    const packs = await refreshPacks(purchase.userId, transaction);
    const method = PAYMENT_METHODS[payment.method] || payment.method || null;
    const pack = await creditPurchase(packs, purchase, transaction);
    await purchase.update(
      {
        status: 'PAID',
        razorpayPaymentId: payment.id,
        method: payment.method || null,
        lastError: null,
        paidAt: new Date(),
        packId: pack.id,
        description: `${purchase.description}${method ? ` · paid by ${method}` : ''}`.slice(0, 255),
      },
      { transaction }
    );
    return { purchase, tabs: tabsJson(packs), alreadyPaid: false };
  });
};

// ---------- Using ----------

// Takes `count` stickers from the user's `planType` tab for a batch, soonest-expiring pack first
// (user locked, packs refreshed). The caller has already checked the tab has enough. `batch` is a
// QR sticker batch ({ id, batchNo }), or { batchNo, label } for other batches (not linked by id).
const useStickers = async (packs, planType, count, batch, transaction) => {
  let needed = count;
  for (const pack of packs) {
    if (!needed) break;
    if (pack.planType !== planType || !pack.stickersLeft) continue;
    const take = Math.min(needed, pack.stickersLeft);
    await pack.update({ stickersLeft: pack.stickersLeft - take }, { transaction });
    needed -= take;
    await record(
      packs,
      pack,
      {
        type: 'GENERATE',
        stickers: -take,
        batchId: batch.id ?? null,
        description: `${qty(take)} stickers · ${batch.label || 'Batch'} ${batch.batchNo}`,
      },
      transaction
    );
  }
  if (needed) throw httpError(402, 'Not enough stickers.'); // unreachable after the caller's check
};

// Test-mode reset: the packs of one plan (or of every plan when `planType` is null) end, and their
// stickers are cleared in the ledger. Returns how many were cleared and the tabs left afterwards.
const resetPacks = async (userId, transaction, planType = null) => {
  const packs = await refreshPacks(userId, transaction);
  const now = new Date();
  let cleared = 0;
  for (const pack of packs) {
    if (planType && pack.planType !== planType) continue;
    const left = pack.stickersLeft;
    await pack.update({ stickersLeft: 0, status: 'ENDED', endedReason: 'RESET', endedAt: now }, { transaction });
    cleared += left;
    if (left) await record(packs, pack, { type: 'RESET', stickers: -left, description: 'Test-mode reset' }, transaction);
  }
  return { cleared, tabs: tabsJson(packs) };
};

// ---------- Admin report: bought, used, expired and left, per user and plan ----------

const PLAN_FIGURES = ['bought', 'used', 'expired', 'expiredRecent', 'cleared', 'left', 'expiringSoon', 'paidPaise'];
const emptyFigures = () => ({ ...Object.fromEntries(PLAN_FIGURES.map((k) => [k, 0])), nextExpiryAt: null, lastExpiredAt: null });

// Adds one plan's figures into a running total (dates keep the soonest next expiry / latest expiry).
const addFigures = (into, from) => {
  for (const key of PLAN_FIGURES) into[key] += from[key];
  if (from.nextExpiryAt && (!into.nextExpiryAt || from.nextExpiryAt < into.nextExpiryAt)) into.nextExpiryAt = from.nextExpiryAt;
  if (from.lastExpiredAt && (!into.lastExpiredAt || from.lastExpiredAt > into.lastExpiredAt)) into.lastExpiredAt = from.lastExpiredAt;
  return into;
};

// Every user's sticker figures, per plan, straight from the ledger (what was bought, used, expired
// and cleared) and the active packs (what's left, and how much of it expires in the next 30 days).
// Expiries are brought up to date first, so stickers past their date count as expired, not left.
// `userId` limits it to one user.
const stickerUsage = async ({ userId = null } = {}) => {
  await sweepDuePacks();
  const now = Date.now();
  const replacements = {
    userId,
    recent: new Date(now - EXPIRING_SOON_DAYS * DAY_MS),
    soon: new Date(now + EXPIRING_SOON_DAYS * DAY_MS),
  };
  const forUser = userId ? 'AND user_id = :userId' : '';
  const [ledger, packs] = await Promise.all([
    sequelize.query(
      `SELECT user_id AS userId, plan_type AS planType,
              SUM(CASE WHEN type IN ('PURCHASE', 'REFILL') THEN stickers ELSE 0 END) AS bought,
              SUM(CASE WHEN type = 'GENERATE' THEN -stickers ELSE 0 END) AS used,
              SUM(CASE WHEN type = 'EXPIRE' THEN -stickers ELSE 0 END) AS expired,
              SUM(CASE WHEN type = 'EXPIRE' AND created_at >= :recent THEN -stickers ELSE 0 END) AS expiredRecent,
              SUM(CASE WHEN type = 'RESET' THEN -stickers ELSE 0 END) AS cleared,
              SUM(CASE WHEN type = 'PURCHASE' THEN COALESCE(amount_paise, 0) ELSE 0 END) AS paidPaise,
              MAX(CASE WHEN type = 'EXPIRE' THEN created_at END) AS lastExpiredAt
       FROM sticker_transactions
       WHERE 1 = 1 ${forUser}
       GROUP BY user_id, plan_type`,
      { replacements, type: QueryTypes.SELECT }
    ),
    sequelize.query(
      `SELECT user_id AS userId, plan_type AS planType,
              SUM(stickers_left) AS \`left\`,
              SUM(CASE WHEN cycle_end <= :soon THEN stickers_left ELSE 0 END) AS expiringSoon,
              MIN(CASE WHEN stickers_left > 0 THEN cycle_end END) AS nextExpiryAt
       FROM sticker_packs
       WHERE status = 'ACTIVE' ${forUser}
       GROUP BY user_id, plan_type`,
      { replacements, type: QueryTypes.SELECT }
    ),
  ]);

  const users = new Map(); // userId → { plans: { PAYG: figures, … }, totals }
  const figuresFor = (row) => {
    if (!users.has(row.userId)) users.set(row.userId, { userId: row.userId, plans: {}, totals: emptyFigures() });
    const entry = users.get(row.userId);
    entry.plans[row.planType] ||= emptyFigures();
    return entry.plans[row.planType];
  };
  const date = (v) => (v ? new Date(v) : null);
  for (const row of ledger) {
    Object.assign(figuresFor(row), {
      bought: Number(row.bought),
      used: Number(row.used),
      expired: Number(row.expired),
      expiredRecent: Number(row.expiredRecent),
      cleared: Number(row.cleared),
      paidPaise: Number(row.paidPaise),
      lastExpiredAt: date(row.lastExpiredAt),
    });
  }
  for (const row of packs) {
    Object.assign(figuresFor(row), { left: Number(row.left), expiringSoon: Number(row.expiringSoon), nextExpiryAt: date(row.nextExpiryAt) });
  }

  const totals = emptyFigures();
  const byPlan = Object.fromEntries(PLAN_TYPES.map((p) => [p, emptyFigures()]));
  for (const entry of users.values()) {
    for (const [planType, figures] of Object.entries(entry.plans)) {
      addFigures(entry.totals, figures);
      addFigures(byPlan[planType], figures);
    }
    addFigures(totals, entry.totals);
  }
  return { expiringSoonDays: EXPIRING_SOON_DAYS, totals, byPlan, users: [...users.values()] };
};

// One user's most recent expiries, newest first (the EXPIRE rows of the ledger).
const recentExpiries = async (userId, limit = 25) =>
  (
    await StickerTransaction.findAll({
      where: { userId, type: 'EXPIRE' },
      order: [['id', 'DESC']],
      limit,
    })
  ).map((row) => ({ id: row.id, planType: row.planType, stickers: -row.stickers, description: row.description, at: row.createdAt }));

// ---------- Background expiry ----------

// Expires and refills packs on time even for users who aren't using the app (refreshPacks also runs
// on every sticker request, so nothing depends on this timer alone).
const sweepDuePacks = async () => {
  const due = await StickerPack.findAll({
    where: { status: 'ACTIVE', cycleEnd: { [Op.lte]: new Date() } },
    attributes: ['userId'],
    group: ['userId'],
    raw: true,
  });
  for (const { userId } of due) {
    try {
      await sequelize.transaction(async (transaction) => {
        await lockUser(userId, transaction);
        await refreshPacks(userId, transaction);
      });
    } catch (err) {
      console.error(`Sticker expiry for user ${userId} failed:`, err.message);
    }
  }
};

const startStickerSweeps = () => {
  const run = () => sweepDuePacks().catch((err) => console.error('Sticker sweep failed:', err.message));
  run();
  return setInterval(run, SWEEP_EVERY_MS).unref();
};

module.exports = {
  billingConfig,
  billingStatus,
  formatRupees,
  httpError,
  lockUser,
  refreshPacks,
  balanceOf,
  tabsJson,
  currentTabs,
  quoteFor,
  settlePurchase,
  useStickers,
  resetPacks,
  stickerUsage,
  recentExpiries,
  startStickerSweeps,
};
