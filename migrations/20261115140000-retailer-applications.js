const { id, ref, timestamps, createTable, dropTables } = require('../src/db/migrationHelpers');

// Retailers sign up themselves: any signed-in user can apply to be a retailer; the OriginHash
// superadmin approves the application and associates the retailer with one producer. A retailer may
// press Sold only on that producer's products (users.partner_producer_id).

module.exports = {
  up: async ({ queryInterface, Sequelize: { DataTypes } }) => {
    const users = await queryInterface.describeTable('users');
    if (!users.partner_producer_id) {
      await queryInterface.addColumn('users', 'partner_producer_id', {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: true,
        references: { model: 'producers', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      });
      await queryInterface.addIndex('users', ['partner_producer_id'], { name: 'users_partner_producer_id' });
    }

    await createTable(
      queryInterface,
      'partner_applications',
      {
        id: id(),
        user_id: ref('users', { allowNull: false, onDelete: 'CASCADE' }),
        role: { type: DataTypes.ENUM('retailer'), allowNull: false, defaultValue: 'retailer' },
        // The producer the applicant sells for (the superadmin can change it when approving).
        producer_id: ref('producers'),
        business_name: { type: DataTypes.STRING(160), allowNull: false },
        city: { type: DataTypes.STRING(120), allowNull: true },
        address: { type: DataTypes.STRING(255), allowNull: true },
        note: { type: DataTypes.STRING(500), allowNull: true },
        status: { type: DataTypes.ENUM('pending', 'approved', 'rejected'), allowNull: false, defaultValue: 'pending' },
        decided_by: ref('users'),
        decided_at: { type: DataTypes.DATE, allowNull: true },
        decision_note: { type: DataTypes.STRING(500), allowNull: true },
        ...timestamps(),
      },
      [{ fields: ['status', 'id'] }, { fields: ['user_id', 'id'] }]
    );

    // Retailers made before this: associate each with the producer whose products they sold most.
    await queryInterface.sequelize.query(
      `UPDATE users u
          SET u.partner_producer_id = (
                SELECT b.producer_id FROM chain_units cu JOIN chain_batches b ON b.id = cu.batch_id
                 WHERE cu.sold_by_user_id = u.id
                 GROUP BY b.producer_id ORDER BY COUNT(*) DESC, b.producer_id LIMIT 1)
        WHERE u.partner_role = 'retailer' AND u.partner_producer_id IS NULL`
    );
  },

  down: async ({ queryInterface }) => {
    await dropTables(queryInterface, ['partner_applications']);
    const users = await queryInterface.describeTable('users');
    if (users.partner_producer_id) {
      const fks = await queryInterface.getForeignKeyReferencesForTable('users');
      for (const fk of fks.filter((f) => f.columnName === 'partner_producer_id')) {
        await queryInterface.removeConstraint('users', fk.constraintName);
      }
      await queryInterface.removeIndex('users', 'users_partner_producer_id').catch(() => {});
      await queryInterface.removeColumn('users', 'partner_producer_id');
    }
  },
};
