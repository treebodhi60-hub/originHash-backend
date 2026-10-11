const { Op } = require('sequelize');
const { Scan, BulkQrScan, LightQrScan, LightQrUpdate } = require('../models');
const { reverseGeocode } = require('../services/geocodeService');

const BACKFILL_LIMIT = 200;
const inFlight = new Set();

// Looks up and saves the place name for a scan's coordinates. Fire-and-forget: never throws,
// and skips scans without coordinates, already named, or already being looked up.
const nameLocation = (Model) => async (scan) => {
  const key = `${Model.name}:${scan.id}`;
  if (scan.latitude === null || scan.longitude === null || scan.locationName || inFlight.has(key)) return;
  inFlight.add(key);
  try {
    const name = await reverseGeocode(Number(scan.latitude), Number(scan.longitude));
    if (name) await Model.update({ locationName: name }, { where: { id: scan.id } });
  } catch (err) {
    console.error(`Could not name the location of ${Model.name} ${scan.id}:`, err.message);
  } finally {
    inFlight.delete(key);
  }
};
const nameScanLocation = nameLocation(Scan);
const nameBulkScanLocation = nameLocation(BulkQrScan);
const nameLightScanLocation = nameLocation(LightQrScan);
const nameLightUpdateLocation = nameLocation(LightQrUpdate);

// On start, name scans saved before place names existed (or whose lookup failed). The geocoder
// is rate-limited, so this trickles through in the background.
const backfillLocationNames = async () => {
  try {
    const scans = await Scan.findAll({
      where: { latitude: { [Op.ne]: null }, longitude: { [Op.ne]: null }, locationName: null },
      order: [['id', 'DESC']],
      limit: BACKFILL_LIMIT,
    });
    for (const scan of scans) await nameScanLocation(scan);
  } catch (err) {
    console.error('Could not backfill location names:', err.message);
  }
};

module.exports = { nameScanLocation, nameBulkScanLocation, nameLightScanLocation, nameLightUpdateLocation, backfillLocationNames };
