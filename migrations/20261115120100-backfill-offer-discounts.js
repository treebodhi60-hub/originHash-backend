// Offers made before discount_percent existed: take the percentage from a title that starts with
// one ("10% off next bottle" → 10). Others stay empty until the producer edits them.

module.exports = {
  up: async ({ queryInterface }) => {
    await queryInterface.sequelize.query(
      `UPDATE producer_offers
          SET discount_percent = CAST(REGEXP_SUBSTR(title, '^[0-9]+(\\\\.[0-9]+)?') AS DECIMAL(5,2))
        WHERE discount_percent IS NULL
          AND title REGEXP '^[0-9]+(\\\\.[0-9]+)?[[:space:]]*%'
          AND CAST(REGEXP_SUBSTR(title, '^[0-9]+(\\\\.[0-9]+)?') AS DECIMAL(5,2)) BETWEEN 0.01 AND 100`
    );
  },

  // Nothing to undo: the column itself is removed by 20261115120000's down.
  down: async () => {},
};
