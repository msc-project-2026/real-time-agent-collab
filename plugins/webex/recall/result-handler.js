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

    await sendWebexMessage({
      token: account.cfg.token,
      to: spaceId,
      markdown: responseText,
      parentId: message.parentId ?? message.id,
    });

    log?.info?.(`[webex:${account.accountId}] sent recall response`, {
      spaceId,
      messageId: message.id,
    });

    return {
      ok: true,
      sent: true,
    };
  };
}

module.exports = {
  makeRecallResultHandler,
};
