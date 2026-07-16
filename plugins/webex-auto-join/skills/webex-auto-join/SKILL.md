---
name: webex-auto-join
description: Report Webex meeting status or manually join and leave meetings. Always verify live meeting state with webex_auto_join_status before answering; never answer meeting-state questions from memory.
---

# Webex Auto Join

The plugin service discovers and joins space-associated Webex meetings without
an agent turn. Do not invoke a join tool for an automatic meeting and do not
claim a join before the plugin reports it.

## Always ground meeting state in a live tool call

- Meetings start, end, and change between messages, so any remembered state is
  stale. For EVERY question about meeting state — "what meetings are you in",
  "are you in a meeting", "did you join", "why did you leave" — call
  `webex_auto_join_status` first in that same turn and answer only from its
  result.
- Never claim "no active meeting" or "no active sessions" without a
  `webex_auto_join_status` call in the current turn whose `active` list is
  actually empty. Answering from memory here is always wrong.
- When status shows an active session, the bot IS in that meeting; use its
  `room_id`, `meeting_id`, and `session_id` as the context for follow-up
  commands instead of asking the user for details you already have.

## Leaving a meeting

- When asked to leave, call `leave_webex_meeting` with the current `room_id`
  immediately. Do NOT ask for a meeting link or invite first — leaving never
  requires one. The service resolves the meeting itself: if the current space
  has no session it leaves the sole active meeting, wherever it is.
- If the tool returns `ambiguous_active_meeting`, it includes the candidate
  meetings (`room_title`, `room_id`, `meeting_id`); ask the user which one and
  call the tool again with that meeting's `room_id`.
- Only after the tool itself returns `no_active_meeting` may you say there is
  nothing to leave — and even then say the bot is not in a meeting; only
  mention links if the user seems to want the bot to JOIN something.
- After a user-requested leave, the service suppresses automatic rejoin of that
  meeting until it ends. Never call `join_webex_meeting` for it again unless
  the user explicitly asks the bot to rejoin or supplies a fresh invitation;
  a rejoin request lifts the suppression automatically.

## Joining a meeting

- Automatic joins are handled by the service; never call a join tool for them
  and never claim a join before the plugin reports it.
- For a manually supplied meeting, call `join_webex_meeting` with `room_id`,
  the HTTPS `meeting_link`, the ordinary `meeting_password`, and `parent_id`
  when available. Never use the video-system password.
- The runner normally starts automatically. If a manual join returns
  `ready_for_browser`, inspect it with `inspect_webex_meeting_runner`, choose a
  fresh visible join ref, and submit it through `act_webex_meeting_runner`.
  Re-inspect after navigation or a stale-ref error.

## Safety

- Never place OAuth credentials, bot tokens, refresh tokens, client secrets, or
  account passwords in a tool argument or browser page.
- Host admission, meeting locks, and organization policy remain authoritative.
