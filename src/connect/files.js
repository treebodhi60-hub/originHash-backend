const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { uploadFileToS3, signedUrlFor } = require('../services/s3Service');

// Files of the supply-chain module: product images, NABL and other certificates, producer
// verification documents and warranty photos. Uploaded one at a time (POST …/uploads), stored on S3
// under connect/<folder>/ — or, when S3 isn't configured (local development), under
// backend/uploads/connect/. The database keeps the stored reference; every response hands out a
// fresh, time-limited link (S3 folders aren't all public).

const MAX_BYTES = 10 * 1024 * 1024;
const FOLDERS = ['products', 'certificates', 'documents', 'warranty', 'identity', 'chat', 'offers'];
const LOCAL_ROOT = path.join(__dirname, '..', '..', 'uploads');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/') || file.mimetype === 'application/pdf') cb(null, true);
    else cb(Object.assign(new Error('Only images and PDF files can be uploaded.'), { status: 400 }));
  },
});

// Multer errors (too large, wrong type) become a 400 the page can show.
const singleFile = (req, res, next) =>
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    const message = err.code === 'LIMIT_FILE_SIZE' ? 'That file is too large (max 10 MB).' : err.message;
    return res.status(400).json({ message });
  });

const s3Configured = () =>
  ['AWS_S3_ACCESS_KEY_ID', 'AWS_ACCESS_KEY_ID'].some((k) => process.env[k]) &&
  ['AWS_S3_SECRET_ACCESS_KEY', 'AWS_SECRET_ACCESS_KEY'].some((k) => process.env[k]) &&
  ['AWS_S3_REGION', 'AWS_REGION'].some((k) => process.env[k]) &&
  ['AWS_S3_BUCKET', 'S3_BUCKET'].some((k) => process.env[k]);

const safeName = (name) =>
  String(name || 'file')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .slice(-80);

// Stores an uploaded file; resolves to its reference (an S3 URL, or /uploads/connect/… locally).
const storeFile = async (file, folder) => {
  if (!FOLDERS.includes(folder)) throw Object.assign(new Error('Unknown upload folder.'), { status: 400 });
  if (s3Configured()) {
    return uploadFileToS3({ ...file, originalname: `${crypto.randomBytes(4).toString('hex')}-${safeName(file.originalname)}` }, `connect/${folder}`);
  }
  const dir = path.join(LOCAL_ROOT, 'connect', folder);
  await fs.promises.mkdir(dir, { recursive: true });
  const name = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${safeName(file.originalname)}`;
  await fs.promises.writeFile(path.join(dir, name), file.buffer);
  return `/uploads/connect/${folder}/${name}`;
};

// The hosts our S3 uploads live on: the bucket's own (virtual-hosted or path-style) and, if set,
// the public base URL's.
const ownS3Hosts = () => {
  const bucket = process.env.AWS_S3_BUCKET || process.env.S3_BUCKET;
  const base = process.env.AWS_S3_PUBLIC_BASE_URL || process.env.S3_PUBLIC_BASE_URL;
  let baseHost = null;
  try {
    baseHost = base ? new URL(base).hostname : null;
  } catch {
    baseHost = null;
  }
  return { bucket, baseHost };
};
const isOwnS3Url = (url) => {
  const { bucket, baseHost } = ownS3Hosts();
  if (!bucket) return false;
  const host = url.hostname.toLowerCase();
  if (baseHost && host === baseHost.toLowerCase()) return true;
  const b = bucket.toLowerCase();
  if (host.startsWith(`${b}.s3.`) || host.startsWith(`${b}.s3-`)) return host.endsWith('.amazonaws.com');
  // Path-style: s3.<region>.amazonaws.com/<bucket>/…
  return /^s3[.-]([a-z0-9-]+\.)?amazonaws\.com$/.test(host) && decodeURIComponent(url.pathname).startsWith(`/${bucket}/`);
};

// True for references made by storeFile (so a client can't point records at any URL it likes):
// our own S3 bucket, or our local uploads folder.
const isStoredRef = (ref) => {
  if (typeof ref !== 'string' || ref.length > 500) return false;
  if (ref.startsWith('/uploads/connect/')) return !ref.includes('..');
  try {
    const url = new URL(ref);
    return (
      url.protocol === 'https:' &&
      isOwnS3Url(url) &&
      /(^|\/)connect\/(products|certificates|documents|warranty|identity|chat|offers)\//.test(decodeURIComponent(url.pathname))
    );
  } catch {
    return false;
  }
};

// A link the browser can open, from a stored reference.
const fileUrl = (ref, req) => {
  if (!ref) return null;
  if (ref.startsWith('/uploads/')) return `${req.protocol}://${req.get('host')}${ref}`;
  return signedUrlFor(ref, 6 * 60 * 60);
};

const fileJson = (ref, req, name = null) => (ref ? { ref, url: fileUrl(ref, req), name: name || null } : null);

// Keeps only references storeFile made, from what a form sent back (an array of refs or {ref}).
const refsFrom = (list, max = 12) =>
  (Array.isArray(list) ? list : [])
    .map((item) => (typeof item === 'string' ? item : item?.ref))
    .filter(isStoredRef)
    .slice(0, max);

// An identity document sent back by a form ({ ref, name } or a ref): only files stored under
// connect/identity. Resolves to the users columns, or null when none was sent.
const identityDocFrom = (doc) => {
  const ref = typeof doc === 'string' ? doc : doc?.ref;
  if (!ref) return null;
  if (!isStoredRef(ref) || !/(^|\/)connect\/identity\//.test(decodeURIComponent(ref))) {
    throw Object.assign(new Error('Upload the identity document again.'), { status: 400, field: 'identityDoc' });
  }
  return { identityDocUrl: ref, identityDocName: typeof doc === 'object' && doc.name ? String(doc.name).slice(0, 200) : null };
};

module.exports = { singleFile, storeFile, isStoredRef, fileUrl, fileJson, refsFrom, identityDocFrom, FOLDERS };
