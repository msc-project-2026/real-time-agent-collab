// Registers the create_github_issue tool with the OpenClaw agent, allowing it
// to open a GitHub issue directly from a Webex message when it identifies a bug,
// problem, or actionable task worth tracking.
'use strict';

const { createIssue } = require('../../lib/github.js');

function register(api) {
  api.registerTool({
    name: 'create_github_issue',
    description:
      'Creates a GitHub issue in a repository. Use this when a Webex message describes a bug, problem, or actionable task that should be tracked on GitHub. Returns the issue number and URL.',
    parameters: {
      type: 'object',
      properties: {
        owner: {
          type: 'string',
          description: 'GitHub repository owner (user or organisation)',
        },
        repo: {
          type: 'string',
          description: 'GitHub repository name',
        },
        title: {
          type: 'string',
          description: 'Short, descriptive title for the issue',
        },
        body: {
          type: 'string',
          description:
            'Detailed description including relevant context from the Webex message',
        },
        labels: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional labels to apply to the issue',
        },
      },
      required: ['owner', 'repo', 'title', 'body'],
    },
    handler: async ({ owner, repo, title, body, labels }) => {
      const { number, url } = await createIssue(owner, repo, { title, body, labels });
      return { number, url };
    },
  });
}

module.exports = register;
module.exports.default = register;
module.exports.id = 'github-issues';
