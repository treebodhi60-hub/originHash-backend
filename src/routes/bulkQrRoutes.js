const express = require('express');
const { protect, optionalAuth } = require('../middleware/auth');
const {
  createBulkBatch,
  listBulkBatches,
  getBulkBatch,
  getPublicBulkBatch,
  recordBulkScan,
  addBulkScanLocation,
  downloadBulkPdf,
} = require('../controllers/bulkQrController');

const router = express.Router();

// Public: what a printed bulk QR opens, for anyone holding the product. A scan is recorded with
// the signed-in user when there is one, and its location once the browser shares it.
router.get('/public/:code', getPublicBulkBatch);
router.post('/public/:code/scans', optionalAuth, recordBulkScan);
router.patch('/public/scans/:token/location', addBulkScanLocation);

// Signed in: create, list, look at and print (your own batches; every batch for admins).
router.post('/', protect, createBulkBatch);
router.get('/', protect, listBulkBatches);
router.get('/:id', protect, getBulkBatch);
router.get('/:id/pdf', protect, downloadBulkPdf);

module.exports = router;
