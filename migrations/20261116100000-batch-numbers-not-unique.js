// Batch numbers are typed in by the producer (in a request) or the superadmin (when allotting), with
// the next OHB- number as a suggestion — and they don't have to be unique, not even per producer.
// Drops both unique indexes on chain_batches.batch_no; a plain (producer_id, batch_no) index stays for
// lookups and for the producer_id foreign key.

const PLAIN = 'chain_batches_producer_batch_no';
const UNIQUE_PER_PRODUCER = 'chain_batches_producer_id_batch_no';
const UNIQUE_GLOBAL = 'chain_batches_batch_no';

const names = async (queryInterface) => (await queryInterface.showIndex('chain_batches')).map((i) => i.name);

module.exports = {
  up: async ({ queryInterface }) => {
    let indexes = await names(queryInterface);
    // The plain index first, so the producer_id foreign key always has an index to use.
    if (!indexes.includes(PLAIN)) await queryInterface.addIndex('chain_batches', ['producer_id', 'batch_no'], { name: PLAIN });
    indexes = await names(queryInterface);
    if (indexes.includes(UNIQUE_PER_PRODUCER)) await queryInterface.removeIndex('chain_batches', UNIQUE_PER_PRODUCER);
    if (indexes.includes(UNIQUE_GLOBAL)) await queryInterface.removeIndex('chain_batches', UNIQUE_GLOBAL);
  },

  // Fails if duplicate batch numbers were entered meanwhile (they would have to be renamed first).
  down: async ({ queryInterface }) => {
    let indexes = await names(queryInterface);
    if (!indexes.includes(UNIQUE_PER_PRODUCER)) await queryInterface.addIndex('chain_batches', ['producer_id', 'batch_no'], { name: UNIQUE_PER_PRODUCER, unique: true });
    if (!indexes.includes(UNIQUE_GLOBAL)) await queryInterface.addIndex('chain_batches', ['batch_no'], { name: UNIQUE_GLOBAL, unique: true });
    indexes = await names(queryInterface);
    if (indexes.includes(PLAIN)) await queryInterface.removeIndex('chain_batches', PLAIN);
  },
};
