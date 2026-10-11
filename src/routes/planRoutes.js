const express = require('express');
const { protect } = require('../middleware/auth');
const { getCatalog } = require('../controllers/planController');

const router = express.Router();

router.use(protect);

router.get('/', getCatalog);

module.exports = router;
