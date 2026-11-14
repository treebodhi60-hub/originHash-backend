const { Op } = require('sequelize');
const { sequelize, User, Producer, ChainBatch, ChainUnit, ProducerProduct, ChatThread, ChatMessage } = require('../models');
const { cleanToken, maskMobile, serialOf, text, fail, httpError } = require('../util');

// "Chat with brand": a consumer writes to a producer about a product they scanned; the producer's
// admin and the staff allowed to chat answer (staff see conversations assigned to them or to nobody).
// The producer can switch chat off; consumers then can't start or continue conversations.

const BODY_MAX = 2000;

const messageJson = (m) => ({
  id: m.id,
  at: m.createdAt,
  from: m.senderType,
  body: m.body,
  sender: m.senderType === 'producer' ? (m.sender ? m.sender.name || m.sender.username : 'Brand') : null,
});

const threadJson = (t, side) => ({
  id: t.id,
  producer: t.producer ? { id: t.producer.id, name: t.producer.name, chatEnabled: t.producer.chatEnabled } : undefined,
  consumer: t.consumer ? { id: t.consumer.id, name: t.consumer.name || 'Customer', mobile: maskMobile(t.consumer.mobile), city: t.consumer.city } : undefined,
  unit: t.unit ? { id: t.unit.id, serial: serialOf(t.unit.id), productName: t.unit.batch?.product?.name || null } : null,
  assignee: t.assignee ? { id: t.assignee.id, name: t.assignee.name || t.assignee.username } : null,
  lastMessageAt: t.lastMessageAt,
  lastMessagePreview: t.lastMessagePreview,
  unread: side === 'producer' ? t.unreadForProducer : t.unreadForConsumer,
});

const unitInclude = {
  model: ChainUnit,
  as: 'unit',
  attributes: ['id', 'batchId'],
  include: [{ model: ChainBatch, as: 'batch', attributes: ['id', 'productId'], include: [{ model: ProducerProduct, as: 'product', attributes: ['id', 'name'] }] }],
};

const messagesOf = async (threadId, after) =>
  ChatMessage.findAll({
    where: { threadId, ...(after ? { id: { [Op.gt]: after } } : {}) },
    include: [{ model: User, as: 'sender', attributes: ['id', 'name', 'username'] }],
    order: [['id', 'ASC']],
    limit: 500,
  });

const readBody = (req) => {
  const body = text(req.body?.body, BODY_MAX + 1);
  if (!body) throw httpError(400, 'Write a message.');
  if (body.length > BODY_MAX) throw httpError(400, `Keep messages to ${BODY_MAX} characters.`);
  return body;
};

// ---------- Producer side ----------

const canChat = (req) => req.user.producerRole === 'admin' || req.user.canChat;
const CONSUMER_ATTRS = ['id', 'name', 'mobile', 'city'];
const ASSIGNEE_ATTRS = ['id', 'name', 'username'];

// Staff see the conversations assigned to them and the unassigned ones; the admin sees all.
const visibleTo = (req) =>
  req.user.producerRole === 'admin' ? {} : { [Op.or]: [{ assignedUserId: null }, { assignedUserId: req.user.id }] };

const producerThread = async (req) => {
  if (!canChat(req)) throw httpError(403, 'Your admin has not given you access to chat.');
  const thread = await ChatThread.findOne({
    where: { id: req.params.id, producerId: req.producer.id, ...visibleTo(req) },
    include: [
      { model: User, as: 'consumer', attributes: CONSUMER_ATTRS },
      { model: User, as: 'assignee', attributes: ASSIGNEE_ATTRS },
      unitInclude,
    ],
  });
  if (!thread) throw httpError(404, 'Conversation not found.');
  return thread;
};

// GET /api/connect/producer/chats
const producerThreads = async (req, res) => {
  try {
    if (!canChat(req)) throw httpError(403, 'Your admin has not given you access to chat.');
    const threads = await ChatThread.findAll({
      where: { producerId: req.producer.id, ...visibleTo(req) },
      include: [
        { model: User, as: 'consumer', attributes: CONSUMER_ATTRS },
        { model: User, as: 'assignee', attributes: ASSIGNEE_ATTRS },
        unitInclude,
      ],
      order: [['lastMessageAt', 'DESC']],
      limit: 300,
    });
    return res.status(200).json({ threads: threads.map((t) => threadJson(t, 'producer')), chatEnabled: req.producer.chatEnabled });
  } catch (err) {
    return fail(res, err, 'Could not load conversations.');
  }
};

// GET /api/connect/producer/chats/:id?after=<messageId>
const producerMessages = async (req, res) => {
  try {
    const thread = await producerThread(req);
    const messages = await messagesOf(thread.id, Number(req.query.after) || 0);
    if (thread.unreadForProducer) await thread.update({ unreadForProducer: 0 }, { silent: true });
    return res.status(200).json({ thread: threadJson(thread, 'producer'), messages: messages.map(messageJson) });
  } catch (err) {
    return fail(res, err, 'Could not load the conversation.');
  }
};

// POST /api/connect/producer/chats/:id/messages { body }
const producerSend = async (req, res) => {
  try {
    const thread = await producerThread(req);
    const body = readBody(req);
    const message = await sequelize.transaction(async (transaction) => {
      const made = await ChatMessage.create({ threadId: thread.id, senderType: 'producer', senderUserId: req.user.id, body }, { transaction });
      await thread.update(
        { lastMessageAt: made.createdAt, lastMessagePreview: body.slice(0, 200), unreadForConsumer: thread.unreadForConsumer + 1, unreadForProducer: 0 },
        { transaction }
      );
      return made;
    });
    message.sender = req.user;
    return res.status(201).json({ message: messageJson(message) });
  } catch (err) {
    return fail(res, err, 'Could not send the message.');
  }
};

// PUT /api/connect/producer/chats/:id/assign { userId | null } — producer admin only.
const assignThread = async (req, res) => {
  try {
    const thread = await producerThread(req);
    const userId = req.body?.userId ? Number(req.body.userId) : null;
    if (userId) {
      const user = await User.findOne({ where: { id: userId, producerId: req.producer.id, isBlocked: false } });
      if (!user || !(user.producerRole === 'admin' || user.canChat)) throw httpError(400, 'Choose a team member who can chat.');
    }
    await thread.update({ assignedUserId: userId });
    await thread.reload({
      include: [{ model: User, as: 'consumer', attributes: CONSUMER_ATTRS }, { model: User, as: 'assignee', attributes: ASSIGNEE_ATTRS }, unitInclude],
    });
    return res.status(200).json({ message: userId ? 'Conversation assigned.' : 'Conversation unassigned.', thread: threadJson(thread, 'producer') });
  } catch (err) {
    return fail(res, err, 'Could not assign the conversation.');
  }
};

// ---------- Consumer side ----------

// GET /api/connect/me/chats
const consumerThreads = async (req, res) => {
  try {
    const threads = await ChatThread.findAll({
      where: { consumerId: req.user.id },
      include: [{ model: Producer, as: 'producer', attributes: ['id', 'name', 'chatEnabled'] }, unitInclude],
      order: [['lastMessageAt', 'DESC']],
    });
    return res.status(200).json({ threads: threads.map((t) => threadJson(t, 'consumer')) });
  } catch (err) {
    return fail(res, err, 'Could not load your conversations.');
  }
};

// GET /api/connect/me/chats/:producerId?after=<messageId> — the conversation with one producer
// (empty until the first message).
const consumerMessages = async (req, res) => {
  try {
    const producer = await Producer.findByPk(req.params.producerId, { attributes: ['id', 'name', 'chatEnabled', 'isBlocked'] });
    if (!producer) throw httpError(404, 'Brand not found.');
    const thread = await ChatThread.findOne({ where: { producerId: producer.id, consumerId: req.user.id }, include: [unitInclude] });
    const messages = thread ? await messagesOf(thread.id, Number(req.query.after) || 0) : [];
    if (thread?.unreadForConsumer) await thread.update({ unreadForConsumer: 0 }, { silent: true });
    return res.status(200).json({
      producer: { id: producer.id, name: producer.name, chatEnabled: producer.chatEnabled && !producer.isBlocked },
      thread: thread ? threadJson(thread, 'consumer') : null,
      messages: messages.map(messageJson),
    });
  } catch (err) {
    return fail(res, err, 'Could not load the conversation.');
  }
};

// POST /api/connect/me/chats/:producerId/messages { body, unitToken? } — a consumer starts a
// conversation from a product's consumer QR (unitToken, a sold unit of this producer) and then
// continues it.
const consumerSend = async (req, res) => {
  try {
    const account = req.user;
    const producer = await Producer.findByPk(req.params.producerId);
    if (!producer) throw httpError(404, 'Brand not found.');
    if (!producer.chatEnabled || producer.isBlocked) throw httpError(409, `${producer.name} isn't taking chat messages right now.`);
    const body = readBody(req);

    let unitId = null;
    const token = cleanToken(req.body?.unitToken);
    if (token) {
      const unit = await ChainUnit.findOne({ where: { consumerToken: token, status: 'sold' }, include: [{ model: ChainBatch, as: 'batch', attributes: ['producerId'] }] });
      if (unit && unit.batch.producerId === producer.id) unitId = unit.id;
    }

    const message = await sequelize.transaction(async (transaction) => {
      let thread = await ChatThread.findOne({ where: { producerId: producer.id, consumerId: account.id }, transaction, lock: transaction.LOCK.UPDATE });
      if (!thread) {
        if (!unitId) throw httpError(400, 'Start a chat from the QR code on one of this brand’s products.');
        thread = await ChatThread.create({ producerId: producer.id, consumerId: account.id, unitId }, { transaction });
      }
      const made = await ChatMessage.create({ threadId: thread.id, senderType: 'consumer', senderUserId: account.id, body }, { transaction });
      await thread.update(
        {
          unitId: unitId || thread.unitId,
          lastMessageAt: made.createdAt,
          lastMessagePreview: body.slice(0, 200),
          unreadForProducer: thread.unreadForProducer + 1,
          unreadForConsumer: 0,
        },
        { transaction }
      );
      return made;
    });
    return res.status(201).json({ message: messageJson(message) });
  } catch (err) {
    return fail(res, err, 'Could not send the message.');
  }
};

module.exports = { producerThreads, producerMessages, producerSend, assignThread, consumerThreads, consumerMessages, consumerSend };
