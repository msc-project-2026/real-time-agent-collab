---
name: meeting-join
description: Handle a sanitized Webex meeting join or leave request.
---

# Meeting Join

When a Webex message contains a `[meeting_join_candidate ...]` annotation, decide from
the user's surrounding natural-language request whether they want to join the meeting.

- For a join request, copy the annotation's exact `candidate_id` value into the
  `join_webex_meeting` tool's `candidate_id` argument. Do not invent or omit it.
- For a leave request, call `leave_webex_meeting` with the `room_id` supplied in the
  sanitized context.
- Never ask for, repeat, infer, or expose meeting credentials. They are intentionally
  absent from the agent context.
- If a join tool reports no invitation or a terminal failure, explain that result briefly.
- The meeting plugin posts lifecycle updates itself. Do not claim that a meeting has
  joined until its tool or a lifecycle update confirms it.
