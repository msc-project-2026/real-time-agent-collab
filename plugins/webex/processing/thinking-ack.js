// ********* PROCESSING/THINKING-ACK.JS *********
'use strict';

// Deterministic, no model call — sent the moment the gate confirms
// shouldRespond, before extract/task-notify (and now, sequenced after them,
// respond itself) even start. Stands in for a typing indicator Webex's bot
// API doesn't have: no such REST endpoint exists, and the standard
// workaround for this exact situation is a placeholder message. Always sent
// with recordToThread: false — a "thinking..." placeholder has no value in
// a later prompt and must never resurface there.

const { sendWebexMessage, sendOutboundMessage, resolveReplyThreadId } = require('../send');

const THINKING_PHRASES = ['Thinking…', 'One moment…', 'Looking into this…', 'Give me a second…'];

function pickThinkingPhrase() {
  return THINKING_PHRASES[Math.floor(Math.random() * THINKING_PHRASES.length)];
}

async function sendThinkingAck({
  spaceId,
  threadKey,
  message,
  isBotMentioned,
  account,
  botId,
  log,
  sendFn = sendWebexMessage,
}) {
  if (!spaceId) throw new Error('spaceId is required');
  if (!threadKey) throw new Error('threadKey is required');

  const token = account?.config?.token;
  if (!token) {
    log?.warn?.('[collab-agent:thinking-ack] no Webex token available, skipping');
    return { outcome: 'success' };
  }

  const replyThreadId = await resolveReplyThreadId({ spaceId, threadKey, message, isBotMentioned });

  await sendOutboundMessage({
    sendFn,
    spaceId,
    botId,
    fetchMessageById: async () => message,
    recordToThread: false,
    log,
    token,
    to: spaceId,
    markdown: pickThinkingPhrase(),
    parentId: replyThreadId,
  });

  return { outcome: 'success' };
}

module.exports = {
  sendThinkingAck,
};
