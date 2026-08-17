// ********* RECALL/HANDLE-REQUEST.JS *********
'use strict';

const { dispatchToAgentForSpace } = require('../dispatch');
const { getPluginRuntime } = require('../runtime');
const { buildRecallContext } = require('./context');
const { buildRecallInstruction } = require('./instruction');
const { makeRecallResultHandler } = require('./result-handler');

async function handleRecallRequest({ message, account, log, sendFn }) {
  if (!message?.roomId) throw new Error('message.roomId is required');
  if (!account) throw new Error('account is required');

  const spaceId = message.roomId;

  const responseContext = await buildRecallContext({
    message,
    account,
    log,
  });

  const responseInstruction = buildRecallInstruction({
    responseContext,
  });

  const baseSessionKey = `agent:main:webex:${spaceId}:response`;

  function buildRecallResponseCtxPayload(sessionKeySuffix) {
    return {
      Body: message.text ?? '',
      RawBody: message.text ?? '',
      CommandBody: responseInstruction,
      From: `webex:${message.personId}`,
      To: `webex:${spaceId}`,
      SessionKey: sessionKeySuffix
        ? `${baseSessionKey}:${sessionKeySuffix}`
        : baseSessionKey,
      WebexRoomId: spaceId,
      AccountId: account.accountId,
      ChatType: message.roomType === 'direct' ? 'direct' : 'group',
      SenderName: message.personEmail ?? message.personId,
      SenderId: message.personId,
      Provider: 'webex',
      Surface: 'webex',
      MessageSid: `recall_response:${spaceId}:${message.id}:${Date.now()}`,
      Timestamp: new Date().toISOString(),
      OriginatingChannel: 'webex',
      OriginatingTo: `webex:${spaceId}`,
      MessageThreadId: message.parentId ?? message.id,
    };
  }

  await dispatchToAgentForSpace({
    pluginRuntime: getPluginRuntime(),
    spaceId,
    account,
    log,
    buildCtxPayload: buildRecallResponseCtxPayload,
    onAgentOutput: makeRecallResultHandler({
      message,
      account,
      log,
      sendFn,
    }),
  });

  return {
    ok: true,
    dispatched: true,
  };
}

module.exports = {
  handleRecallRequest,
};
