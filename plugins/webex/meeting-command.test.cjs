'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { isMeetingControlCommand, isMeetingPolicyCommand, stripLeadingAddress } = require('./meeting-command');

test('recognizes supported meeting controls with a native or plain-text address', () => {
  assert.equal(isMeetingControlCommand('@OpenClaw leave meeting', 'OpenClaw'), true);
  assert.equal(isMeetingControlCommand('openclaw leave meeting', 'OpenClaw'), true);
  assert.equal(isMeetingControlCommand('OpenClaw, /meeting status', 'OpenClaw'), true);
  assert.equal(isMeetingControlCommand('/meeting leave', 'OpenClaw'), true);
});

test('recognizes natural-language join policy so the chat LLM stays quiet', () => {
  assert.equal(isMeetingControlCommand('the agent should never join the meeting', 'OpenClaw'), true);
  assert.equal(isMeetingControlCommand("don't join meetings", 'OpenClaw'), true);
  assert.equal(isMeetingControlCommand('you can join meetings', 'OpenClaw'), true);
  assert.equal(isMeetingControlCommand('/meeting never', 'OpenClaw'), true);
  assert.equal(isMeetingControlCommand('/meeting enable', 'OpenClaw'), true);
});

test('does not treat ordinary discussion as a meeting control', () => {
  assert.equal(isMeetingControlCommand('The openclaw meeting is active', 'OpenClaw'), false);
  assert.equal(isMeetingControlCommand('Can OpenClaw leave a meeting?', 'OpenClaw'), false);
  assert.equal(stripLeadingAddress('The openclaw meeting is active', 'OpenClaw'), 'The openclaw meeting is active');
});

test('join-policy commands are recognised without any address so the gate never swallows them', () => {
  assert.equal(isMeetingPolicyCommand('never join meetings', 'OpenClaw'), true);
  assert.equal(isMeetingPolicyCommand('the agent should never join the meeting', 'OpenClaw'), true);
  assert.equal(isMeetingPolicyCommand('you can join meetings', 'OpenClaw'), true);
  assert.equal(isMeetingPolicyCommand('/meeting disable', 'OpenClaw'), true);
});

test('leave/status are not policy commands and ordinary talk is not policy', () => {
  assert.equal(isMeetingPolicyCommand('leave meeting', 'OpenClaw'), false);
  assert.equal(isMeetingPolicyCommand('/meeting status', 'OpenClaw'), false);
  assert.equal(isMeetingPolicyCommand('we should never join that vendor demo', 'OpenClaw'), false);
});
