const { fileJson } = require('./files');
const { serialOf, percent, maskMobile, retailerQrUrl, consumerQrUrl } = require('./util');

// How the module's records go out in API responses. Functions taking `req` turn stored file
// references into links the browser can open.

// A producer's admin or staff member (a user with producer_id).
const producerUserJson = (u) =>
  u && {
    id: u.id,
    username: u.username,
    name: u.name,
    mobile: u.mobile,
    email: u.email,
    role: u.producerRole,
    canChat: u.producerRole === 'admin' || u.canChat,
    isBlocked: u.isBlocked,
    createdAt: u.createdAt,
  };

const producerJson = (p, req, extra = {}) =>
  p && {
    id: p.id,
    name: p.name,
    categories: p.categories || [],
    email: p.email,
    mobile: p.mobile,
    address: p.address,
    website: p.website,
    verificationDoc: fileJson(p.verificationDocUrl, req, p.verificationDocName),
    trackingEnabled: p.trackingEnabled,
    chatEnabled: p.chatEnabled,
    isBlocked: p.isBlocked,
    createdAt: p.createdAt,
    ...extra,
  };

// A distributor, retailer or consumer (an app user).
const accountJson = (u) =>
  u && {
    id: u.id,
    role: u.partnerRole || 'consumer',
    mobile: u.mobile,
    name: u.name,
    businessName: u.businessName,
    email: u.email,
    city: u.city,
    address: u.address,
    userType: u.userType,
    producerId: u.partnerProducerId ?? null,
    producerName: u.partnerProducer ? u.partnerProducer.name : null,
    isBlocked: u.isBlocked,
    createdAt: u.createdAt,
  };

const productJson = (p, req) =>
  p && {
    id: p.id,
    producerId: p.producerId,
    name: p.name,
    category: p.category,
    description: p.description,
    website: p.website,
    nablCertificate: fileJson(p.nablCertificateUrl, req, p.nablCertificateName),
    certifications: (p.certifications || []).map((c) => ({ title: c.title || '', ...fileJson(c.ref, req, c.name) })),
    images: (p.images || []).map((ref) => fileJson(ref, req)),
    warrantyTerms: p.warrantyTerms,
    warrantyDocs: (p.warrantyDocs || []).map((d) => ({ title: d.title || '', ...fileJson(d.ref, req, d.name) })),
    isActive: p.isActive,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };

const offerJson = (o) =>
  o && {
    id: o.id,
    productId: o.productId,
    productName: o.product ? o.product.name : null,
    title: o.title,
    couponCode: o.couponCode,
    discountPercent: percent(o.discountPercent),
    details: o.details,
    validTill: o.validTill,
    isActive: o.isActive,
    createdAt: o.createdAt,
  };

const batchJson = (b, totals = {}) =>
  b && {
    id: b.id,
    producerId: b.producerId,
    producerName: b.producer ? b.producer.name : undefined,
    productId: b.productId,
    productName: b.product ? b.product.name : null,
    batchNo: b.batchNo,
    quantity: b.quantity,
    maxDiscountPercent: percent(b.maxDiscountPercent),
    expiryDate: b.expiryDate,
    notes: b.notes,
    printLayout: { pageSize: b.printPageSize || 'A4', perPage: b.printPerPage || 40, orientation: b.printOrientation || 'horizontal' },
    allottedAt: b.createdAt,
    sold: Number(totals.sold || 0),
    consumerScans: Number(totals.consumerScans || 0),
    tradeScans: Number(totals.tradeScans || 0),
    couponsClaimed: Number(totals.claimed || 0),
    firstSerial: totals.firstId ? serialOf(totals.firstId) : null,
    lastSerial: totals.lastId ? serialOf(totals.lastId) : null,
  };

const requestJson = (r) =>
  r && {
    id: r.id,
    producerId: r.producerId,
    producerName: r.producer ? r.producer.name : undefined,
    productId: r.productId,
    productName: r.product ? r.product.name : null,
    quantity: r.quantity,
    maxDiscountPercent: percent(r.maxDiscountPercent),
    expiryDate: r.expiryDate,
    batchNo: r.batchNo,
    note: r.note,
    status: r.status,
    requestedBy: r.requester ? r.requester.name || r.requester.username : null,
    decidedAt: r.decidedAt,
    decisionNote: r.decisionNote,
    batchId: r.batchId,
    createdAt: r.createdAt,
  };

// Who did something: a name to show and what they were. `row.user` is the user behind it.
const personOf = (row) => {
  const type = row.actorType || row.addedByType || 'guest';
  const u = row.user;
  if (type === 'admin') return { type, name: 'OriginHash' };
  if (!u) return { type, name: type === 'guest' ? 'Guest' : null };
  return {
    type,
    name: u.businessName || u.name || u.username || maskMobile(u.mobile),
    contact: u.name && u.businessName ? u.name : null,
    city: u.city,
    mobile: u.mobile,
  };
};

const locationJson = (row) =>
  row.latitude !== null && row.latitude !== undefined && row.longitude !== null
    ? { latitude: Number(row.latitude), longitude: Number(row.longitude), name: row.locationName ?? null }
    : null;

const scanJson = (s) => ({
  id: s.id,
  at: s.createdAt,
  qrType: s.qrType,
  action: s.action,
  actorType: s.actorType,
  by: personOf(s),
  location: locationJson(s),
});

const warrantyJson = (w, req) => ({
  id: w.id,
  registeredOn: w.registeredOn,
  validTill: w.validTill,
  details: w.details,
  photos: (w.photos || []).map((ref) => fileJson(ref, req)),
  addedBy: personOf(w),
  createdAt: w.createdAt,
});

// The seller shown to people: the retailer's business, or OriginHash when its superadmin marked it sold.
const sellerJson = (unit) => {
  const u = unit.seller;
  if (!u) return null;
  if (u.isSuperAdmin) return { type: 'admin', name: 'OriginHash', city: null };
  return { type: 'retailer', name: u.businessName || u.name || 'Retailer', city: u.city };
};

const unitJson = (u, { withTokens = false } = {}) => ({
  id: u.id,
  serial: serialOf(u.id),
  serialNo: u.serialNo,
  status: u.status,
  soldAt: u.soldAt,
  soldBy: sellerJson(u),
  tradeScanCount: u.tradeScanCount,
  consumerScanCount: u.consumerScanCount,
  discountPercent: percent(u.discountPercent),
  couponCode: u.couponCode,
  couponClaimed: Boolean(u.couponClaimedBy),
  couponClaimedAt: u.couponClaimedAt,
  ...(withTokens
    ? {
        retailerToken: u.retailerToken,
        consumerToken: u.consumerToken,
        retailerQrUrl: retailerQrUrl(u.retailerToken),
        consumerQrUrl: consumerQrUrl(u.consumerToken),
      }
    : {}),
});

module.exports = {
  producerUserJson,
  producerJson,
  accountJson,
  productJson,
  offerJson,
  batchJson,
  requestJson,
  scanJson,
  warrantyJson,
  sellerJson,
  unitJson,
  personOf,
  locationJson,
};
