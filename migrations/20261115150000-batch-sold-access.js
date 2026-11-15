// Who may press Sold on a QR batch, set by its producer or the superadmin:
//   all       every retailer allowed to sell the producer's products: its own retailers and the
//             general retailers (not associated with any producer). Default.
//   producer  only the producer's own retailers.
// (The producer itself and the superadmin can always sell; other producers' retailers never.)
//
// Also: people who applied to be retailers are general retailers straight away (approval only
// associates them with a producer), so pending applicants become retailers here.

module.exports = {
  up: async ({ queryInterface, Sequelize: { DataTypes } }) => {
    const columns = await queryInterface.describeTable('chain_batches');
    if (!columns.sold_access) {
      await queryInterface.addColumn('chain_batches', 'sold_access', {
        type: DataTypes.ENUM('all', 'producer'),
        allowNull: false,
        defaultValue: 'all',
      });
    }
    await queryInterface.sequelize.query(
      `UPDATE users u JOIN partner_applications pa ON pa.user_id = u.id AND pa.status = 'pending'
          SET u.partner_role = 'retailer', u.user_type = 'retailer',
              u.business_name = COALESCE(u.business_name, pa.business_name), u.city = COALESCE(u.city, pa.city)
        WHERE u.partner_role IS NULL AND u.producer_id IS NULL AND u.is_admin = 0 AND u.is_super_admin = 0`
    );
  },

  down: async ({ queryInterface }) => {
    const columns = await queryInterface.describeTable('chain_batches');
    if (columns.sold_access) await queryInterface.removeColumn('chain_batches', 'sold_access');
  },
};
