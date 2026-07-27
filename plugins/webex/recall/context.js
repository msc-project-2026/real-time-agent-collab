// ********* RECALL/CONTEXT.JS *********
'use strict';

const { getConversations } = require('../context/conversations-store');
const { getItems } = require('../context/items-store');

function formatMessageForRecallContext({ message }) {
  return {
    id: message.id,
    text: message.text ?? '',
    senderName:
      message.senderName ?? message.personEmail ?? message.personId ?? null,
    createdAt: message.created ?? null,
    parentId: message.parentId ?? null,
  };
}

function formatConversationsForRecallContext({ conversations }) {
  return Array.isArray(conversations)
    ? conversations.map((conversation) => ({
        id: conversation.id,
        topic: conversation.topic,
        summary: conversation.summary,
        status: conversation.status,
        updatedAt: conversation.updatedAt ?? null,
      }))
    : [];
}

function formatItemsForRecallContext({ items }) {
  return Array.isArray(items)
    ? items.map((item) => ({
        id: item.id,
        type: item.type,
        status: item.status,
        title: item.title,
        description: item.description,
        owner: item.owner ?? null,
        conversationIds: Array.isArray(item.conversationIds)
          ? item.conversationIds
          : [],
        evidenceMessageIds: Array.isArray(item.evidenceMessageIds)
          ? item.evidenceMessageIds
          : [],
        updatedAt: item.updatedAt ?? null,
      }))
    : [];
}

async function buildRecallContext({ message, account, log }) {
  if (!message?.roomId) throw new Error('message.roomId is required');
  if (!account) throw new Error('account is required');

  const spaceId = message.roomId;

  const conversations = await getConversations({
    spaceId,
    statuses: ['active', 'dormant'],
    limit: 50,
  });

  const items = await getItems({
    spaceId,
    statuses: ['open', 'in_progress', 'blocked', 'resolved'],
    limit: 100,
  });

  const context = {
    spaceId,
    currentMessage: formatMessageForRecallContext({ message }),
    conversations: formatConversationsForRecallContext({ conversations }),
    items: formatItemsForRecallContext({ items }),
  };

  log?.info?.(
    `[webex:${account.accountId}] built recall response context ${JSON.stringify(
      {
        spaceId,
        messageId: message.id,
        conversationCount: context.conversations.length,
        itemCount: context.items.length,
      }
    )}`
  );

  return context;
}

module.exports = {
  buildRecallContext,
};
