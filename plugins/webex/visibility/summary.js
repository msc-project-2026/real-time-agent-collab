// ********* VISIBILITY/SUMMARY.JS *********
'use strict';

const { getConversations } = require('../context/conversations-store');
const { getItems } = require('../context/items-store');
const { getThreads } = require('../context/threads-store');
const { asArray } = require('../utils/normalise');

function countItems(items, predicate) {
  return asArray(items).filter(predicate).length;
}

function formatConversationForVisibility(conversation) {
  return {
    id: conversation.id,
    topic: conversation.topic,
    summary: conversation.summary,
    status: conversation.status,
    threadRootIds: conversation.threadRootIds ?? [],
    lastMessageIds: conversation.lastMessageIds ?? [],
    startedAt: conversation.startedAt ?? null,
    updatedAt: conversation.updatedAt ?? null,
  };
}

function formatItemForVisibility(item) {
  return {
    id: item.id,
    type: item.type,
    status: item.status,
    title: item.title,
    description: item.description,
    owner: item.owner ?? null,
    conversationIds: item.conversationIds ?? [],
    evidenceMessageIds: item.evidenceMessageIds ?? [],
    createdAt: item.createdAt ?? null,
    updatedAt: item.updatedAt ?? null,
  };
}

function formatThreadForVisibility(thread) {
  return {
    key: thread.key,
    kind: thread.kind,
    rootMessageId: thread.rootMessageId ?? null,
    contextWindowSize: Array.isArray(thread.contextWindow)
      ? thread.contextWindow.length
      : 0,
    updatedAt: thread.updatedAt ?? null,
  };
}

async function buildContextSummary({ spaceId }) {
  if (!spaceId) throw new Error('spaceId is required');

  const conversations = await getConversations({
    spaceId,
    statuses: ['active', 'dormant'],
    limit: 100,
  });

  const items = await getItems({
    spaceId,
    limit: 200,
  });

  const threads = await getThreads({
    spaceId,
    limit: 100,
  });

  return {
    spaceId,
    generatedAt: new Date().toISOString(),
    counts: {
      activeConversations: conversations.filter(
        (conversation) => conversation.status === 'active'
      ).length,
      dormantConversations: conversations.filter(
        (conversation) => conversation.status === 'dormant'
      ).length,
      openItems: countItems(items, (item) => item.status === 'open'),
      inProgressItems: countItems(
        items,
        (item) => item.status === 'in_progress'
      ),
      blockedItems: countItems(items, (item) => item.status === 'blocked'),
      resolvedItems: countItems(items, (item) => item.status === 'resolved'),
      risks: countItems(items, (item) => item.type === 'risk'),
      decisions: countItems(items, (item) => item.type === 'decision'),
      questions: countItems(items, (item) => item.type === 'question'),
      tasks: countItems(items, (item) => item.type === 'task'),
      issues: countItems(items, (item) => item.type === 'issue'),
    },
    conversations: conversations.map(formatConversationForVisibility),
    items: items.map(formatItemForVisibility),
    threads: threads.map(formatThreadForVisibility),
  };
}

module.exports = {
  buildContextSummary,
};
