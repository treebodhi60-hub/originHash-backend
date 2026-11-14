const { id, ref, timestamps, createTable, dropTables } = require('../src/db/migrationHelpers');

// Supply-chain module: "Chat with brand". One conversation per consumer per producer, answered by
// the producer's admin and the staff allowed to chat (optionally one assigned person).

module.exports = {
  up: async ({ queryInterface, Sequelize: { DataTypes } }) => {
    await createTable(
      queryInterface,
      'brand_chat_threads',
      {
        id: id(),
        producer_id: ref('producers', { allowNull: false, onDelete: 'CASCADE' }),
        consumer_id: ref('users', { allowNull: false, onDelete: 'CASCADE' }),
        // The product the consumer last wrote about.
        unit_id: ref('chain_units'),
        assigned_user_id: ref('users'),
        last_message_at: { type: DataTypes.DATE, allowNull: true },
        last_message_preview: { type: DataTypes.STRING(200), allowNull: true },
        unread_for_producer: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
        unread_for_consumer: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
        ...timestamps(),
      },
      [{ unique: true, fields: ['producer_id', 'consumer_id'] }, { fields: ['producer_id', 'last_message_at'] }]
    );

    await createTable(
      queryInterface,
      'brand_chat_messages',
      {
        id: id(),
        thread_id: ref('brand_chat_threads', { allowNull: false, onDelete: 'CASCADE' }),
        sender_type: { type: DataTypes.ENUM('consumer', 'producer'), allowNull: false },
        sender_user_id: ref('users'),
        body: { type: DataTypes.TEXT, allowNull: false },
        ...timestamps(),
      },
      [{ fields: ['thread_id', 'id'] }]
    );
  },

  down: async ({ queryInterface }) => {
    await dropTables(queryInterface, ['brand_chat_messages', 'brand_chat_threads']);
  },
};
