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
- When the join tool returns `ready_for_browser`, use the OpenClaw `browser`
  tool with the returned `browser_profile` and `tab_id`/`tab_label`. Take a
  fresh snapshot, inspect the current page semantically, and activate the
  visible `Join Webex meeting` action by its current snapshot ref. Do not use
  hard-coded selectors, coordinates, or a remembered ref. Take another
  snapshot after the action and report the visible status accurately.
- Keep the returned stable tab handle consistent on every browser operation.
  For an `act` call, when both an outer `targetId` and `request.targetId` are
  present, set both to the same returned `tab_id` or `tab_label`. Prefer a
  fresh snapshot over a timed `act` wait, and never mix handles from two tabs.
- The secure local runner authenticates the Webex Meetings SDK with the
  configured human OAuth token. Never paste an OAuth token, refresh token,
  client secret, or account password into a web page.
- If the same request does not contain a meeting link and ordinary password, ask the
  sender to provide both in the same message.
- For a leave request, call `leave_webex_meeting` with the current `RoomId`.
- If a join tool reports a terminal failure, explain that result briefly.
- The meeting plugin posts lifecycle updates itself. Do not claim that a meeting has
  joined until its tool or a lifecycle update confirms it.
