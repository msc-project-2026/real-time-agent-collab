// ********* CONFIG.JS *********
'use strict';

const fs = require('node:fs/promises');
const { activeConfigPath } = require('./paths');

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

module.exports = {
  readActiveConfig,
};
