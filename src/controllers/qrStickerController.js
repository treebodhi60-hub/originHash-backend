const axios = require('axios');
const sharp = require('sharp');
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const { Op } = require('sequelize');
const { sequelize, QrBatch, QrCode, ImageFolder, ImageAsset, User, UserProfileVersion } = require('../models');
const { canSeeFullJourney, isAdminUser } = require('../utils/roles');
const { TRACKED_FIELDS, profileChanges, recordProfileVersion } = require('../utils/profileHistory');
const { stickerQrPayload } = require('../utils/stickerQr');
const { PAGE_SIZE_NAMES, PAGE_MARGIN, GAP, DEFAULT_PER_PAGE, gridFor, maxPerPage, legacyPerPage } = require('../utils/stickerLayout');
const { drawCutLines, fitLine } = require('../utils/stickerPdf');
const { STICKER_SOURCES, PLAN_NAMES } = require('../config/plans');
const { billingConfig, lockUser, refreshPacks, balanceOf, tabsJson, useStickers } = require('../services/stickerService');

// Stickers only ever show this photo at business-card size, so re-encode it small
// before embedding — otherwise a batch's PDF balloons to tens of MB per full-res photo.
const STICKER_IMAGE_PX = 500;

const MIN_QRS = 1;
const MAX_QRS = 500;
const SPLIT_TYPES = ['vertical-50-50', 'horizontal-50-50'];

const slugifyForCode = (name) =>
  (name || 'PRODUCT')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'PRODUCT';

const batchJson = (batch) => ({
  id: batch.id,
  producer: batch.producer,
  productName: batch.productName,
  variantSize: batch.variantSize,
  batchNo: batch.batchNo,
  splitType: batch.splitType,
  pageSize: batch.pageSize || 'A4',
  labelsPerPage: batch.labelsPerPage || legacyPerPage(batch.pageSize || 'A4', batch.splitType),
  numberOfQrs: batch.numberOfQrs,
  folderId: batch.folderId,
  folderName: batch.folder ? batch.folder.name : undefined,
  folderDeleted: Boolean(batch.folder?.deletedAt),
  stickerSource: batch.stickerSource || null,
  createdAt: batch.createdAt,
});

// For admins: who generated a batch, the details they had at the time, and what has changed
// since — so batches made as "Harish" and as "Kumar" read as the same person. Needs the batch's
// `creator` and `creatorProfile` loaded.
const batchCreatorJson = (batch) => {
  if (!batch?.createdBy) return null;
  const { creator, creatorProfile } = batch;
  return {
    userId: batch.createdBy,
    name: creator?.name || null,
    username: creator?.username || null,
    mobile: creator?.mobile || null,
    generatedAs: creatorProfile
      ? Object.fromEntries([...TRACKED_FIELDS, 'versionNo'].map((field) => [field, creatorProfile[field]]))
      : null,
    changedSince: creatorProfile && creator ? profileChanges(creatorProfile, creator) : [],
  };
};

const codeJson = (code) => ({
  id: code.id,
  uuid: code.uuid,
  batchId: code.batchId,
  sequenceNo: code.sequenceNo,
  code: code.code,
  imageUrl: code.imageUrl,
  createdAt: code.createdAt,
  producer: code.batch?.producer,
  productName: code.batch?.productName,
  variantSize: code.batch?.variantSize,
  batchNo: code.batch?.batchNo,
  splitType: code.batch?.splitType,
  pageSize: code.batch?.pageSize || 'A4',
  labelsPerPage: code.batch ? code.batch.labelsPerPage || legacyPerPage(code.batch.pageSize || 'A4', code.batch.splitType) : undefined,
  folderName: code.batch?.folder?.name,
  folderDeleted: Boolean(code.batch?.folder?.deletedAt),
  stickerSource: code.batch?.stickerSource || null,
});

// Batch numbers are unique across every batch. Compared by the column's collation, so
// "b-001" and "B-001" count as the same number.
const batchNoTaken = async (batchNo) => Boolean(await QrBatch.findOne({ where: { batchNo }, attributes: ['id'] }));

const batchNoTakenMessage = (batchNo) => `Batch no "${batchNo}" already exists. Enter another batch number.`;

// GET /api/qr-stickers/batches/check?batchNo= — lets the form warn before submitting
const checkBatchNo = async (req, res) => {
  try {
    const batchNo = String(req.query.batchNo || '').trim();
    if (!batchNo) return res.status(200).json({ batchNo, exists: false });
    const exists = await batchNoTaken(batchNo);
    return res.status(200).json({ batchNo, exists, message: exists ? batchNoTakenMessage(batchNo) : undefined });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Could not check the batch number.' });
  }
};

// POST /api/qr-stickers/batches
const createBatch = async (req, res) => {
  try {
    const { producer, productName, variantSize, batchNo, splitType, numberOfQrs, folderId } = req.body;
    const pageSize = req.body.pageSize || 'A4';

    if (!producer?.trim() || !productName?.trim() || !batchNo?.trim()) {
      return res.status(400).json({ message: 'Producer, product name and batch no are required.' });
    }

    if (await batchNoTaken(batchNo.trim())) {
      return res.status(409).json({ message: batchNoTakenMessage(batchNo.trim()), field: 'batchNo' });
    }

    if (!SPLIT_TYPES.includes(splitType)) {
      return res.status(400).json({ message: 'Invalid split type.' });
    }

    if (!PAGE_SIZE_NAMES.includes(pageSize)) {
      return res.status(400).json({ message: 'Paper size must be A4 or A3.' });
    }

    // How many labels each PDF page holds; they shrink to fit when more than full size allows.
    const labelsPerPage = req.body.labelsPerPage == null || req.body.labelsPerPage === '' ? DEFAULT_PER_PAGE : Number(req.body.labelsPerPage);
    const mostPerPage = maxPerPage(pageSize, splitType);
    if (!Number.isInteger(labelsPerPage) || labelsPerPage < 1 || labelsPerPage > mostPerPage) {
      return res.status(400).json({ message: `Labels per page must be between 1 and ${mostPerPage} for ${pageSize}.`, field: 'labelsPerPage' });
    }

    const count = Number(numberOfQrs);
    if (!Number.isInteger(count) || count < MIN_QRS || count > MAX_QRS) {
      return res.status(400).json({ message: `Number of QRs must be between ${MIN_QRS} and ${MAX_QRS}.` });
    }

    // Once billing is on, stickers come out of one of the creator's plan balances (a tab).
    const billing = billingConfig();
    const source = billing.enabled ? req.body.source : null;
    if (billing.enabled && !STICKER_SOURCES.includes(source)) {
      return res.status(400).json({ message: 'Choose which sticker balance to use.' });
    }

    // All or nothing, holding a shared lock on the folder: a sample folder can't be deleted while
    // stickers are being made from it, and one deleted a moment ago is simply not found.
    // With billing on, the user is locked too: the balance check, the stickers and taking them
    // from the balance commit together, so concurrent requests can't spend the same stickers twice.
    const result = await sequelize.transaction(async (transaction) => {
      const folder = await ImageFolder.findByPk(folderId, { transaction, lock: transaction.LOCK.SHARE });
      if (!folder) return { status: 404, message: 'Selected folder was not found.' };

      const availableImages = await ImageAsset.findAll({ where: { folderId, isBlocked: false }, transaction });
      if (!availableImages.length) {
        return { status: 400, message: 'Selected folder has no available (unblocked) images.' };
      }

      let packs = null;
      if (source) {
        await lockUser(req.user.id, transaction);
        packs = await refreshPacks(req.user.id, transaction);
        const available = balanceOf(packs, source);
        if (available < count) {
          return {
            status: 402,
            message: `Not enough stickers: this batch needs ${count} and your ${PLAN_NAMES[source]} balance has ${available}. Buy more or use another balance.`,
            extra: { code: 'INSUFFICIENT_STICKERS', source, available, tabs: tabsJson(packs) },
          };
        }
      }

      // Pin the creator's details as they are right now, so a later rename can't blur who made this.
      const creatorProfile = await recordProfileVersion(req.user, { source: 'system', transaction });

      const batch = await QrBatch.create(
        {
          producer: producer.trim(),
          productName: productName.trim(),
          variantSize: variantSize?.trim() || null,
          batchNo: batchNo.trim(),
          splitType,
          pageSize,
          labelsPerPage,
          numberOfQrs: count,
          folderId,
          createdBy: req.user.id,
          creatorProfileVersionId: creatorProfile.id,
          stickerSource: source,
        },
        { transaction }
      );

      const codes = [];
      for (let i = 1; i <= count; i++) {
        const image = availableImages[Math.floor(Math.random() * availableImages.length)];
        const code = await QrCode.create({ batchId: batch.id, sequenceNo: i, imageUrl: image.url }, { transaction });
        code.code = `${slugifyForCode(productName)}-${String(code.id).padStart(5, '0')}`;
        await code.save({ transaction });
        codes.push(code);
      }

      if (source) await useStickers(packs, source, count, batch, transaction);
      return { folder, batch, codes, tabs: packs && tabsJson(packs) };
    });

    if (result.status) {
      return res.status(result.status).json({ message: result.message, ...result.extra });
    }
    const { folder, batch, codes, tabs } = result;

    return res.status(201).json({
      message: `${count} QR sticker(s) generated.`,
      batch: batchJson({ ...batch.toJSON(), folder }),
      codes: codes.map((c) => codeJson(c)),
      ...(source && { stickers: { source, used: count, left: tabs.find((t) => t.planType === source)?.stickers ?? 0, tabs } }),
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: err.message || 'Could not generate QR stickers.' });
  }
};

// GET /api/qr-stickers/codes ?search=&producer=&batchNo=
const listCodes = async (req, res) => {
  try {
    const { search = '', producer = '', batchNo = '' } = req.query;

    const where = {};
    if (search) {
      where[Op.or] = [
        { code: { [Op.like]: `%${search}%` } },
        { '$batch.producer$': { [Op.like]: `%${search}%` } },
        { '$batch.product_name$': { [Op.like]: `%${search}%` } },
        { '$batch.batch_no$': { [Op.like]: `%${search}%` } },
      ];
    }
    if (producer) where['$batch.producer$'] = producer;
    if (batchNo) where['$batch.batch_no$'] = batchNo;

    // Only admins see who generated each batch.
    const isAdmin = isAdminUser(req.user);
    const batchIncludes = [{ model: ImageFolder, as: 'folder', attributes: ['name', 'deletedAt'], paranoid: false }];
    if (isAdmin) {
      batchIncludes.push(
        { model: User, as: 'creator', attributes: ['id', 'username', ...TRACKED_FIELDS] },
        { model: UserProfileVersion, as: 'creatorProfile' }
      );
    }

    const codes = await QrCode.findAll({
      where,
      include: [{ model: QrBatch, as: 'batch', required: true, include: batchIncludes }],
      order: [['created_at', 'DESC']],
      subQuery: false,
    });

    return res.status(200).json({
      codes: codes.map((code) => ({
        ...codeJson(code),
        canViewJourney: canSeeFullJourney(req.user, code),
        ...(isAdmin && { creator: batchCreatorJson(code.batch) }),
      })),
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Could not load generated QR codes.' });
  }
};

// GET /api/qr-stickers/verify/:code — public; this is what the printed QR links to
const verifyCode = async (req, res) => {
  try {
    const codeRow = await QrCode.findOne({
      where: { code: req.params.code },
      include: [{ model: QrBatch, as: 'batch' }],
    });

    if (!codeRow) {
      return res.status(404).json({ message: 'This code was not found.' });
    }

    return res.status(200).json({
      code: codeRow.code,
      imageUrl: codeRow.imageUrl,
      producer: codeRow.batch.producer,
      productName: codeRow.batch.productName,
      variantSize: codeRow.batch.variantSize,
      batchNo: codeRow.batch.batchNo,
      createdAt: codeRow.createdAt,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Could not load this code.' });
  }
};

// GET /api/qr-stickers/filters — distinct producer / batch no values for the History filters
const listFilters = async (req, res) => {
  try {
    const batches = await QrBatch.findAll({ attributes: ['producer', 'batchNo'], raw: true });
    const producers = [...new Set(batches.map((b) => b.producer))].sort();
    const batchNos = [...new Set(batches.map((b) => b.batchNo))].sort();
    return res.status(200).json({ producers, batchNos });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Could not load filters.' });
  }
};

// The photo is printed as a square tile the exact size of the QR, so crop it square here —
// centred on the most interesting region (faces, the animal) rather than the geometric middle.
const fetchImageBuffer = async (url, cache) => {
  if (cache.has(url)) return cache.get(url);
  const { data } = await axios.get(url, { responseType: 'arraybuffer' });
  const source = Buffer.from(data);
  const { width = STICKER_IMAGE_PX, height = STICKER_IMAGE_PX } = await sharp(source).metadata();
  const side = Math.min(STICKER_IMAGE_PX, width, height);
  const resized = await sharp(source)
    .rotate() // honour EXIF orientation from phone photos
    .resize(side, side, { fit: 'cover', position: sharp.strategy.attention })
    .flatten({ background: '#ffffff' }) // transparent PNGs sit on white, not black
    .jpeg({ quality: 78 })
    .toBuffer();
  cache.set(url, resized);
  return resized;
};

const drawStickerHeader = (doc, x, y, w, { producer, batchNo, packedDate, productName, variantSize }, compact) => {
  const pad = compact ? 7 : 10;
  const bandH = compact ? 26 : 30;
  doc.rect(x, y, w, bandH).fill('#163832');
  fitLine(doc, producer.toUpperCase(), x + pad, y + (compact ? 4.5 : 6), w - pad * 2, {
    size: compact ? 8 : 9,
    minSize: 6.5,
    font: 'Helvetica-Bold',
    color: '#ffffff',
  });
  fitLine(doc, `Batch ${batchNo} · Packed ${packedDate}`, x + pad, y + (compact ? 15.5 : 18), w - pad * 2, {
    size: compact ? 5.5 : 6.5,
    minSize: 4.5,
    color: '#c9a464',
  });
  fitLine(doc, productName, x + pad, y + (compact ? 30 : 36), w - pad * 2, {
    size: compact ? 8 : 9,
    minSize: 6.5,
    font: 'Helvetica-Bold',
    color: '#163832',
    align: 'center',
  });
  if (variantSize) {
    fitLine(doc, variantSize, x + pad, y + (compact ? 39.5 : 48), w - pad * 2, {
      size: compact ? 5.5 : 6.5,
      minSize: 4.5,
      color: '#6b7280',
      align: 'center',
    });
  }
};

// "ORIGINHASH" on the left and the code on the right; on a narrow card with a long code, the
// code (which people type in when a QR won't scan) takes the whole line instead.
const drawStickerFooter = (doc, x, y, w, code, pad) => {
  const inner = w - pad * 2;
  doc.font('Helvetica-Bold');
  const brandW = doc.fontSize(5).widthOfString('ORIGINHASH');
  let size = 6;
  while (size > 4.5 && doc.fontSize(size).widthOfString(code) > inner - brandW - 6) size -= 0.25;
  if (doc.fontSize(size).widthOfString(code) <= inner - brandW - 6) {
    doc.fillColor('#163832').fontSize(5).text('ORIGINHASH', x + pad, y + 1, { lineBreak: false });
    doc.fillColor('#163832').fontSize(size).text(code, x + pad, y, { width: inner, align: 'right', lineBreak: false });
  } else {
    fitLine(doc, code, x + pad, y, inner, { size: 6, minSize: 4, font: 'Helvetica-Bold', color: '#163832', align: 'center' });
  }
};

// The photo and the QR are always the same square, so the pair reads as one matched set.
// The photo arrives pre-cropped square (fetchImageBuffer); if it failed to load, a cream
// placeholder keeps the composition balanced.
const drawPhotoTile = (doc, imageBuffer, x, y, size) => {
  if (imageBuffer) {
    doc.image(imageBuffer, x, y, { width: size, height: size });
  } else {
    doc.rect(x, y, size, size).fill('#fbf3e7');
  }
};

const drawSticker = async (doc, x, y, layout, sticker) => {
  const { w, h } = layout;
  const { splitType, code, imageBuffer, qrBuffer } = sticker;
  const tall = splitType === 'horizontal-50-50';

  doc.roundedRect(x, y, w, h, 6).lineWidth(1).stroke('#e7ddcc');
  drawStickerHeader(doc, x, y, w, sticker, tall);

  if (tall) {
    // Photo stacked above the QR, both the same square, centred on the card.
    const bodyTop = 48;
    const footerTop = h - 12;
    const gap = 5;
    const tile = Math.floor((footerTop - 3 - bodyTop - gap) / 2);
    const tileX = x + (w - tile) / 2;
    drawPhotoTile(doc, imageBuffer, tileX, y + bodyTop, tile);
    doc.image(qrBuffer, tileX, y + bodyTop + tile + gap, { width: tile, height: tile });
    drawStickerFooter(doc, x, y + footerTop, w, code, 7);
    return;
  }

  // Photo on the left, QR on the right: two equal squares, each centred in its half of the card.
  const bodyTop = 58;
  const footerTop = h - 13;
  const tile = footerTop - 5 - bodyTop;
  const bodyPad = 10;
  const halfW = (w - bodyPad * 2 - 6) / 2;
  drawPhotoTile(doc, imageBuffer, x + bodyPad + (halfW - tile) / 2, y + bodyTop, tile);
  doc.image(qrBuffer, x + bodyPad + halfW + 6 + (halfW - tile) / 2, y + bodyTop, { width: tile, height: tile });
  drawStickerFooter(doc, x, y + footerTop, w, code, 10);
};

// GET /api/qr-stickers/batches/:id/pdf — laid out on the batch's paper size (A4 unless chosen otherwise).
const downloadBatchPdf = async (req, res) => {
  try {
    const batch = await QrBatch.findByPk(req.params.id, {
      include: [
        { model: QrCode, as: 'codes' },
        { model: ImageFolder, as: 'folder' },
      ],
    });

    if (!batch) {
      return res.status(404).json({ message: 'Batch not found.' });
    }

    batch.codes.sort((a, b) => a.sequenceNo - b.sequenceNo);

    const packedDate = new Date(batch.createdAt);
    const packedLabel = `${String(packedDate.getDate()).padStart(2, '0')}/${String(packedDate.getMonth() + 1).padStart(2, '0')}/${String(packedDate.getFullYear()).slice(-2)}`;

    const pageSize = batch.pageSize || 'A4';
    const layout = gridFor(pageSize, batch.splitType, batch.labelsPerPage || legacyPerPage(pageSize, batch.splitType));
    const pages = Math.max(1, Math.ceil(batch.codes.length / layout.perPage));

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${batch.batchNo.replace(/[^a-zA-Z0-9-]+/g, '_')}-stickers-${pageSize}.pdf"`
    );

    const doc = new PDFDocument({ size: [layout.width, layout.height], margin: 0, autoFirstPage: false });
    doc.pipe(res);

    const imageCache = new Map();
    const startPage = (page) => {
      doc.addPage({ size: [layout.width, layout.height], margin: 0 });
      const onPage = Math.min(layout.perPage, batch.codes.length - (page - 1) * layout.perPage);
      if (onPage > 0) drawCutLines(doc, layout, onPage);
      doc
        .fillColor('#163832')
        .fontSize(9)
        .font('Helvetica-Bold')
        .text('QR stickers', PAGE_MARGIN, PAGE_MARGIN - 8, { lineBreak: false, continued: true })
        .fillColor('#6b7280')
        .font('Helvetica')
        .text(
          `  ·  ${batch.producer} · ${batch.productName} · Batch ${batch.batchNo} · ${pageSize} · Page ${page} of ${pages}  ·  Cut along the dashed lines`,
          { lineBreak: false }
        );
    };

    for (const [i, codeRow] of batch.codes.entries()) {
      const slot = i % layout.perPage;
      if (slot === 0) startPage(i / layout.perPage + 1);

      const x = layout.left + (slot % layout.cols) * (layout.sw + GAP);
      const y = layout.top + Math.floor(slot / layout.cols) * (layout.sh + GAP);

      const imageBuffer = await fetchImageBuffer(codeRow.imageUrl, imageCache).catch(() => null);
      const qrBuffer = await QRCode.toBuffer(stickerQrPayload(codeRow.code), { margin: 0, width: 300 });

      // Each sticker is drawn at full size and scaled into its slot, so a smaller one is the same
      // design shrunk evenly (text, photo and QR together).
      doc.save();
      doc.translate(x, y).scale(layout.scale);
      await drawSticker(doc, 0, 0, layout, {
        producer: batch.producer,
        productName: batch.productName,
        variantSize: batch.variantSize,
        batchNo: batch.batchNo,
        packedDate: packedLabel,
        splitType: batch.splitType,
        code: codeRow.code,
        imageBuffer,
        qrBuffer,
      });
      doc.restore();
    }
    if (!batch.codes.length) startPage(1);

    doc.end();
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      res.status(500).json({ message: 'Could not generate the PDF.' });
    } else {
      res.end();
    }
  }
};

module.exports = {
  createBatch,
  checkBatchNo,
  listCodes,
  listFilters,
  verifyCode,
  downloadBatchPdf,
};
