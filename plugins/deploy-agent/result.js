// Wraps a deploy-cli / agent return value in OpenClaw's AgentToolResult shape:
// the model sees the value as text `content`, while the original structured
// value is preserved in `details` for logs and UI. Per the AgentTool contract,
// transport failures are thrown upstream, not encoded here.
'use strict';

function toToolResult(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return { content: [{ type: 'text', text }], details: value };
}

module.exports = { toToolResult };
