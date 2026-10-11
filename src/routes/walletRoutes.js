const express = require('express');
const { protect } = require('../middleware/auth');
const { getWallet, createPurchase, verifyPurchase, listTransactions, resetWallet } = require('../controllers/walletController');

const router = express.Router();

// Every signed-in user has their own sticker balances; nobody can read or buy for anyone else's.
router.use(protect);

router.get('/', getWallet);
router.get('/transactions', listTransactions);
router.post('/purchases', createPurchase);
router.post('/purchases/verify', verifyPurchase);
router.post('/reset', resetWallet); // test keys only

module.exports = router;
