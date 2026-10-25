const express = require('express');
const { protect, optionalAuth, stickerAccess } = require('../middleware/auth');
const upload = require('../middleware/upload');
const {
  createLightBatch,
  listLightBatches,
  getLightBatch,
  downloadLightPdf,
  downloadLightCodePdf,
  getPublicCode,
  recordLightScan,
  addLightScanLocation,
  addLightUpdate,
  getLightHistory,
} = require('../controllers/lightQrController');

const router = express.Router();

// Upload errors (too large, not an image) become a 400 the page can show.
const updatePhoto = (req, res, next) =>
  upload.single('photo')(req, res, (err) => {
    if (!err) return next();
    const message = err.code === 'LIMIT_FILE_SIZE' ? 'That photo is too large (max 5 MB).' : err.message;
    return res.status(400).json({ message });
  });

// Public: what a printed code opens. Reading and scanning work signed in or not; adding an update
// needs a signed-in user (one each per code); the history is for admins and the batch's creator.
router.get('/public/:token', optionalAuth, getPublicCode);
router.post('/public/:token/scans', optionalAuth, recordLightScan);
router.patch('/public/scans/:scanToken/location', addLightScanLocation);
router.post('/public/:token/updates', protect, updatePhoto, addLightUpdate);
router.get('/public/:token/history', protect, getLightHistory);

// The creator's side (their own batches; every batch for admins).
router.post('/', protect, stickerAccess, createLightBatch);
router.get('/', protect, stickerAccess, listLightBatches);
router.get('/codes/:codeId/pdf', protect, stickerAccess, downloadLightCodePdf);
router.get('/:id', protect, stickerAccess, getLightBatch);
router.get('/:id/pdf', protect, stickerAccess, downloadLightPdf);

module.exports = router;
