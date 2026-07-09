// Tools that drive deploy-cli on the target VPS. Each one is a thin, typed
// wrapper over an SSH call — the deployer agent (cheap model) and the debugger
// agent (expensive model) both use these; the tool schema is what keeps the
// model's choices bounded to safe, structured inputs.
'use strict';

const ssh = require('./ssh.js');
const pendingEnv = require('./pending-env.js');
const { toToolResult } = require('./result.js');

// Optional GitHub App token minting for private repos. The agent is guaranteed
// to have access, so this is best-effort: if the lib or app isn't configured,
// deploy proceeds unauthenticated (fine for public repos).
let getInstallationToken = null;
try {
  ({ getInstallationToken } = require('@collab/github'));
} catch {
  getInstallationToken = null;
}

function parseOwnerRepo(url) {
  const s = String(url || '').trim();
  const m = s
    .replace(/^https:\/\/github\.com\//, '')
    .replace(/^git@github\.com:/, '')
    .replace(/\.git$/, '')
    .split('/');
  if (m.length < 2 || !m[0] || !m[1]) return null;
  return { owner: m[0], repo: m[1] };
}

async function tokenForPrivateRepo(repoUrl) {
  if (!getInstallationToken) return '';
  const parsed = parseOwnerRepo(repoUrl);
  if (!parsed) return '';
  try {
    return await getInstallationToken(parsed.owner, parsed.repo);
  } catch {
    return '';
  }
}

function register(api) {
  api.registerTool({
    name: 'deploy_app',
    description:
      'Deploy a NEW application to the hosting VPS from a git repository. Builds it ' +
      '(Dockerfile if present, otherwise auto-detected via nixpacks for Python/Node/Go/etc.), ' +
      'runs it behind the reverse proxy, and returns its public URL. Fails if the name is taken ' +
      '(use redeploy_app to update). On failure the result carries build/run logs for debugging.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description:
            'App slug: lowercase letters, digits, single hyphens. Becomes the subdomain and container name.',
        },
        repo: { type: 'string', description: 'Git repository URL (https or owner/repo).' },
        ref: { type: 'string', description: 'Optional branch or tag. Defaults to the repo default branch.' },
        env: {
          type: 'string',
          description:
            'Optional .env file CONTENT (KEY=VALUE lines) to inject. Prefer this when the user supplies secrets; ' +
            'omit to let the repo\'s own .env (if any) be used.',
        },
        private: {
          type: 'boolean',
          description: 'Set true for a private GitHub repo; a scoped access token is fetched automatically.',
        },
        requested_by: { type: 'string', description: 'Requesting user (name or email) for the audit log.' },
      },
      required: ['name', 'repo'],
    },
    execute: async (_id, args) => toToolResult(await deployHandler(args, false)),
  });

  api.registerTool({
    name: 'redeploy_app',
    description:
      'Update an EXISTING app: pull the latest code, rebuild, and swap the running container. ' +
      'Use after a fix or to pick up new commits. Fails if the app does not exist.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'App slug to update.' },
        repo: { type: 'string', description: 'Optional repo URL override; defaults to the registered one.' },
        ref: { type: 'string', description: 'Optional branch or tag.' },
        env: { type: 'string', description: 'Optional replacement .env content.' },
        private: { type: 'boolean', description: 'Set true for a private repo.' },
        requested_by: { type: 'string', description: 'Requesting user for the audit log.' },
      },
      required: ['name'],
    },
    execute: async (_id, args) => toToolResult(await deployHandler(args, true)),
  });

  simpleTool(api, {
    name: 'list_apps',
    description: 'List all deployed apps with their status and URLs.',
    props: {},
    required: [],
    tokens: () => ['list'],
  });

  simpleTool(api, {
    name: 'app_status',
    description: 'Get an app\'s registry record plus its live container state.',
    props: { name: { type: 'string', description: 'App slug.' } },
    required: ['name'],
    tokens: (a) => ['status', '--name', a.name],
  });

  simpleTool(api, {
    name: 'app_logs',
    description: 'Fetch the recent container logs for an app. Use this to diagnose a crash or failed deploy.',
    props: {
      name: { type: 'string', description: 'App slug.' },
      tail: { type: 'number', description: 'Number of trailing log lines (default 200).' },
    },
    required: ['name'],
    tokens: (a) => (a.tail ? ['logs', '--name', a.name, '--tail', String(a.tail)] : ['logs', '--name', a.name]),
  });

  simpleTool(api, {
    name: 'stop_app',
    description: 'Stop a running app\'s container (keeps it deployed).',
    props: { name: { type: 'string', description: 'App slug.' }, requested_by: { type: 'string' } },
    required: ['name'],
    tokens: (a) => byArgs(['stop', '--name', a.name], a),
  });

  simpleTool(api, {
    name: 'start_app',
    description: 'Start a previously stopped app\'s container.',
    props: { name: { type: 'string', description: 'App slug.' }, requested_by: { type: 'string' } },
    required: ['name'],
    tokens: (a) => byArgs(['start', '--name', a.name], a),
  });

  simpleTool(api, {
    name: 'remove_app',
    description: 'Permanently remove an app: stop and delete its container, checkout, env file, and record.',
    props: { name: { type: 'string', description: 'App slug.' }, requested_by: { type: 'string' } },
    required: ['name'],
    tokens: (a) => byArgs(['remove', '--name', a.name], a),
  });

  simpleTool(api, {
    name: 'app_url',
    description: 'Get the public URL for a deployed app.',
    props: { name: { type: 'string', description: 'App slug.' } },
    required: ['name'],
    tokens: (a) => ['url', '--name', a.name],
  });

  simpleTool(api, {
    name: 'host_resources',
    description:
      'Report the hosting VPS memory/disk/CPU usage and whether it is over capacity. ' +
      'Check this if a deploy is refused for lack of space.',
    props: {},
    required: [],
    tokens: () => ['resources'],
  });
}

// deployHandler builds the token list for deploy/redeploy, fetching a private
// repo token when asked and piping env content via stdin (never argv).
async function deployHandler(args, replace) {
  const tokens = [replace ? 'redeploy' : 'deploy', '--name', String(args.name)];
  if (args.repo) tokens.push('--repo', String(args.repo));
  if (args.ref) tokens.push('--ref', String(args.ref));
  if (args.requested_by) tokens.push('--by', String(args.requested_by));

  let token = '';
  if (args.private && args.repo) {
    token = await tokenForPrivateRepo(args.repo);
    if (token) tokens.push('--token', token);
  }

  // Env content precedence: an explicit tool arg, else content stashed
  // out-of-band by request_deployment (so secrets never pass through the model).
  let stdin = null;
  const envContent =
    typeof args.env === 'string' && args.env.trim() !== ''
      ? args.env
      : pendingEnv.take(args.name);
  if (envContent) {
    tokens.push('--env-file', '-');
    stdin = envContent;
  }

  return ssh.run(tokens, { stdin });
}

function byArgs(tokens, a) {
  if (a.requested_by) return [...tokens, '--by', String(a.requested_by)];
  return tokens;
}

// simpleTool registers a tool whose only job is to run a fixed token list.
function simpleTool(api, { name, description, props, required, tokens }) {
  api.registerTool({
    name,
    description,
    parameters: { type: 'object', properties: props, required },
    execute: async (_id, args) => toToolResult(await ssh.run(tokens(args || {}))),
  });
}

module.exports = { register, parseOwnerRepo };
