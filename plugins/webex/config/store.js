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

  const previous = readActiveConfig({ spaceId, explicitRoot });

  const record = {
    schemaVersion: 1,
    revision: (previous?.revision ?? 0) + 1,
    config,
    source: source ?? null,
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
};
