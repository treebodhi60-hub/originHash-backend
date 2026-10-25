const express = require('express');
const { protect, stickerAccess } = require('../middleware/auth');
const {
  createBatch,
  checkBatchNo,
  listCodes,
  listFilters,
  verifyCode,
  downloadBatchPdf,
} = require('../controllers/qrStickerController');

const router = express.Router();

// Public — this is what a printed sticker's QR code links to.
router.get('/verify/:code', verifyCode);

// Any logged-in user (normal user, admin, or super-admin) — while stickerAccess lets normal users in.
router.use(protect, stickerAccess);

router.post('/batches', createBatch);
router.get('/batches/check', checkBatchNo);
router.get('/batches/:id/pdf', downloadBatchPdf);

router.get('/codes', listCodes);
router.get('/filters', listFilters);

module.exports = router;
