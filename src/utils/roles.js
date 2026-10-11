const { Op } = require('sequelize');

// Admins and super-admins see every user's scans and every sticker's full journey.
const isAdminUser = (user) => Boolean(user?.isAdmin || user?.isSuperAdmin);

// Everyone's scans of a sticker are visible to admins and to the user who generated its batch;
// anyone else only sees their own. `codeRow` needs its `batch` loaded.
const canSeeFullJourney = (user, codeRow) =>
  isAdminUser(user) || (Boolean(codeRow?.batch?.createdBy) && codeRow.batch.createdBy === user?.id);

// A user's public ID, e.g. USR-00012: made from the account number, so it never changes and reveals
// nothing personal. Shown next to names so two users with the same name can be told apart.
const userCode = (id) => (id ? `USR-${String(id).padStart(5, '0')}` : null);

// Search condition matching a user's ID text (USR-00012) — full or partial, any case — inside a
// User query. Must stay in step with userCode above.
const userCodeLike = (sequelize, pattern) =>
  sequelize.where(sequelize.literal("CONCAT('USR-', LPAD(`User`.`id`, 5, '0'))"), { [Op.like]: pattern });

module.exports = { isAdminUser, canSeeFullJourney, userCode, userCodeLike };
