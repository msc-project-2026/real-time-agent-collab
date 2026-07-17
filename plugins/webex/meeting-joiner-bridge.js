// A small in-process bridge between the Webex channel and the optional
// meeting-joiner plugin. Keeping this in the channel plugin avoids adding a
// hard runtime dependency on the joiner when it is disabled.
'use strict';

const HANDLER_KEY = Symbol.for('real-time-agent-collab.webex-meeting-joiner');

function registerMeetingJoiner(handler) {
  if (!handler || typeof handler.handleCommand !== 'function') {
    throw new TypeError('meeting joiner must expose handleCommand');
  }
  globalThis[HANDLER_KEY] = handler;
  return () => {
    if (globalThis[HANDLER_KEY] === handler) delete globalThis[HANDLER_KEY];
  };
}

async function handleMeetingCommand(command) {
  const handler = globalThis[HANDLER_KEY];
  if (!handler) return false;
  return Boolean(await handler.handleCommand(command));
}

module.exports = { registerMeetingJoiner, handleMeetingCommand };
