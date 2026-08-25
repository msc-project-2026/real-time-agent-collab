// ********* CONFIG/CARD.JS *********
'use strict';

const { webexFetch } = require('../api');
const { sendWebexMessage } = require('../send');
const { valueOrEmpty, sendAdaptiveCard } = require('../card/shared');

function buildConfigCard({ config }) {
  return {
    type: 'AdaptiveCard',
    version: '1.3',
    body: [
      {
        type: 'TextBlock',
        text: 'Collaboration Space Configuration',
        weight: 'Bolder',
        size: 'Medium',
      },
      {
        type: 'TextBlock',
        text: 'Review or update the settings for this space.',
        wrap: true,
        spacing: 'Small',
      },
      {
        type: 'Input.Text',
        id: 'projectName',
        label: 'Project name',
        placeholder: 'e.g. OpenClaw Cisco Project',
        value: valueOrEmpty(config.projectName),
      },
      {
        type: 'Input.Text',
        id: 'projectDescription',
        label: 'Project description',
        placeholder: 'Briefly describe this collaboration space',
        isMultiline: true,
        value: valueOrEmpty(config.projectDescription),
      },
      {
        type: 'Input.ChoiceSet',
        id: 'responseMode',
        label: 'Agent response mode',
        style: 'compact',
        value: valueOrEmpty(config.responseMode || 'proactive_when_useful'),
        choices: [
          {
            title: 'Only respond when directly asked',
            value: 'direct_only',
          },
          {
            title: 'Respond proactively when useful',
            value: 'proactive_when_useful',
          },
        ],
      },
      {
        type: 'Input.Text',
        id: 'githubRepo',
        label: 'GitHub repository',
        placeholder: 'org/repo',
        value: valueOrEmpty(config.githubRepo),
      },
    ],
    actions: [
      {
        type: 'Action.Submit',
        title: 'Submit configuration',
        data: {
          action: 'submit_config',
        },
      },
    ],
  };
}

async function sendConfigCard({ spaceId, account, log, config, sendFn = sendWebexMessage }) {
  if (!spaceId) throw new Error('spaceId is required');
  if (!account) throw new Error('account is required');

  const card = buildConfigCard({ config: config ?? {} });

  return sendAdaptiveCard({
    spaceId,
    account,
    log,
    markdown: 'Please review this collaboration space configuration.',
    card,
    sendFn,
  });
}

module.exports = {
  sendConfigCard,
};
