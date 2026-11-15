// Batch numbers are one sequence across OriginHash (OHB-0001, OHB-0002…; see src/connect/batches),
// so they're unique across all producers, not just per producer.

const INDEX = 'chain_batches_batch_no';

module.exports = {
  up: async ({ queryInterface }) => {
    const indexes = await queryInterface.showIndex('chain_batches');
    if (!indexes.some((i) => i.name === INDEX)) {
      await queryInterface.addIndex('chain_batches', ['batch_no'], { name: INDEX, unique: true });
    }
  },

  down: async ({ queryInterface }) => {
    const indexes = await queryInterface.showIndex('chain_batches');
    if (indexes.some((i) => i.name === INDEX)) await queryInterface.removeIndex('chain_batches', INDEX);
  },
};
