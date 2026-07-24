import assert from "node:assert/strict";
import test from "node:test";
import { buildCollabSyncSessionKey } from "./openclaw-session.js";

test("builds isolated collab-sync hook session keys", () => {
  assert.equal(
    buildCollabSyncSessionKey("delivery-123"),
    "hook:collab-sync:delivery-123",
  );
  assert.notEqual(buildCollabSyncSessionKey(), buildCollabSyncSessionKey());
});
