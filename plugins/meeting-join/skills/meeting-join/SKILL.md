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
- If the same request does not contain a meeting link and ordinary password, ask the
  sender to provide both in the same message.
- For a leave request, call `leave_webex_meeting` with the current `RoomId`.
- If a join tool reports a terminal failure, explain that result briefly.
- The meeting plugin posts lifecycle updates itself. Do not claim that a meeting has
  joined until its tool or a lifecycle update confirms it.
