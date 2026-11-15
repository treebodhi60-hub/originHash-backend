const ExcelJS = require('exceljs');
const { sequelize, User, Producer } = require('./models');
const { recordProfileVersion } = require('../utils/profileHistory');
const { MOBILE_REGEX, EMAIL_REGEX, text, opt, httpError } = require('./util');
const { identityDocFrom } = require('./files');

// Creating retailers (auto-approved) for the superadmin and producers, one at a time or from an
// Excel / CSV sheet. A retailer is an app user (mobile + OTP login) with partner_role 'retailer';
// partner_producer_id is their producer, or null for a general retailer.

// 98765 43210, +91-9876543210, 09876543210, 9.87654321E9 (Excel) → 9876543210
const cleanMobile = (value) => {
  let digits = String(value ?? '').replace(/\.0+$/, '').replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return digits;
};

// { name, mobile, email?, businessName?, city?, address?, identityDoc? } → checked fields. The
// identity document is optional when a producer or the superadmin adds the retailer.
const readRetailer = (row) => {
  const name = text(row.name, 120);
  if (!name) throw httpError(400, 'Enter the name.', 'name');
  const mobile = cleanMobile(row.mobile);
  if (!MOBILE_REGEX.test(mobile)) throw httpError(400, 'Enter a valid 10-digit mobile number.', 'mobile');
  const email = opt(row.email, 150);
  if (email && !EMAIL_REGEX.test(email)) throw httpError(400, 'Enter a valid email address.', 'email');
  return {
    name,
    mobile,
    email,
    businessName: opt(row.businessName, 160),
    city: opt(row.city, 120),
    address: opt(row.address, 255),
    identity: identityDocFrom(row.identityDoc),
  };
};

// Makes `fields.mobile` a retailer of `producerId` (null = general retailer). A customer's existing
// account is upgraded; a general retailer is associated. Resolves to { user, outcome } where outcome
// is 'created' | 'upgraded' | 'associated' | 'updated'. `actorId` is who did it (profile history).
const saveRetailer = async (fields, producerId, actorId) =>
  sequelize.transaction(async (transaction) => {
    const columns = {
      name: fields.name,
      ...(fields.email ? { email: fields.email } : {}),
      ...(fields.businessName ? { businessName: fields.businessName } : {}),
      ...(fields.city ? { city: fields.city } : {}),
      ...(fields.address ? { address: fields.address } : {}),
      ...(fields.identity || {}),
      partnerRole: 'retailer',
      userType: 'retailer',
      partnerProducerId: producerId || null,
      profileCompleted: true,
    };
    const existing = await User.findOne({ where: { mobile: fields.mobile }, transaction, lock: transaction.LOCK.UPDATE });
    let user;
    let outcome;
    if (!existing) {
      user = await User.create({ mobile: fields.mobile, countryCode: '+91', isAdmin: false, isBlocked: false, ...columns }, { transaction });
      outcome = 'created';
    } else {
      if (existing.isAdmin || existing.isSuperAdmin || existing.producerId) throw httpError(409, 'This mobile belongs to an admin or producer account.', 'mobile');
      if (existing.partnerRole === 'distributor') throw httpError(409, 'This mobile is registered as a distributor.', 'mobile');
      if (existing.partnerRole === 'retailer' && existing.partnerProducerId && producerId && Number(existing.partnerProducerId) !== Number(producerId)) {
        const other = await Producer.findByPk(existing.partnerProducerId, { attributes: ['name'], transaction });
        throw httpError(409, `This mobile is already a retailer of ${other?.name || 'another producer'}.`, 'mobile');
      }
      if (existing.partnerRole === 'retailer' && existing.partnerProducerId && !producerId) {
        throw httpError(409, 'This mobile is already a retailer of a producer.', 'mobile');
      }
      outcome = existing.partnerRole !== 'retailer' ? 'upgraded' : existing.partnerProducerId ? 'updated' : producerId ? 'associated' : 'updated';
      // An existing account keeps its own name unless it had none.
      await existing.update({ ...columns, name: existing.name || columns.name }, { transaction });
      user = existing;
    }
    await recordProfileVersion(user, { source: 'admin', changedBy: actorId, transaction });
    return { user, outcome };
  });

// ---------- Sheets ----------

const MAX_ROWS = 1000;
const HEADER_KEYS = {
  name: ['name', 'retailer name', 'contact name', 'full name'],
  mobile: ['mobile', 'mobile number', 'phone', 'phone number', 'contact number'],
  email: ['email', 'mail', 'e-mail', 'email id', 'mail id'],
  businessName: ['business', 'business name', 'shop', 'shop name', 'store', 'store name'],
  city: ['city', 'town'],
  address: ['address', 'shop address'],
};
const keyFor = (header) => {
  const h = String(header ?? '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/[*:]/g, '').trim();
  return Object.keys(HEADER_KEYS).find((k) => HEADER_KEYS[k].includes(h)) || null;
};

const cellText = (value) => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    if (value.text) return String(value.text); // hyperlink / rich text
    if (value.richText) return value.richText.map((r) => r.text).join('');
    if (value.result !== undefined) return String(value.result); // formula
    if (value instanceof Date) return value.toISOString().slice(0, 10);
  }
  return String(value);
};

// Rows of a table whose first row holds the headers.
const rowsFrom = (table) => {
  const [head = [], ...body] = table;
  const keys = head.map(keyFor);
  if (!keys.includes('name') || !keys.includes('mobile')) {
    throw httpError(400, 'The first row must have the column headings, including Name and Mobile (Email is optional).');
  }
  const rows = body
    .map((cells, i) => {
      const row = { rowNo: i + 2 };
      keys.forEach((k, c) => {
        if (k) row[k] = cellText(cells[c]).trim();
      });
      return row;
    })
    .filter((r) => Object.keys(HEADER_KEYS).some((k) => r[k]));
  if (!rows.length) throw httpError(400, 'The sheet has no retailer rows.');
  if (rows.length > MAX_ROWS) throw httpError(400, `Upload at most ${MAX_ROWS} retailers at a time.`);
  return rows;
};

const parseCsv = (textContent) => {
  const out = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const s = textContent.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i += 1;
      row.push(cell);
      out.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    out.push(row);
  }
  return out;
};

// An uploaded .xlsx or .csv (multer file) → [{ rowNo, name, mobile, email, businessName, city, address }].
const readSheet = async (file) => {
  if (!file) throw httpError(400, 'Choose an Excel (.xlsx) or CSV file.');
  const name = (file.originalname || '').toLowerCase();
  if (name.endsWith('.csv')) return rowsFrom(parseCsv(file.buffer.toString('utf8')));
  if (!name.endsWith('.xlsx')) throw httpError(400, 'Upload an Excel .xlsx file (or a .csv). Older .xls files: save them as .xlsx first.');
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(file.buffer);
  } catch {
    throw httpError(400, "Couldn't read this Excel file. Save it as .xlsx and try again.");
  }
  const sheet = workbook.worksheets[0];
  if (!sheet) throw httpError(400, 'The Excel file has no sheets.');
  const table = [];
  sheet.eachRow({ includeEmpty: false }, (r) => {
    const cells = [];
    r.eachCell({ includeEmpty: true }, (cell, col) => {
      cells[col - 1] = cell.value;
    });
    table.push(cells);
  });
  return rowsFrom(table);
};

// Creates every row's retailer for `producerId` (null = general). Each row on its own, so one bad
// row doesn't stop the rest. Resolves to the counts and the rows that were skipped, with why.
const importRetailers = async (rows, producerId, actorId) => {
  const result = { created: 0, upgraded: 0, associated: 0, updated: 0, skipped: [] };
  const seen = new Set();
  for (const row of rows) {
    try {
      const fields = readRetailer(row);
      if (seen.has(fields.mobile)) throw httpError(400, 'This mobile appears twice in the sheet.');
      seen.add(fields.mobile);
      const { outcome } = await saveRetailer(fields, producerId, actorId);
      result[outcome] += 1;
    } catch (err) {
      if (!err.status) console.error('Retailer import row failed:', err);
      result.skipped.push({ row: row.rowNo, name: row.name || '', mobile: row.mobile || '', reason: err.status ? err.message : 'Could not save this row.' });
    }
  }
  return result;
};

// GET …/retailers/template — the sheet to fill in.
const sendTemplate = async (res) => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Retailers');
  sheet.columns = [
    { header: 'Name', key: 'name', width: 26 },
    { header: 'Mobile', key: 'mobile', width: 16 },
    { header: 'Email', key: 'email', width: 30 },
    { header: 'Business name', key: 'businessName', width: 28 },
    { header: 'City', key: 'city', width: 18 },
    { header: 'Address', key: 'address', width: 36 },
  ];
  sheet.getRow(1).font = { bold: true };
  sheet.getColumn('mobile').numFmt = '@';
  sheet.addRow({ name: 'Ravi Kumar', mobile: '9876543210', email: 'ravi@example.com', businessName: 'Ravi Wine Store', city: 'Hyderabad', address: 'Road 36, Jubilee Hills' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="retailers-template.xlsx"');
  await workbook.xlsx.write(res);
  res.end();
};

module.exports = { cleanMobile, readRetailer, saveRetailer, readSheet, importRetailers, sendTemplate, MAX_ROWS };
