// ********* CONFIG/CARD.JS *********
'use strict';

const { webexFetch } = require('../api');
const { sendWebexMessage } = require('../send');
const { MAIN_THREAD_KEY } = require('../storage/threads-store');
const {
  valueOrEmpty,
  buildCardEnvelope,
  sendAdaptiveCard,
} = require('../card/shared');
const {
  PROACTIVITY_LEVELS,
  DEFAULT_PROACTIVITY_THRESHOLD,
} = require('./proactivity');

// One ColumnSet row per known space member — server-side generated for N
// known members at build time, not a client-side dynamic input (Adaptive
// Cards can't do that), the same way the rest of this card's body is built
// from data. Email is read-only (always Webex's own value, never
// human-editable); name is the one editable field, pre-filled from the
// cache (config/handle-request.js already refreshed it from Webex before
// this card was built).
function buildMemberRow(member) {
  return {
    type: 'ColumnSet',
    columns: [
      {
        type: 'Column',
        width: 'auto',
        items: [
          { type: 'TextBlock', text: valueOrEmpty(member.email), wrap: true },
        ],
      },
      {
        type: 'Column',
        width: 'stretch',
        items: [
          {
            type: 'Input.Text',
            id: `member_name_${member.id}`,
            placeholder: 'Display name',
            value: valueOrEmpty(member.name),
          },
        ],
      },
    ],
  };
}

function buildConfigCard({ config, members, replyThreadId }) {
  const memberRows = (Array.isArray(members) ? members : []).map(
    buildMemberRow
  );

  return buildCardEnvelope({
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
        id: 'proactivityThreshold',
        label: 'Agent proactivity',
        style: 'compact',
        value: valueOrEmpty(
          config.proactivityThreshold ?? DEFAULT_PROACTIVITY_THRESHOLD
        ),
        choices: PROACTIVITY_LEVELS.map((level) => ({
          title: level.title,
          value: String(level.value),
        })),
      },
      {
        type: 'Input.Text',
        id: 'githubRepo',
        label: 'GitHub repository',
        placeholder: 'org/repo',
        value: valueOrEmpty(config.githubRepo),
      },
      {
        type: 'TextBlock',
        text: 'Space members',
        weight: 'Bolder',
        size: 'Medium',
        spacing: 'Medium',
      },
      {
        type: 'TextBlock',
        text: 'Names come from Webex automatically (correct one if it’s missing or wrong).',
        wrap: true,
        spacing: 'Small',
        isSubtle: true,
      },
      ...memberRows,
    ],
    actions: [
      {
        type: 'Action.Submit',
        title: 'Submit configuration',
        // replyThreadId round-trips back as action.inputs.replyThreadId on
        // submission (Webex merges Action.Submit's data into the resulting
        // attachmentAction's inputs — the same mechanism already used to
        // detect `action: 'submit_config'`). This card message is itself
        // always a reply (see sendConfigCard below) — Webex rejects a reply
        // to a reply, so the submission handler needs the *original* thread
        // root, not this card's own message id, to thread its confirmation
        // correctly.
        data: {
          action: 'submit_config',
          replyThreadId,
        },
      },
    ],
  });
}

async function sendConfigCard({
  spaceId,
  threadKey,
  message,
  account,
  botId,
  log,
  config,
  members,
  sendFn = sendWebexMessage,
}) {
  if (!spaceId) throw new Error('spaceId is required');
  if (!account) throw new Error('account is required');

  const replyThreadId = threadKey === MAIN_THREAD_KEY ? message?.id : threadKey;
  const card = buildConfigCard({ config: config ?? {}, members, replyThreadId });

  return sendAdaptiveCard({
    spaceId,
    account,
    botId,
    log,
    markdown: 'Please review this collaboration space configuration.',
    card,
    recordLabel: 'Config card sent — review/update space settings',
    parentId: replyThreadId,
    fetchMessageById: async () => message,
    sendFn,
  });
}

module.exports = {
  buildConfigCard,
  sendConfigCard,
};
