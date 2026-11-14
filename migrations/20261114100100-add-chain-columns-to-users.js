// Supply-chain module: everyone uses the existing app accounts (`users`). New, nullable columns only:
//   producer_id / producer_role / can_chat   a producer's admin or staff (log in with username + password)
//   partner_role                             a distributor or retailer registered by the OriginHash
//                                            superadmin (only these can scan for the trade / press Sold)
//   business_name / city                     shown for distributors and retailers
// Existing rows and columns are untouched.

const COLUMNS = (DataTypes) => ({
  producer_id: {
    type: DataTypes.INTEGER.UNSIGNED,
    allowNull: true,
    references: { model: 'producers', key: 'id' },
    onUpdate: 'CASCADE',
    onDelete: 'SET NULL',
  },
  producer_role: { type: DataTypes.ENUM('admin', 'staff'), allowNull: true },
  can_chat: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  partner_role: { type: DataTypes.ENUM('distributor', 'retailer'), allowNull: true },
  business_name: { type: DataTypes.STRING(160), allowNull: true },
  city: { type: DataTypes.STRING(120), allowNull: true },
});

module.exports = {
  up: async ({ queryInterface, Sequelize: { DataTypes } }) => {
    const existing = await queryInterface.describeTable('users');
    for (const [name, spec] of Object.entries(COLUMNS(DataTypes))) {
      if (!existing[name]) await queryInterface.addColumn('users', name, spec);
    }
    const indexes = (await queryInterface.showIndex('users')).map((i) => i.name);
    if (!indexes.includes('users_producer_id_producer_role')) await queryInterface.addIndex('users', ['producer_id', 'producer_role']);
    if (!indexes.includes('users_partner_role')) await queryInterface.addIndex('users', ['partner_role']);
  },

  down: async ({ queryInterface, Sequelize: { DataTypes } }) => {
    const existing = await queryInterface.describeTable('users');
    const indexes = (await queryInterface.showIndex('users')).map((i) => i.name);
    if (indexes.includes('users_partner_role')) await queryInterface.removeIndex('users', 'users_partner_role');
    if (existing.producer_id) {
      // The foreign key has to go before its column (and its index).
      const fks = await queryInterface.getForeignKeyReferencesForTable('users');
      for (const fk of fks.filter((f) => f.columnName === 'producer_id')) await queryInterface.removeConstraint('users', fk.constraintName);
    }
    if (indexes.includes('users_producer_id_producer_role')) await queryInterface.removeIndex('users', 'users_producer_id_producer_role');
    for (const name of Object.keys(COLUMNS(DataTypes)).reverse()) {
      if (existing[name]) await queryInterface.removeColumn('users', name);
    }
  },
};
