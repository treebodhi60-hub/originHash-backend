const { Op } = require('sequelize');
const { sequelize, StickerPurchase, StickerTransaction } = require('../models');
const { PLAN_TYPES, PLAN_NAMES, planConfig } = require('../config/plans');
const razorpay = require('../services/razorpayService');
const { isAdminUser } = require('../utils/roles');
const {
  billingConfig,
  lockUser,
  currentTabs,
  quoteFor,
  settlePurchase,
  resetPacks,
} = require('../services/stickerService');

const PURCHASES_PER_WINDOW = 10;
const PURCHASE_WINDOW_MS = 10 * 60 * 1000;
const ACTIVITY_PAGE_SIZE = 10;

const ORDER_ID = /^order_[A-Za-z0-9]{6,30}$/;
const PAYMENT_ID = /^pay_[A-Za-z0-9]{6,30}$/;

const sendError = (res, err, fallback) => {
  if (!err.status || err.status >= 500) console.error(err);
  return res.status(err.status || 500).json({ message: err.status ? err.message : fallback });
};

// GET /api/wallet — the signed-in user's sticker balances (one tab per plan they've bought from),
// the price list and the Razorpay key: everything the stickers page needs, in one request.
const getWallet = async (req, res) => {
  try {
    const config = billingConfig();
    return res.status(200).json({
      ...config,
      tabs: config.enabled ? await currentTabs(req.user.id) : [],
      catalog: config.enabled ? planConfig() : null,
      // Public by design: Checkout needs it in the browser. The key secret never leaves the server.
      razorpayKeyId: config.enabled ? razorpay.config().keyId : null,
    });
  } catch (err) {
    return sendError(res, err, 'Could not load your stickers.');
  }
};

// POST /api/wallet/purchases  { planType, billingCycle, quantity } — starts buying stickers.
// The price is worked out here and fixed on a Razorpay order before the user sees the payment
// screen; what the browser thinks it costs is never trusted.
const createPurchase = async (req, res) => {
  try {
    if (!billingConfig().enabled) {
      return res.status(503).json({ message: 'Online payments are not set up yet. Please try again later.' });
    }

    const { planType, billingCycle, quantity } = req.body || {};
    const quote = await quoteFor(req.user.id, { planType, billingCycle, quantity });

    const recent = await StickerPurchase.count({
      where: { userId: req.user.id, createdAt: { [Op.gte]: new Date(Date.now() - PURCHASE_WINDOW_MS) } },
    });
    if (recent >= PURCHASES_PER_WINDOW) {
      return res.status(429).json({ message: 'Too many payment attempts. Please wait a few minutes and try again.' });
    }

    const order = await razorpay.createOrder({
      amountPaise: quote.amountPaise,
      receipt: `sp_${req.user.id}_${Date.now()}`,
      notes: { purpose: 'sticker_purchase', plan_type: quote.planType, user_id: String(req.user.id) },
    });
    if (order.amount !== quote.amountPaise || order.currency !== 'INR') {
      return res.status(502).json({ message: 'Razorpay returned an unexpected order. Please try again.' });
    }

    await StickerPurchase.create({
      userId: req.user.id,
      planType: quote.planType,
      billingCycle: quote.billingCycle,
      quantity: quote.quantity,
      addOn: Boolean(quote.addOn),
      stickers: quote.stickers,
      description: quote.description,
      amountPaise: quote.amountPaise,
      razorpayOrderId: order.id,
    });

    const { name, email, mobile, countryCode } = req.user;
    return res.status(201).json({
      orderId: order.id,
      amountPaise: quote.amountPaise,
      currency: 'INR',
      description: quote.description,
      stickers: quote.stickers,
      keyId: razorpay.config().keyId,
      prefill: {
        name: name || undefined,
        email: email || undefined,
        contact: mobile ? `${countryCode || '+91'}${mobile}` : undefined,
      },
    });
  } catch (err) {
    return sendError(res, err, 'Could not start the payment. Please try again.');
  }
};

// POST /api/wallet/purchases/verify  { razorpayOrderId, razorpayPaymentId, razorpaySignature }
// Called by the browser after Checkout succeeds. Trusts nothing it sends beyond the IDs: the
// signature must match, and the payment's amount and status are re-read from Razorpay.
const verifyPurchase = async (req, res) => {
  try {
    const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body;
    if (!ORDER_ID.test(razorpayOrderId || '') || !PAYMENT_ID.test(razorpayPaymentId || '')) {
      return res.status(400).json({ message: 'Invalid payment details.' });
    }

    const purchase = await StickerPurchase.findOne({ where: { razorpayOrderId, userId: req.user.id } });
    if (!purchase) return res.status(404).json({ message: 'Payment not found.' });

    if (!razorpay.verifyPaymentSignature(razorpayOrderId, razorpayPaymentId, razorpaySignature)) {
      return res.status(400).json({ message: 'The payment could not be verified. If money was deducted, contact support.' });
    }

    let payment = await razorpay.fetchPayment(razorpayPaymentId);
    if (payment.order_id !== razorpayOrderId) {
      return res.status(400).json({ message: 'This payment belongs to a different order.' });
    }
    if (payment.status === 'failed') {
      await purchase.update({ lastError: (payment.error_description || 'Payment failed').slice(0, 255) });
      return res.status(402).json({ message: payment.error_description || 'The payment failed. Please try again.' });
    }
    if (payment.status === 'authorized') {
      payment = await razorpay.capturePayment(payment.id, purchase.amountPaise);
    }

    const result = await settlePurchase({ orderId: razorpayOrderId, payment, userId: req.user.id });
    return res.status(200).json({
      message: `${result.purchase.stickers.toLocaleString('en-IN')} stickers added.`,
      planType: result.purchase.planType,
      stickers: result.purchase.stickers,
      amountPaise: result.purchase.amountPaise,
      tabs: result.tabs,
      alreadyCredited: result.alreadyPaid,
    });
  } catch (err) {
    return sendError(res, err, 'Could not confirm the payment. If money was deducted, the stickers will be added shortly.');
  }
};

// POST /api/wallet/reset  { planType? } — TEST MODE, ADMINS ONLY: clears the admin's own sticker
// balance on one plan's tab (planType), or on every tab when it's left out, so
// purchases can be tried again from scratch. Refused whenever live Razorpay keys are configured, so
// it can never touch stickers someone paid real money for. Recorded in the ledger as RESET.
const resetWallet = async (req, res) => {
  try {
    if (!isAdminUser(req.user)) {
      return res.status(403).json({ message: 'Only admins can reset sticker balances.' });
    }
    if (!razorpay.config().keyId.startsWith('rzp_test_')) {
      return res.status(403).json({ message: 'Resetting is only available with Razorpay test keys.' });
    }
    const planType = req.body?.planType || null;
    if (planType && !PLAN_TYPES.includes(planType)) return res.status(400).json({ message: 'Choose a valid plan.' });
    const { cleared, tabs } = await sequelize.transaction(async (transaction) => {
      await lockUser(req.user.id, transaction);
      return resetPacks(req.user.id, transaction, planType);
    });
    const what = planType ? `${PLAN_NAMES[planType]} stickers` : 'stickers on every plan';
    return res.status(200).json({ message: `${cleared.toLocaleString('en-IN')} ${what} cleared (test mode).`, cleared, tabs });
  } catch (err) {
    return sendError(res, err, 'Could not reset your stickers.');
  }
};

// GET /api/wallet/transactions?page= — the sticker ledger, newest first.
const listTransactions = async (req, res) => {
  try {
    const requested = Math.max(1, Math.trunc(Number(req.query.page)) || 1);
    const total = await StickerTransaction.count({ where: { userId: req.user.id } });
    const totalPages = Math.max(1, Math.ceil(total / ACTIVITY_PAGE_SIZE));
    const page = Math.min(requested, totalPages);
    const rows = await StickerTransaction.findAll({
      where: { userId: req.user.id },
      order: [['id', 'DESC']],
      limit: ACTIVITY_PAGE_SIZE,
      offset: (page - 1) * ACTIVITY_PAGE_SIZE,
    });
    return res.status(200).json({
      transactions: rows.map((row) => ({
        id: row.id,
        type: row.type,
        planType: row.planType,
        stickers: row.stickers,
        balanceAfter: row.balanceAfter,
        amountPaise: row.amountPaise,
        description: row.description,
        batchId: row.batchId,
        createdAt: row.createdAt,
      })),
      total,
      page,
      totalPages,
    });
  } catch (err) {
    return sendError(res, err, 'Could not load your sticker activity.');
  }
};

// POST /api/payments/razorpay/webhook — Razorpay calls this for every payment event, so a purchase
// is credited even if the user closed the tab before the browser could verify it.
// Configure in Dashboard → Webhooks with events payment.captured, order.paid and payment.failed.
const razorpayWebhook = async (req, res) => {
  if (!razorpay.config().webhookSecret) {
    return res.status(503).json({ message: 'Webhook not configured.' });
  }
  if (!razorpay.verifyWebhookSignature(req.rawBody, req.get('x-razorpay-signature'))) {
    return res.status(400).json({ message: 'Invalid signature.' });
  }

  const { event, payload } = req.body || {};
  const payment = payload?.payment?.entity;
  if (!payment?.order_id) return res.status(200).json({ received: true });

  try {
    if (event === 'payment.captured' || event === 'order.paid') {
      await settlePurchase({ orderId: payment.order_id, payment });
    } else if (event === 'payment.failed') {
      await StickerPurchase.update(
        { lastError: (payment.error_description || 'Payment failed').slice(0, 255) },
        { where: { razorpayOrderId: payment.order_id, status: 'CREATED' } }
      );
    }
    return res.status(200).json({ received: true });
  } catch (err) {
    // Not one of our orders, or a mismatch a retry can't fix: acknowledge so Razorpay stops retrying.
    if (err.status && err.status < 500) {
      if (err.status !== 404) console.error(`Razorpay webhook ${event} for ${payment.order_id}: ${err.message}`);
      return res.status(200).json({ received: true });
    }
    console.error(err);
    return res.status(500).json({ message: 'Could not process the event.' }); // Razorpay retries
  }
};

module.exports = { getWallet, createPurchase, verifyPurchase, listTransactions, resetWallet, razorpayWebhook };
