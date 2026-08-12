'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { resolveWebexUrl } = require('./api');

test('resolveWebexUrl accepts API paths and official transcript download links', () => {
  assert.equal(resolveWebexUrl('/meetings/m1'), 'https://webexapis.com/v1/meetings/m1');
  assert.equal(
    resolveWebexUrl('https://webexapis.com/v1/meetingTranscripts/t1/download?format=vtt'),
    'https://webexapis.com/v1/meetingTranscripts/t1/download?format=vtt'
  );
});

test('resolveWebexUrl refuses to forward a bearer token outside Webex', () => {
  assert.throws(
    () => resolveWebexUrl('https://example.com/meetingTranscripts/t1/download'),
    /Refusing to send Webex credentials/
  );
});
