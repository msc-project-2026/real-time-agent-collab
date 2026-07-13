---
name: meeting-join
description: Join or leave a Webex meeting when the request includes its meeting link and ordinary password.
---

# Meeting Join

When a Webex message asks to join a meeting, use the meeting credentials in that
message directly.

- For a join request, call `join_webex_meeting` with the current `RoomId` as
  `room_id`, `MessageThreadId` as `parent_id` when available, the invitation's
  `Meeting link` as `meeting_link`, and its ordinary `Meeting password` as
  `meeting_password`. Never use `Meeting password for video system`.
- Normally the secure runner starts the Webex SDK automatically. When the join
  tool returns `joining`, do not call the browser tool; wait for the plugin's
  lifecycle update and report only the confirmed state.
- Only when the join tool returns `ready_for_browser` (the optional
  `requireBrowserReview` mode), call `inspect_webex_meeting_runner` with its
  `session_id`. Reason over that live semantic snapshot and choose the visible
  `Join Webex meeting` ref; do not use a hard-coded or remembered ref. Call
  `act_webex_meeting_runner` with the same `session_id` and chosen ref, then
  inspect again to verify the visible status.
- The scoped runner tools resolve the correct browser tab internally. Never
  pass a `targetId` to them. If an action reports a retryable stale/ref error,
  inspect again and choose a fresh ref based on the changed page. Do not retry
  an old ref without a new inspection: each ref is internally bound to the raw
  target ID returned by exactly one snapshot and can be consumed only once.
- Treat `browser_target_id_mismatch`, `browser_action_invalid`, and
  `browser_action_unsupported` as plugin/runtime compatibility failures. Do not
  retry them or fall back to constructing a generic browser target ID.
- Only if a scoped runner tool itself remains unavailable after one fresh
  inspection may you recover with the generic `browser` tool: focus the
  returned `tab_id`/`tab_label` once, then omit `targetId` from subsequent
  snapshot/ref actions. Re-inspect after every navigation or failed action.
- The secure local runner authenticates the Webex Meetings SDK with the
  configured human OAuth token. Never paste an OAuth token, refresh token,
  client secret, or account password into a web page.
- If the same request does not contain a meeting link and ordinary password, ask the
  sender to provide both in the same message.
- For a leave request, call `leave_webex_meeting` with the current `RoomId`.
- If a join tool reports a terminal failure, explain that result briefly.
- The meeting plugin posts lifecycle updates itself. Do not claim that a meeting has
  joined until its tool or a lifecycle update confirms it.
