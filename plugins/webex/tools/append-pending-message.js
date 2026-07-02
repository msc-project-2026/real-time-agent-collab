const { appendPendingMessage } = require('../storage/pending.js');

function appendPendingMessageTool() {
  return {
    name: 'collab_append_pending_message',
    description:
      'Append the current inbound Webex message to this space’s pending collab message buffer.',
    parameters: {
      type: 'object',
      properties: {
        spaceId: { type: 'string' },
        message: {
          type: 'object',
          properties: {
            messageId: { type: 'string' },
            senderId: { type: 'string' },
            senderName: { type: 'string' },
            text: { type: 'string' },
            createdAt: { type: 'string' },
          },
          required: ['messageId', 'senderId', 'text'],
          additionalProperties: true,
        },
      },
      required: ['spaceId', 'message'],
      additionalProperties: false,
    },
    async execute({ spaceId, message }) {
      return appendPendingMessage({
        spaceId,
        message,
      });
    },
  };
}

module.exports = {
  appendPendingMessageTool,
};
