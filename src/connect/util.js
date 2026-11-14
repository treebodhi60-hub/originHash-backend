const crypto = require('crypto');

// Small helpers shared by the supply-chain ("Connect") controllers.

const MOBILE_REGEX = /^[6-9]\d{9}$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const USERNAME_REGEX = /^[a-zA-Z0-9._-]{3,50}$/;
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

// Trimmed string cut to `max`, or '' when not a string.
const text = (value, max = 255) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
// Like text(), but null when empty — for optional columns.
const opt = (value, max = 255) => text(value, max) || null;

const bool = (value) => value === true || value === 'true' || value === 1 || value === '1';

const validDate = (value) => {
  if (typeof value !== 'string' || !DATE_REGEX.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
};

// Today as YYYY-MM-DD in India (where the product is sold), for expiry checks.
const todayIST = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);

const coordinate = (value, limit) => {
  const n = Number(value);
  return value !== null && value !== undefined && value !== '' && Number.isFinite(n) && Math.abs(n) <= limit ? n : null;
};

// Discount percentage: null for "no discount" (empty or 0), a number 0–100 with 2 decimals, or
// undefined when it isn't a valid percentage.
const discount = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 100) return undefined;
  return n === 0 ? null : Math.round(n * 100) / 100;
};

// Tokens and coupon codes from an alphabet without look-alikes (no 0/O, 1/I/L).
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const randomCode = (length) => Array.from(crypto.randomBytes(length), (b) => ALPHABET[b % ALPHABET.length]).join('');
const TOKEN_LENGTH = 10;
const TOKEN_REGEX = /^[2-9A-HJKMNP-Z]{10}$/;
const newToken = () => randomCode(TOKEN_LENGTH);
const newCoupon = () => `OH${randomCode(8)}`;
const cleanToken = (value) => {
  const token = String(value || '').toUpperCase();
  return TOKEN_REGEX.test(token) ? token : null;
};

// The printed serial of a unit (both of its QR codes): OH000123.
const serialOf = (unitId) => `OH${String(unitId).padStart(6, '0')}`;
const unitIdFromSerial = (serial) => {
  const m = String(serial || '').trim().toUpperCase().match(/^OH0*(\d{1,9})$/);
  return m ? Number(m[1]) : null;
};

const appUrl = () => (process.env.PUBLIC_APP_URL || 'http://localhost:5173').replace(/\/+$/, '');
const retailerQrUrl = (token) => `${appUrl()}/rq/${token}`;
const consumerQrUrl = (token) => `${appUrl()}/cq/${token}`;

const maskMobile = (mobile) => (mobile ? `${mobile.slice(0, 2)}xxxxx${mobile.slice(-3)}` : null);

const percent = (value) => (value === null || value === undefined ? null : Number(value));

// Sends a JSON error and logs unexpected ones; for catch blocks.
const fail = (res, err, message) => {
  if (err?.status) return res.status(err.status).json({ message: err.message, field: err.field });
  if (err?.name === 'SequelizeUniqueConstraintError') {
    return res.status(409).json({ message: 'That value is already in use.' });
  }
  console.error(err);
  return res.status(500).json({ message });
};

// An error a controller throws to answer with `status`.
const httpError = (status, message, field) => Object.assign(new Error(message), { status, field });

module.exports = {
  MOBILE_REGEX,
  EMAIL_REGEX,
  USERNAME_REGEX,
  text,
  opt,
  bool,
  validDate,
  todayIST,
  coordinate,
  discount,
  newToken,
  newCoupon,
  cleanToken,
  serialOf,
  unitIdFromSerial,
  retailerQrUrl,
  consumerQrUrl,
  maskMobile,
  percent,
  fail,
  httpError,
};
