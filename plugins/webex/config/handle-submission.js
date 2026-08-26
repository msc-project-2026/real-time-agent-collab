// ********* CONFIG/HANDLE-SUBMISSION.JS *********
'use strict';

const { writeActiveConfig, readActiveConfig, writeCachedMembers } = require('./store');
const { sendWebexMessage } = require('../send');
const { PROACTIVITY_LEVELS, DEFAULT_PROACTIVITY_THRESHOLD } = require('./proactivity');

const ALLOWED_PROACTIVITY_THRESHOLDS = new Set(PROACTIVITY_LEVELS.map((level) => level.value));

// *** Helpers

function normaliseString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function validateConfigInputs(inputs = {}) {
  const proactivityThreshold = Number(inputs.proactivityThreshold);

  const config = {
    projectName: normaliseString(inputs.projectName),
    projectDescription: normaliseString(inputs.projectDescription),
    githubRepo: normaliseString(inputs.githubRepo),
    proactivityThreshold,
  };

  const errors = [];

  if (!config.projectName) {
    errors.push('Project name is required.');
  }

  if (!config.githubRepo) {
    errors.push('GitHub repository is required.');
  }

  if (
    config.githubRepo &&
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(config.githubRepo)
  ) {
    errors.push('GitHub repository must use the format owner/repo.');
  }

  if (!ALLOWED_PROACTIVITY_THRESHOLDS.has(proactivityThreshold)) {
    errors.push(
      `Agent proactivity must be one of: ${PROACTIVITY_LEVELS.map((level) => level.title).join(', ')}.`
    );
  }

  return {
    ok: errors.length === 0,
    config,
    errors,
  };
}

// Member name overrides — a submitted `member_name_<personId>` field only
// becomes a `source: 'override'` write if it actually differs from what's
// currently cached (the same value the card was just built from). An
// untouched field is left alone entirely, so the next config-request's live
// Webex refresh (config/handle-request.js) keeps it in sync rather than
// freezing it as a permanent override the first time the card is ever
// submitted.
async function applyMemberNameOverrides({ spaceId, inputs = {} }) {
  const existing = (await readActiveConfig({ spaceId }))?.members ?? [];
  if (existing.length === 0) return;

  let changed = false;

  const updated = existing.map((member) => {
    const submitted = inputs[`member_name_${member.id}`];
    if (typeof submitted !== 'string') return member;

    const trimmed = submitted.trim();
    if (!trimmed || trimmed === member.name) return member;

    changed = true;
    return { ...member, name: trimmed, source: 'override' };
  });

  if (changed) {
    await writeCachedMembers({ spaceId, members: updated });
  }
}

// *** Handle submission

async function handleConfigSubmission({ action, account, log }) {
  if (!action?.roomId) throw new Error('action.roomId is required');
  if (!account) throw new Error('account is required');

  const validation = validateConfigInputs(action.inputs);

  if (!validation.ok) {
    await sendWebexMessage({
      token: account.config.token,
      to: action.roomId,
      markdown: [
        '🟥 **Configuration was not saved.**',
        '',
        ...validation.errors.map((err) => `- ${err}`),
        '',
        'Please update the configuration card and submit it again.',
      ].join('\n'),
      parentId: action.messageId,
    });

    log?.warn?.(
      `[webex:${account.accountId}] invalid config submission ${JSON.stringify({
        roomId: action.roomId,
        errors: validation.errors,
      })}`
    );

    return {
      ok: false,
      errors: validation.errors,
    };
  }

  const saved = await writeActiveConfig({
    spaceId: action.roomId,
    config: validation.config,
    source: {
      actionId: action.id,
      messageId: action.messageId,
      submittedBy: action.personId ?? null,
      submittedAt: new Date().toISOString(),
    },
  });

  await applyMemberNameOverrides({ spaceId: action.roomId, inputs: action.inputs });

  await sendWebexMessage({
    token: account.config.token,
    to: action.roomId,
    markdown: [
      '🟩 **Configuration saved.**',
      '',
      `**Project:** ${validation.config.projectName}`,
      `**Repository:** ${validation.config.githubRepo}`,
      `**Proactivity:** ${
        PROACTIVITY_LEVELS.find((level) => level.value === validation.config.proactivityThreshold)
          ?.title ?? validation.config.proactivityThreshold
      }`,
    ].join('\n'),
    parentId: action.messageId,
  });

  log?.info?.(
    `[webex:${account.accountId}] config saved ${JSON.stringify({
      roomId: action.roomId,
      projectName: validation.config.projectName,
      githubRepo: validation.config.githubRepo,
      proactivityThreshold: validation.config.proactivityThreshold,
    })}`
  );

  return {
    ok: true,
    config: validation.config,
    saved,
  };
}

module.exports = {
  handleConfigSubmission,
  validateConfigInputs,
  DEFAULT_PROACTIVITY_THRESHOLD,
};
