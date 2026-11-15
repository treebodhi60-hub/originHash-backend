const { id, ref, timestamps, createTable, dropTables } = require('../src/db/migrationHelpers');

// Login history: one row per successful sign-in (username + password or OTP). Producer teams see
// their members' first login, last login and full history from it.

module.exports = {
  up: async ({ queryInterface, Sequelize: { DataTypes } }) => {
    await createTable(
      queryInterface,
      'user_logins',
      {
        id: id(),
        user_id: ref('users', { allowNull: false, onDelete: 'CASCADE' }),
        // The user's producer at the time (null for everyone else).
        producer_id: ref('producers'),
        method: { type: DataTypes.ENUM('password', 'otp'), allowNull: false },
        ip: { type: DataTypes.STRING(64), allowNull: true },
        user_agent: { type: DataTypes.STRING(255), allowNull: true },
        ...timestamps(),
      },
      [{ fields: ['user_id', 'id'] }, { fields: ['producer_id', 'id'] }]
    );
  },

  down: async ({ queryInterface }) => {
    await dropTables(queryInterface, ['user_logins']);
  },
};
