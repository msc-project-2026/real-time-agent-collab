// ********* CONFIG/HANDLE-SUBMISSION.JS *********
'use strict';

const { writeActiveConfig } = require('./store');
const { sendWebexMessage } = require('../send');

// *** Helpers

function normaliseString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function validateConfigInputs(inputs = {}) {
  const config = {
    projectName: normaliseString(inputs.projectName),
    projectDescription: normaliseString(inputs.projectDescription),
    githubRepo: normaliseString(inputs.githubRepo),
    responseMode: normaliseString(inputs.responseMode),
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

  const allowedResponseModes = new Set([
    'direct_only',
    'calibrated',
    'proactive',
  ]);

  if (!allowedResponseModes.has(config.responseMode)) {
    errors.push(
      `Response mode must be one of: ${Array.from(allowedResponseModes).join(', ')}.`
    );
  }

  return {
    ok: errors.length === 0,
    config,
    errors,
  };
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

  await sendWebexMessage({
    token: account.config.token,
    to: action.roomId,
    markdown: [
      '🟩 **Configuration saved.**',
      '',
      `**Project:** ${validation.config.projectName}`,
      `**Repository:** ${validation.config.githubRepo}`,
      `**Response mode:** ${validation.config.responseMode}`,
    ].join('\n'),
    parentId: action.messageId,
  });

  log?.info?.(
    `[webex:${account.accountId}] config saved ${JSON.stringify({
      roomId: action.roomId,
      projectName: validation.config.projectName,
      githubRepo: validation.config.githubRepo,
      responseMode: validation.config.responseMode,
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
};
