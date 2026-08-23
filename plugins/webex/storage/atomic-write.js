// ********* STORAGE/ATOMIC-WRITE.JS *********
'use strict';

// Write-temp-then-rename so a concurrent reader never observes a truncated/
// partial JSON file mid-write. rename() is atomic on POSIX for paths on the
// same filesystem, which the temp file always is (same directory as the
// target). This makes bare reads (readThreadsState/readTasksState, no lock)
// safe by construction — locking (flow/keyed-lock.js) is then purely a
// write-ordering concern, not a read-safety one.

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

async function writeJsonFileAtomic(filePath, value) {
  const dir = path.dirname(filePath);
  const tempPath = path.join(
    dir,
    `.${path.basename(filePath)}.${crypto.randomBytes(6).toString('hex')}.tmp`
  );

  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(tempPath, filePath);
}

module.exports = {
  writeJsonFileAtomic,
};
