import { randomUUID } from "node:crypto";

// Synthetic work must not share a conversational Webex SessionKey. A unique
// hook session makes concurrent GitHub deliveries independent across processes
// and prevents them from racing live room messages during initialization.
export function buildCollabSyncSessionKey(id = randomUUID()) {
  return `hook:collab-sync:${id}`;
}
