const { QueryTypes } = require('sequelize');
const { sequelize } = require('./models');
const { personOf } = require('./serialize');
const { unitIdFromSerial, serialOf } = require('./util');

// The supply-chain history: every scan and sale of retailer / consumer QR codes, newest first —
// for one producer (their History tab) or for all producers (the OriginHash superadmin).
// Filterable, searchable (serial, batch, product, producer, person, place) and paginated.

// A producer user scanning another producer's QR counts as the trade (distributor-level), not as
// that producer's team.
const OWN_TEAM = "s.actor_type = 'producer' AND a.producer_id = b.producer_id";
const FILTERS = {
  all: '',
  trade: `AND s.qr_type = 'retailer' AND s.action = 'scan'
          AND (s.actor_type IN ('distributor', 'retailer') OR (s.actor_type = 'producer' AND NOT (a.producer_id <=> b.producer_id)))`,
  sold: "AND s.action = 'sold'",
  consumer: "AND s.qr_type = 'consumer'",
  team: `AND ${OWN_TEAM}`,
  mine: 'AND s.user_id = :me',
};

// `producerId` null = every producer. `query` is req.query: { filter, q, page, pageSize }.
const queryHistory = async ({ producerId = null, me, query = {} }) => {
  const filter = FILTERS[query.filter] !== undefined ? query.filter : 'all';
  const pageSize = [10, 20, 50].includes(Number(query.pageSize)) ? Number(query.pageSize) : 20;
  const q = String(query.q || '').trim().slice(0, 100);
  const serialId = unitIdFromSerial(q);
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const search = q
    ? `AND (b.batch_no LIKE :like OR p.name LIKE :like OR pr.name LIKE :like OR s.location_name LIKE :like
            OR a.name LIKE :like OR a.business_name LIKE :like OR a.username LIKE :like OR a.city LIKE :like
            ${serialId ? 'OR s.unit_id = :serialId' : ''})`
    : '';
  const from = `FROM chain_scans s
      JOIN chain_units u ON u.id = s.unit_id
      JOIN chain_batches b ON b.id = u.batch_id ${producerId ? 'AND b.producer_id = :pid' : ''}
      JOIN producers pr ON pr.id = b.producer_id
      LEFT JOIN producer_products p ON p.id = b.product_id
      LEFT JOIN users a ON a.id = s.user_id
      LEFT JOIN producers ap ON ap.id = a.producer_id
     WHERE 1 = 1 ${FILTERS[filter]} ${search}`;
  const replacements = { pid: producerId, me, like, serialId };
  const [{ total }] = await sequelize.query(`SELECT COUNT(*) AS total ${from}`, { replacements, type: QueryTypes.SELECT });
  const totalPages = Math.max(1, Math.ceil(Number(total) / pageSize));
  const page = Math.min(Math.max(1, Number(query.page) || 1), totalPages);
  const rows = await sequelize.query(
    `SELECT s.id, s.created_at AS at, s.qr_type AS qrType, s.action, s.actor_type AS actorType, s.user_id AS userId,
            s.latitude, s.longitude, s.location_name AS locationName, s.unit_id AS unitId, u.status AS unitStatus,
            b.id AS batchId, b.batch_no AS batchNo, pr.id AS producerId, pr.name AS producerName,
            p.id AS productId, p.name AS productName,
            a.name AS userName, a.business_name AS businessName, a.username, a.mobile, a.city,
            (a.producer_id <=> b.producer_id) AS ownTeam, ap.name AS actorProducerName
       ${from}
      ORDER BY s.id DESC LIMIT :limit OFFSET :offset`,
    { replacements: { ...replacements, limit: pageSize, offset: (page - 1) * pageSize }, type: QueryTypes.SELECT }
  );
  return {
    page,
    pageSize,
    total: Number(total),
    totalPages,
    history: rows.map((r) => ({
      id: r.id,
      at: r.at,
      qrType: r.qrType,
      action: r.action,
      actorType: r.actorType,
      isYou: r.userId === me,
      // For producer users: the unit's own team, or another producer scanning it.
      ownTeam: r.actorType === 'producer' ? Boolean(Number(r.ownTeam)) : undefined,
      // Who it was (no phone numbers: consumers show by name or a masked number). Another
      // producer's people show as their company.
      by:
        r.actorType === 'producer' && !Number(r.ownTeam) && r.actorProducerName
          ? { type: 'producer', name: r.actorProducerName, contact: r.userName }
          : (({ mobile, ...who }) => who)(
              personOf({ actorType: r.actorType, user: r.userId ? { name: r.userName, businessName: r.businessName, username: r.username, mobile: r.mobile, city: r.city } : null })
            ),
      location: r.latitude !== null && r.longitude !== null ? { latitude: Number(r.latitude), longitude: Number(r.longitude), name: r.locationName } : null,
      unitId: r.unitId,
      serial: serialOf(r.unitId),
      unitStatus: r.unitStatus,
      batch: { id: r.batchId, batchNo: r.batchNo },
      producer: { id: r.producerId, name: r.producerName },
      product: r.productId ? { id: r.productId, name: r.productName } : null,
    })),
  };
};

module.exports = { queryHistory };
