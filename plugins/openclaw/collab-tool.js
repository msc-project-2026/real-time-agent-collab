// Registers the append_to_collab_file tool, allowing the agent to persist
// classified message content into the appropriate .collab/ file on GitHub.
'use strict';

const { appendToFile } = require('../../lib/collab-cache.js');

function register(api) {
  api.registerTool({
    name: 'append_to_collab_file',
    description:
      'Appends a classified entry to a .collab file in the project GitHub repository. ' +
      'Use after classifying an inbound message: decisions go to context.md, ' +
      'questions or blockers to open-questions.md, bugs or issues to issues.md.'+
      'After processing a meeting transcript, structured meeting notes go to meeting-notes.md.',
    parameters: {
      type: 'object',
      properties: {
        room_id: {
          type: 'string',
          description: 'The Webex room ID, used to cache project context per room',
        },
        filename: {
          type: 'string',
          enum: ['context.md', 'open-questions.md', 'issues.md','meeting-notes.md'],
          description: 'The .collab file to append to',
        },
        entry: {
          type: 'string',
          description: 'The formatted markdown entry to append',
        },
      },
      required: ['room_id', 'filename', 'entry'],
    },
    handler: async ({ room_id, filename, entry }) => {
      await appendToFile(room_id, filename, entry);
      return { ok: true };
    },
  });
}

module.exports = register;
module.exports.default = register;
module.exports.id = 'collab-writer';
