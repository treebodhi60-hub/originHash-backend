const express = require('express');
const { protect, adminOnly } = require('../middleware/auth');
const { getUsage, getUserUsage } = require('../controllers/stickerReportController');

const router = express.Router();

// Sticker usage across users: admins and super-admins only.
router.use(protect, adminOnly);

router.get('/usage', getUsage);
router.get('/usage/:userId', getUserUsage);

module.exports = router;
