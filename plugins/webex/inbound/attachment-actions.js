// ********* INBOUND/ATTACHMENT-ACTIONS.JS *********
'use strict';

const { webexFetch } = require('../api');
const { getAccessToken } = require('../token');
const { handleConfigSubmission } = require('../config/handle-submission');

async function handleInboundWebexAttachmentAction(
  payload,
  { cfg, botId, account, log }
) {
  if (payload.resource !== 'attachmentActions' || payload.event !== 'created')
    return;

  const actionId = payload.data?.id;
  if (!actionId) {
    log?.warn?.(`[webex:${account.accountId}] attachment action missing id`);
    return;
  }

  log?.info?.(
    `[webex:${account.accountId}] handling attachment action webhook ${JSON.stringify(
      {
        actionId: payload.data?.id,
      }
    )}`
  );

  // Fetch action from Id
  const action = await webexFetch(cfg.token, `/attachment/actions/${actionId}`);

  log?.info?.(
    `[webex:${account.accountId}] received attachment action ${JSON.stringify({
      actionId,
      roomId: action.roomId,
      messageId: action.messageId,
      inputs: action.inputs,
    })}`
  );

  const actionType = action.inputs?.action;

  switch (actionType) {
    case 'submit_config': {
      await handleConfigSubmission({ action, account, botId, log });
      return;
    }

    default: {
      log?.warn?.(
        `[webex:${account.accountId}] unknown attachment action ${JSON.stringify(
          {
            actionId,
            actionType,
            inputs: action.inputs,
          }
        )}`
      );
    }
  }
}

module.exports = {
  handleInboundWebexAttachmentAction,
};
