// SSH transport to the target VPS deploy-cli.
//
// The remote user's key is locked to a forced command (command="deploy-cli-…"),
// so whatever we send lands in SSH_ORIGINAL_COMMAND and deploy-cli tokenizes it
// itself with no shell. We still shell-quote every token here so the string
// round-trips cleanly through deploy-cli's shell-word splitter. Arguments are
// passed to ssh as an explicit argv (no local shell), and secret env content is
// piped via stdin so it never appears in the command line or audit log.
'use strict';

const { spawn } = require('node:child_process');

function config() {
  return {
    host: process.env.DEPLOY_VPS_HOST || '',
    user: process.env.DEPLOY_VPS_USER || 'deploy',
    port: process.env.DEPLOY_VPS_PORT || '22',
    key: process.env.DEPLOY_VPS_KEY || '',
  };
}

// shellQuote wraps a token in single quotes, safely escaping embedded quotes,
// so deploy-cli's splitShellWords recovers exactly this token.
function shellQuote(token) {
  const s = String(token);
  if (s === '') return "''";
  if (/^[A-Za-z0-9_./:@=-]+$/.test(s)) return s; // safe bare word
  return "'" + s.replace(/'/g, `'\\''`) + "'";
}

// run executes deploy-cli on the target with the given token array (e.g.
// ['deploy', '--name', 'x', '--repo', 'y']). Optional stdin is piped to the
// remote process. Resolves with the parsed JSON object deploy-cli prints.
function run(tokens, { stdin = null, timeoutMs = 600000 } = {}) {
  const cfg = config();
  if (!cfg.host) {
    return Promise.reject(new Error('DEPLOY_VPS_HOST is not configured'));
  }

  const remoteCmd = tokens.map(shellQuote).join(' ');
  const args = [
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=15',
    '-p', String(cfg.port),
  ];
  if (cfg.key) args.push('-i', cfg.key);
  args.push(`${cfg.user}@${cfg.host}`, remoteCmd);

  return new Promise((resolve, reject) => {
    const child = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`deploy-cli ${tokens[0]} timed out`));
    }, timeoutMs);

    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const parsed = tryParse(stdout);
      if (parsed) {
        // deploy-cli reports its own success/failure via {ok}. A non-zero exit
        // with a parseable body is still a structured result the agent can use.
        resolve(parsed);
        return;
      }
      reject(
        new Error(
          `deploy-cli ${tokens[0]} failed (exit ${code}): ${
            stderr.trim() || stdout.trim() || 'no output'
          }`
        )
      );
    });

    if (stdin != null) child.stdin.write(stdin);
    child.stdin.end();
  });
}

function tryParse(text) {
  const trimmed = String(text).trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

module.exports = { run, shellQuote };
