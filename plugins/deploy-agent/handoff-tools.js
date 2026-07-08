// Handoff tools that connect the model tiers:
//
//   request_deployment  (main agent, expensive) -> deployer agent (cheap)
//   escalate_debug      (deployer agent, cheap) -> debugger agent (expensive)
//
// Each dispatches a prompt into the corresponding channel; the OpenClaw binding
// selects the agent and its model. Secrets are never placed in these prompts —
// env content is stashed out-of-band and pulled at the CLI boundary.
'use strict';

const channel = require('./channel.js');
const pendingEnv = require('./pending-env.js');

function register(api) {
  api.registerTool({
    name: 'request_deployment',
    description:
      'Hand a deployment off to the deployment agent. Use this when a user asks to deploy or ' +
      'update an application. The deployment agent runs the build/run steps on a cheaper model ' +
      'and reports back the result (including the public URL on success). Provide env file ' +
      'content here if the user supplied secrets — it is passed securely and never echoed.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Desired app slug (lowercase, digits, single hyphens).' },
        repo: { type: 'string', description: 'Git repository URL or owner/repo.' },
        ref: { type: 'string', description: 'Optional branch or tag.' },
        update: {
          type: 'boolean',
          description: 'True to update an existing app (redeploy); false/omitted to create a new one.',
        },
        env: { type: 'string', description: 'Optional .env content (KEY=VALUE lines) supplied by the user.' },
        private: { type: 'boolean', description: 'True for a private GitHub repo.' },
        requested_by: { type: 'string', description: 'Requesting user (name or email) for the audit log.' },
      },
      required: ['name', 'repo'],
    },
    handler: async (args, apiCtx) => {
      pendingEnv.sweep();
      if (typeof args.env === 'string' && args.env.trim() !== '') {
        pendingEnv.set(args.name, args.env);
      }
      const reply = await channel.dispatch(
        channel.DEPLOY_CHANNEL,
        'deployer',
        buildDeployerPrompt(args),
        apiCtx?.log
      );
      return { ok: true, agent_reply: reply };
    },
  });

  api.registerTool({
    name: 'escalate_debug',
    description:
      'Escalate a FAILED deployment to the debugging agent (a more capable model). Call this ' +
      'when deploy_app or redeploy_app returns ok:false and you cannot resolve it with a simple ' +
      'retry. The debugger inspects logs, proposes and applies a fix, and retries.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'App slug that failed to deploy.' },
        error: { type: 'string', description: 'The error message from the failed deploy.' },
        notes: { type: 'string', description: 'Optional context: what was attempted, suspected cause.' },
      },
      required: ['name'],
    },
    handler: async (args, apiCtx) => {
      const reply = await channel.dispatch(
        channel.DEBUG_CHANNEL,
        'deploy-debugger',
        buildDebuggerPrompt(args),
        apiCtx?.log
      );
      return { ok: true, agent_reply: reply };
    },
  });
}

function buildDeployerPrompt(args) {
  const action = args.update ? 'Update (redeploy)' : 'Deploy';
  const lines = [
    `${action} an application on the hosting VPS.`,
    '',
    `App name: ${args.name}`,
    `Repository: ${args.repo}`,
  ];
  if (args.ref) lines.push(`Ref: ${args.ref}`);
  if (args.private) lines.push('Repository is private (a token is fetched automatically).');
  if (typeof args.env === 'string' && args.env.trim() !== '') {
    lines.push('An env file was supplied securely and will be applied automatically — do NOT ask for it.');
  }
  if (args.requested_by) lines.push(`Requested by: ${args.requested_by}`);
  lines.push(
    '',
    `Call ${args.update ? 'redeploy_app' : 'deploy_app'} with these values` +
      (args.requested_by ? ` and requested_by="${args.requested_by}"` : '') +
      '. Do not pass the env argument; it is applied automatically.',
    'If it succeeds, report the public URL. If it returns ok:false, read the logs in the result; ',
    'try one obvious fix (e.g. a missing env var the user can provide) or, if you cannot resolve it, ',
    'call escalate_debug with the app name and the error.',
  );
  return lines.join('\n');
}

function buildDebuggerPrompt(args) {
  const lines = [
    `A deployment failed and has been escalated to you for diagnosis and repair.`,
    '',
    `App name: ${args.name}`,
  ];
  if (args.error) lines.push(`Error: ${args.error}`);
  if (args.notes) lines.push(`Notes: ${args.notes}`);
  lines.push(
    '',
    'Diagnose it: call app_logs and app_status to see what happened. Common causes are a missing ',
    'build step, a missing env var, the app binding to the wrong port (it must listen on $PORT), or ',
    'a repo with no Dockerfile that nixpacks could not auto-detect.',
    'If you can fix it, apply the fix and call redeploy_app, then confirm it is healthy. ',
    'Report a concise summary of the root cause, what you changed, and the final status (with URL if fixed).',
  );
  return lines.join('\n');
}

module.exports = { register };
