'use strict';

// Adaptive Card builders for preset selection.
//
// Webex renders these as interactive cards with radio-button choice sets,
// so any team member — regardless of technical background — can pick a mode
// by clicking rather than typing a command.
//
// Submissions arrive as resource: "attachmentActions" webhooks; handled in inbound.js.

const { PRESETS } = require('./prefs');

function presetChoices() {
  return Object.entries(PRESETS).map(([name, p]) => ({
    title: `${p.emoji}  ${p.label} — ${p.desc}`,
    value: name,
  }));
}

function cardBody(headingText, subtitleText, currentPreset) {
  return [
    {
      type: 'TextBlock',
      text: headingText,
      weight: 'Bolder',
      size: 'Medium',
      wrap: true,
    },
    {
      type: 'TextBlock',
      text: subtitleText,
      wrap: true,
      spacing: 'Small',
      isSubtle: true,
    },
    {
      type: 'Input.ChoiceSet',
      id: 'preset',
      style: 'expanded',   // renders as radio buttons in Webex
      value: currentPreset,
      choices: presetChoices(),
    },
    {
      type: 'TextBlock',
      text: 'This also controls which GitHub commit notifications are posted here — Silent suppresses all, Quiet allows only hotfixes and reverts.',
      wrap: true,
      spacing: 'Small',
      isSubtle: true,
      size: 'Small',
    },
    {
      type: 'ActionSet',
      spacing: 'Medium',
      actions: [
        {
          type: 'Action.Submit',
          title: 'Apply to this space',
          style: 'positive',
          data: { cardAction: 'setPreset', scope: 'room' },
        },
        {
          type: 'Action.Submit',
          title: 'Apply to my messages only',
          data: { cardAction: 'setPreset', scope: 'me' },
        },
      ],
    },
    {
      type: 'TextBlock',
      text: 'For fine-grained control or file-specific notification filters, type `/collab` in chat.',
      wrap: true,
      spacing: 'Small',
      isSubtle: true,
      size: 'Small',
    },
  ];
}

function buildWelcomeCard(roomId) {
  return {
    roomId,
    text: 'Choose how proactive your AI teammate should be.',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: {
          type: 'AdaptiveCard',
          version: '1.3',
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          body: [
            {
              type: 'TextBlock',
              text: "👋 Hi! I'm your AI collaboration teammate.",
              weight: 'Bolder',
              size: 'Medium',
              wrap: true,
            },
            {
              type: 'TextBlock',
              text: 'I watch this conversation and your GitHub repos, and speak up when I have something useful to add — corrections, blockers, clarifications, and notable code changes.',
              wrap: true,
              spacing: 'Small',
              isSubtle: true,
            },
            ...cardBody(
              'How proactive should I be?',
              'Choose a mode for this space. You can change it any time.',
              'balanced'
            ),
          ],
        },
      },
    ],
  };
}

// Resent via /collab settings — shows current preset pre-selected.
function buildPresetCard(roomId, { currentPreset = 'balanced' } = {}) {
  return {
    roomId,
    text: 'Choose how proactive your AI teammate should be.',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: {
          type: 'AdaptiveCard',
          version: '1.3',
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          body: cardBody(
            'Proactivity settings',
            'Choose a mode. Your selection applies to both conversation replies and GitHub commit notifications.',
            currentPreset
          ),
        },
      },
    ],
  };
}

module.exports = { buildWelcomeCard, buildPresetCard };
