// "Chat with brand" messages can carry a photo (stored like the module's other files, connect/chat).
// A message then needs text or a photo, so an empty body is allowed.

module.exports = {
  up: async ({ queryInterface, Sequelize: { DataTypes } }) => {
    const columns = await queryInterface.describeTable('brand_chat_messages');
    if (!columns.image_url) {
      await queryInterface.addColumn('brand_chat_messages', 'image_url', { type: DataTypes.STRING(500), allowNull: true });
    }
    if (!columns.image_name) {
      await queryInterface.addColumn('brand_chat_messages', 'image_name', { type: DataTypes.STRING(200), allowNull: true });
    }
  },

  down: async ({ queryInterface }) => {
    const columns = await queryInterface.describeTable('brand_chat_messages');
    if (columns.image_name) await queryInterface.removeColumn('brand_chat_messages', 'image_name');
    if (columns.image_url) await queryInterface.removeColumn('brand_chat_messages', 'image_url');
  },
};
