const express = require('express');
const { sendOtp, verifyOtp, adminLogin, superAdminLogin } = require('../controllers/authController');

const router = express.Router();

router.post('/send-otp', sendOtp);
router.post('/verify-otp', verifyOtp);
router.post('/admin-login', adminLogin);
// The OriginHash superadmin signs in only here (its page is on a route no other page links to).
router.post('/superadmin-login', superAdminLogin);

module.exports = router;
