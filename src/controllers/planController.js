const { planConfig } = require('../config/plans');

// GET /api/plans — the price list (Pay As You Go, Subscription, Fixed + Variable). Plans are bought
// through POST /api/wallet/purchases.
const getCatalog = (req, res) => res.status(200).json(planConfig());

module.exports = { getCatalog };
