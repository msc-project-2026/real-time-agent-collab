// ********* UTILS/PARSE-JSON.JS *********
'use strict';

function parseJsonObjectFromText(text) {
  if (!text || typeof text !== 'string') {
    throw new Error('text is required');
  }

  const trimmed = text.trim();

  try {
    return JSON.parse(trimmed);
  } catch {
    // Not strict JSON; try markdown-fenced JSON or embedded JSON below.
  }

  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced?.[1]) {
    return JSON.parse(fenced[1].trim());
  }

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');

  if (start !== -1 && end !== -1 && end > start) {
    return JSON.parse(trimmed.slice(start, end + 1));
  }

  throw new Error('No JSON object found in text');
}

module.exports = {
  parseJsonObjectFromText,
};
