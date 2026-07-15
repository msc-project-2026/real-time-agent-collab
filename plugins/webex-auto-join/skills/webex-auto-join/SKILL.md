---
name: webex-auto-join
description: Report Webex auto-join coverage or manually join and leave meetings when explicitly requested.
---

# Webex Auto Join

The plugin service discovers and joins space-associated Webex meetings without
an agent turn. Do not invoke a join tool for an automatic meeting and do not
claim a join before the plugin reports it.

- Use `webex_auto_join_status` to report covered or uncovered group spaces,
  upcoming meetings, pending work, active sessions, and sanitized failures.
- For a manually supplied meeting, call `join_webex_meeting` with `room_id`, the
  HTTPS `meeting_link`, the ordinary `meeting_password`, and `parent_id` when
  available. Never use the video-system password.
- Use `leave_webex_meeting` with the current `room_id` when explicitly asked to
  leave.
- The runner normally starts automatically. If a manual join returns
  `ready_for_browser`, inspect it with `inspect_webex_meeting_runner`, choose a
  fresh visible join ref, and submit it through `act_webex_meeting_runner`.
  Re-inspect after navigation or a stale-ref error.
- Never place OAuth credentials, bot tokens, refresh tokens, client secrets, or
  account passwords in a tool argument or browser page.
- Host admission, meeting locks, and organization policy remain authoritative.
