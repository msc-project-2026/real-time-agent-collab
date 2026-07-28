// ********* RECALL/RESULT-HANDLER.JS *********
'use strict';

const { sendWebexMessage } = require('../send');

function makeRecallResultHandler({ message, account, log }) {
  const spaceId = message.roomId;

  return async ({ text }) => {
    const responseText = typeof text === 'string' ? text.trim() : '';

    if (!responseText) {
      log?.warn?.(
        `[webex:${account.accountId}] recall response output was empty`,
        {
          spaceId,
          messageId: message.id,
        }
      );

      return {
        ok: false,
        skipped: true,
        reason: 'empty response output',
      };
    }

    const token = account.config?.token;
    if (!token) throw new Error('Webex token is required for recall handling');

    const parentId = message.parentId ?? message.id;

    log?.info?.(
      `[webex:${account.accountId}] sending recall response ${JSON.stringify({
        spaceId,
        messageRoomId: message.roomId,
        messageId: message.id,
        messageParentId: message.parentId ?? null,
        parentId,
      })}`
    );

    await sendWebexMessage({
      token,
      to: spaceId,
      markdown: responseText,
      parentId,
    });

    log?.info?.(
      `[webex:${account.accountId}] sent recall response ${JSON.stringify({
        spaceId,
        messageId: message.id,
      })}`
    );

    return {
      ok: true,
      sent: true,
      response: responseText,
    };
  };
}

module.exports = {
  makeRecallResultHandler,
};
