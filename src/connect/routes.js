const express = require('express');
const { protect, optionalAuth } = require('../middleware/auth');
const { loadChain, allow } = require('./access');
const { singleFile, storeFile, fileJson } = require('./files');
const { fail } = require('./util');
const admin = require('./controllers/adminController');
const producer = require('./controllers/producerController');
const qr = require('./controllers/qrController');
const chat = require('./controllers/chatController');
const applications = require('./controllers/applicationController');
const retailers = require('./controllers/retailerController');
const { queryHistory } = require('./history');

// Supply-chain module, mounted at /api/connect. Everyone signs in with their normal app account
// (the app's own token); ./access works out what they are in the supply chain.

const router = express.Router();
const signedIn = [protect, loadChain];
const maybeSignedIn = [optionalAuth, loadChain];

// ---------- OriginHash superadmin ----------
const hq = express.Router();
hq.use(signedIn, allow('admin'));
hq.get('/overview', admin.overview);
hq.get('/history', admin.history);
hq.get('/retailer-applications', applications.listApplications);
hq.post('/retailer-applications/:id/approve', applications.approve);
hq.post('/retailer-applications/:id/reject', applications.reject);
hq.post('/uploads', singleFile, admin.uploadFile);
hq.get('/producers', admin.listProducers);
hq.post('/producers', admin.createProducer);
hq.get('/producers/:id', admin.getProducer);
hq.get('/producers/:id/users/:userId/logins', admin.producerUserLogins);
hq.put('/producers/:id', admin.updateProducer);
hq.patch('/producers/:id/block', admin.blockProducer);
hq.put('/producers/:id/admin', admin.updateProducerAdmin);
hq.get('/accounts', admin.listAccounts);
hq.post('/accounts', admin.createAccount);
hq.put('/accounts/:id', admin.updateAccount);
hq.patch('/accounts/:id/block', admin.blockAccount);
hq.get('/batch-requests', admin.listRequests);
hq.post('/batch-requests/:id/allot', admin.allotRequest);
hq.post('/batch-requests/:id/reject', admin.rejectRequest);
hq.get('/batches', admin.listBatches);
hq.post('/batches', admin.createBatch);
hq.get('/batches/:id', admin.getBatch);
hq.get('/batches/:id/file/:format(pdf|csv)', admin.downloadBatch);
hq.put('/batches/:id/print-layout', admin.updatePrintLayout);
hq.put('/batches/:id/sold-access', retailers.setAdminSoldAccess);
hq.get('/retailers/template', retailers.template);
hq.post('/retailers/bulk', retailers.sheetUpload, retailers.importAny);
hq.get('/units/:id/qr/:format(json|pdf)', admin.unitQr);
router.use('/admin', hq);

// ---------- Producer (admin and staff) ----------
const pr = express.Router();
const producerAdmin = allow('producer-admin');
pr.use(signedIn, allow('producer'));
pr.get('/me', producer.me);
pr.post('/password', producer.changePassword);
pr.get('/overview', producer.overview);
pr.get('/history', producer.history);
pr.put('/settings', producerAdmin, producer.updateSettings);
pr.post('/uploads', singleFile, producer.uploadFile);
pr.get('/users', producer.listUsers);
pr.get('/users/:id/logins', producer.userLogins);
pr.post('/users', producerAdmin, producer.createUser);
pr.put('/users/:id', producerAdmin, producer.updateUser);
pr.patch('/users/:id/block', producerAdmin, producer.blockUser);
pr.get('/products', producer.listProducts);
pr.post('/products', producer.createProduct);
pr.get('/products/:id', producer.getProduct);
pr.put('/products/:id', producer.updateProduct);
pr.patch('/products/:id/active', producer.setProductActive);
pr.get('/offers', producer.listOffers);
pr.post('/offers', producer.createOffer);
pr.put('/offers/:id', producer.updateOffer);
pr.delete('/offers/:id', producer.deleteOffer);
pr.get('/batch-requests', producer.listRequests);
pr.post('/batch-requests', producer.createRequest);
pr.get('/batches', producer.listBatches);
pr.get('/batches/:id', producer.getBatch);
pr.get('/batches/:id/file/:format(pdf|csv)', producer.downloadBatch);
pr.put('/batches/:id/sold-access', producerAdmin, retailers.setProducerSoldAccess);
pr.get('/retailers', retailers.listMine);
pr.get('/retailers/template', retailers.template);
pr.post('/retailers', producerAdmin, retailers.createMine);
pr.post('/retailers/bulk', producerAdmin, retailers.sheetUpload, retailers.importMine);
pr.put('/retailers/:id', producerAdmin, retailers.updateMine);
pr.delete('/retailers/:id', producerAdmin, retailers.removeMine);
pr.get('/units/lookup', producer.lookupUnit);
pr.get('/units/:id', producer.getUnit);
pr.get('/units/:id/qr/:format(json|pdf)', producer.unitQr);
pr.post('/units/:id/warranty', producer.addWarranty);
pr.get('/chats', chat.producerThreads);
pr.get('/chats/:id', chat.producerMessages);
pr.post('/chats/:id/messages', chat.producerSend);
pr.post('/chat-photo', singleFile, chat.uploadPhoto);
pr.put('/chats/:id/assign', producerAdmin, chat.assignThread);
router.use('/producer', pr);

// ---------- Any signed-in user: their scans; retailers' warranty photos; consumers' chats ----------
const me = express.Router();
me.use(signedIn);
me.get('/history', qr.myHistory);
// A distributor's or retailer's own scans and sales: filterable, searchable, paginated.
me.get('/supply-history', allow('distributor', 'retailer'), async (req, res) => {
  try {
    return res.status(200).json(await queryHistory({ me: req.user.id, onlyMine: true, query: req.query }));
  } catch (err) {
    return fail(res, err, 'Could not load your history.');
  }
});
me.get('/retailer-application', applications.myApplication);
me.post('/identity', singleFile, applications.uploadIdentity);
me.post('/retailer-application', applications.apply);
me.post('/uploads', allow('retailer'), singleFile, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'Choose a file to upload.' });
    const ref = await storeFile(req.file, 'warranty');
    return res.status(201).json({ file: fileJson(ref, req, req.file.originalname) });
  } catch (err) {
    return fail(res, err, "Couldn't upload the file. Please try again.");
  }
});
// Chat with brand, as a customer: consumers, and retailers / distributors (they buy products too).
const customer = allow('consumer', 'retailer', 'distributor');
me.get('/chats', customer, chat.consumerThreads);
me.get('/chats/:producerId', customer, chat.consumerMessages);
me.post('/chats/:producerId/messages', customer, chat.consumerSend);
me.post('/chat-photo', customer, singleFile, chat.uploadPhoto);
router.use('/me', me);

// ---------- The QR codes ----------
router.post('/qr/r/:token/open', maybeSignedIn, qr.openRetailerQr);
// Sold: further limited in markSold to the unit's own producer and that producer's retailers.
router.post('/qr/r/:token/sold', signedIn, allow('retailer', 'admin', 'producer'), qr.markSold);
router.post('/qr/r/:token/warranty', signedIn, allow('retailer', 'admin', 'producer'), qr.addRetailerWarranty);
router.patch('/qr/scans/:scanToken/location', qr.addScanLocation);
router.post('/qr/c/:token/open', maybeSignedIn, qr.openConsumerQr);
router.post('/qr/c/:token/coupon', signedIn, allow('consumer'), qr.claimCoupon);

module.exports = router;
