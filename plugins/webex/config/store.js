// ********* CONFIG/STORE.JS *********
'use strict';

const fs = require('node:fs/promises');
const { activeConfigPath, configDir } = require('../storage/paths');
const { write } = require('node:fs');
const { type } = require('node:os');

// Helpers
async function readActiveConfig({ spaceId, explicitRoot }) {
  if (!spaceId) throw new Error('spaceId is required');

  try {
    return JSON.parse(
      await fs.readFile(activeConfigPath(spaceId, explicitRoot), 'utf8')
    );
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

async function writeActiveConfig({ spaceId, config, source, explicitRoot }) {
  if (!spaceId) throw new Error('spaceId is required');
  if (!config || typeof config !== 'object') {
    throw new Error('config object is required');
  }

  const previous = await readActiveConfig({ spaceId, explicitRoot });

  const record = {
    schemaVersion: 1,
    revision: (previous?.revision ?? 0) + 1,
    config,
    source: source ?? null,
    // Deliberate user submissions bump revision/source — cached membership
    // data (below) does not, and must survive a config resubmission rather
    // than being silently dropped.
    members: previous?.members ?? [],
    updatedAt: new Date().toISOString(),
  };

  await fs.mkdir(configDir(spaceId, explicitRoot), { recursive: true });

  await fs.writeFile(
    activeConfigPath(spaceId, explicitRoot),
    `${JSON.stringify(record, null, 2)}\n`,
    'utf8'
  );

  return record;
}

// Cached Webex space membership (config card consolidation) — deliberately
// separate from writeActiveConfig: this refreshes automatically on every
// config-request, with no human "submitter", and must not bump revision or
// stamp source the way a real user submission does. Same file, same read,
// narrower write.
async function writeCachedMembers({ spaceId, members, explicitRoot }) {
  if (!spaceId) throw new Error('spaceId is required');
  if (!Array.isArray(members)) throw new Error('members array is required');

  const previous = await readActiveConfig({ spaceId, explicitRoot });

  const record = {
    schemaVersion: previous?.schemaVersion ?? 1,
    revision: previous?.revision ?? 0,
    config: previous?.config ?? {},
    source: previous?.source ?? null,
    members,
    updatedAt: new Date().toISOString(),
  };

  await fs.mkdir(configDir(spaceId, explicitRoot), { recursive: true });

  await fs.writeFile(
    activeConfigPath(spaceId, explicitRoot),
    `${JSON.stringify(record, null, 2)}\n`,
    'utf8'
  );

  return record;
}

module.exports = {
  readActiveConfig,
  writeActiveConfig,
  writeCachedMembers,
};
