# Webex Auto Join for OpenClaw

This native OpenClaw plugin mirrors a licensed Webex attendee into every group
space containing the messaging bot, discovers scheduled and instant
space-associated meetings, and joins them through the bundled Webex Meetings
SDK runner. Automatic work is owned by the Gateway lifecycle; it does not need
an LLM turn or an OpenClaw cron job.

The plugin registers a native OpenClaw background service and separate Webex
`meetings` webhooks for `created`, `updated`, `deleted`, `started`, and `ended`.
Webex does not include `started` or `ended` in an `all` subscription.

The build copies the pinned Webex browser SDK into `dist/webex.min.js`; runtime
asset serving therefore remains self-contained after the plugin is transferred.
Its upstream terms are included as `dist/WEBEX-SDK-LICENSE`.

## Install

For local development:

```sh
openclaw plugins install --link ./plugins/webex-auto-join
```

The entire directory is transferable. Copy it into another OpenClaw project,
install its dependencies, build it, add its directory to `plugins.load.paths`,
and enable `plugins.entries.webex-auto-join`.

## OAuth and secrets

Authorize the licensed attendee integration with `spark:all`, `spark:kms`, and
`meeting:schedules_read`. The bot and attendee must be different Webex
identities. Configure secrets with environment placeholders rather than literal
values:

```json
{
  "plugins": {
    "entries": {
      "webex-auto-join": {
        "enabled": true,
        "config": {
          "botToken": "${WEBEX_BOT_TOKEN}",
          "webhookUrl": "${WEBEX_AUTO_JOIN_WEBHOOK_URL}",
          "webhookSecret": "${WEBEX_WEBHOOK_SECRET}",
          "attendeeClientId": "${MEETING_JOIN_CLIENT_ID}",
          "attendeeClientSecret": "${MEETING_JOIN_CLIENT_SECRET}",
          "attendeeRefreshToken": "${MEETING_JOIN_REFRESH_TOKEN}",
          "expectedAttendeeEmail": "${MEETING_JOIN_EXPECTED_EMAIL}",
          "encryptionKey": "${MEETING_JOIN_ENCRYPTION_KEY}"
        }
      }
    }
  }
}
```

`WEBEX_AUTO_JOIN_WEBHOOK_URL` must be a public HTTPS URL ending with
`/webhooks/webex-auto-join`. OAuth rotation and operational state are encrypted
with AES-256-GCM below `OPENCLAW_STATE_DIR`. On first run, only OAuth token data
is imported from a compatible legacy `meeting-join-state.enc`; legacy sessions
are never revived.

## Behavior and limits

- Only group spaces and meetings carrying a managed `roomId` are automatic.
- A meeting ID is preferred; SIP address and Web link are fallbacks.
- The runner joins without sending or receiving media in v1.
- One session is allowed per meeting and per room, with four concurrent sessions
  by default. Capacity-blocked meetings remain pending.
- Webex admission, locking, moderation, licensing, and organization policies are
  not bypassed.

Manual compatibility tools remain available for pasted external meeting links:
`join_webex_meeting`, `leave_webex_meeting`,
`inspect_webex_meeting_runner`, and `act_webex_meeting_runner`.

Failed joins report a sanitized diagnostic containing the runner stage, Webex
SDK error name/code/message when available, and a session ID for log
correlation. The same detail is returned by `webex_auto_join_status`; meeting
URLs, credentials, tokens, passwords, and secrets are redacted.

## Development

```sh
npm run build -w @openclaw/webex-auto-join
npm test -w @openclaw/webex-auto-join
openclaw plugins validate
openclaw plugins inspect webex-auto-join --runtime --json
```
