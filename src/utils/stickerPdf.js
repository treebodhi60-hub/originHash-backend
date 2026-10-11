const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const { GAP, PAGE_MARGIN } = require('./stickerLayout');

// Dashed cut lines for a page holding `count` labels: one down the middle of every gap between
// columns and rows, plus one around the outside of the grid. A single straight cut then separates
// two neighbouring labels, and every label keeps the same thin white border (half the gap). The
// lines run past the grid (crop-mark style) so a ruler or paper trimmer can line up with them.
const CUT_OVERSHOOT = 12;
const drawCutLines = (doc, layout, count) => {
  const cols = Math.min(count, layout.cols);
  const rows = Math.ceil(count / layout.cols);
  const half = GAP / 2;
  const xs = Array.from({ length: cols + 1 }, (_, k) => layout.left - half + k * (layout.sw + GAP));
  const ys = Array.from({ length: rows + 1 }, (_, k) => layout.top - half + k * (layout.sh + GAP));
  const [x0, x1] = [xs[0] - CUT_OVERSHOOT, xs[cols] + CUT_OVERSHOOT];
  const [y0, y1] = [ys[0] - CUT_OVERSHOOT, ys[rows] + CUT_OVERSHOOT];

  doc.save();
  doc.lineWidth(0.6).strokeColor('#8a8f98').dash(4, { space: 3 });
  for (const x of xs) doc.moveTo(x, y0).lineTo(x, y1).stroke();
  for (const y of ys) doc.moveTo(x0, y).lineTo(x1, y).stroke();
  doc.undash();
  doc.restore();
};

// Single line of text that never wraps: shrinks down to `minSize`, then cuts with an ellipsis.
const fitLine = (doc, text, x, y, width, { size, minSize = size, font = 'Helvetica', color, align = 'left' }) => {
  let s = size;
  doc.font(font);
  while (s > minSize && doc.fontSize(s).widthOfString(text) > width) s -= 0.25;
  doc.fillColor(color).fontSize(s).text(text, x, y, { width, align, lineBreak: false, ellipsis: true, height: s + 2 });
};

// ---------- QR labels (bulk and light QR stickers) ----------

// The OriginHash mark (same path as the app's logo), drawn in a 24-unit box.
const LOGO_PATH =
  'M12 2c-2.2 0-4 1.8-4 4v1H7a1 1 0 0 0 0 2h1v2H7a1 1 0 0 0 0 2h1v1c0 2.2 1.8 4 4 4s4-1.8 4-4v-1h1a1 1 0 1 0 0-2h-1V9h1a1 1 0 1 0 0-2h-1V6c0-2.2-1.8-4-4-4Zm-2 4c0-1.1.9-2 2-2s2 .9 2 2v1h-4V6Zm4 5v2h-4v-2h4Zm0 4v1c0 1.1-.9 2-2 2s-2-.9-2-2v-1h4Z';
const FOREST = '#163832';
const GOLD = '#c9a464';
const ORANGE = '#e4924a';

// A label's QR: error correction H, so the logo over its centre still reads.
const labelQrBuffer = (text, width = 600) =>
  QRCode.toBuffer(text, { errorCorrectionLevel: 'H', margin: 0, width, color: { dark: FOREST, light: '#ffffff' } });

// One QR label at full size (150 × 180 pt), top-left at (0, 0): a heading line (brand and batch),
// the QR with the logo in a white card, the OriginHash wordmark, and the orange number bar.
const drawQrLabel = (doc, { heading, number }, qrImage) => {
  const w = 150;
  const pad = 8;
  fitLine(doc, heading, pad, 11, w - pad * 2, { size: 8, minSize: 5.5, font: 'Helvetica-Bold', color: FOREST });

  // Card with the QR.
  doc.roundedRect(pad, 28, w - pad * 2, 124, 6).lineWidth(0.8).fillAndStroke('#ffffff', '#e7ddcc');
  const qr = 98;
  const qx = (w - qr) / 2;
  const qy = 34;
  doc.image(qrImage, qx, qy, { width: qr, height: qr });

  // Logo in the middle of the QR.
  const cx = qx + qr / 2;
  const cy = qy + qr / 2;
  doc.circle(cx, cy, 13.5).fill('#ffffff');
  doc.circle(cx, cy, 11.5).fill(FOREST);
  doc.save();
  doc.translate(cx - 7.5, cy - 7.5).scale(15 / 24);
  doc.path(LOGO_PATH).fill(GOLD, 'even-odd');
  doc.restore();

  fitLine(doc, 'OriginHash', pad, 137, w - pad * 2, { size: 10, minSize: 8, font: 'Helvetica-Bold', color: FOREST, align: 'center' });

  // Number bar.
  doc.rect(pad, 156, w - pad * 2, 18).fill(ORANGE);
  fitLine(doc, number, pad + 7, 161.5, w - pad * 2 - 14, { size: 7.5, minSize: 5.5, font: 'Helvetica-Bold', color: '#ffffff' });
};

// Streams a sheet of `count` QR labels laid out by `layout` (gridFor) to the response, with the page
// header and cut lines. `labelAt(i, doc)` returns { heading, number, qrImage } for label i.
const streamQrLabelPdf = async (res, { layout, count, title, subtitle, fileName, labelAt }) => {
  const pages = Math.max(1, Math.ceil(count / layout.perPage));
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);

  const doc = new PDFDocument({ size: [layout.width, layout.height], margin: 0, autoFirstPage: false });
  doc.pipe(res);
  for (let i = 0; i < count; i += 1) {
    const slot = i % layout.perPage;
    if (slot === 0) {
      const page = i / layout.perPage + 1;
      doc.addPage({ size: [layout.width, layout.height], margin: 0 });
      drawCutLines(doc, layout, Math.min(layout.perPage, count - i));
      doc
        .fillColor(FOREST)
        .fontSize(9)
        .font('Helvetica-Bold')
        .text(title, PAGE_MARGIN, PAGE_MARGIN - 8, { lineBreak: false, continued: true })
        .fillColor('#6b7280')
        .font('Helvetica')
        .text(`  ·  ${subtitle} · Page ${page} of ${pages}  ·  Cut along the dashed lines`, { lineBreak: false });
    }
    const { heading, number, qrImage } = await labelAt(i, doc);
    const x = layout.left + (slot % layout.cols) * (layout.sw + GAP);
    const y = layout.top + Math.floor(slot / layout.cols) * (layout.sh + GAP);
    doc.save();
    doc.translate(x, y).scale(layout.scale);
    drawQrLabel(doc, { heading, number }, qrImage);
    doc.restore();
  }
  if (!count) doc.addPage({ size: [layout.width, layout.height], margin: 0 });
  doc.end();
};

module.exports = { drawCutLines, fitLine, labelQrBuffer, drawQrLabel, streamQrLabelPdf };
