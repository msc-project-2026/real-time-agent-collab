---
name: deploy-app
description: >-
  Deploy or update a web application on the hosting VPS from a git repository —
  for example "deploy a barebone Next.js app", "deploy github.com/org/repo",
  "host this repo", or "redeploy the api". Use whenever a user wants an app
  deployed, hosted, taken live, or given a public URL, or wants to stop, remove,
  or check the status of an already-deployed app.
metadata:
  openclaw:
    requires:
      env:
        - DEPLOY_VPS_HOST
---

# Deploying applications

Deployments run on a separate hosting VPS. You never run shell or docker
commands yourself — you hand the work to the deployment agent through tools. Your
job is to gather the right inputs, call the tool, and relay the result.

## Deploying or updating an app

Use the `request_deployment` tool. It passes the work to a cheaper deployment
agent, which builds and runs the app and reports back (including the public URL
on success).

- **name** — a short lowercase slug: letters, digits, single hyphens (it becomes
  the subdomain and container name). If the user didn't give one, infer a
  sensible slug from the repo or app name. Tell the user the URL it will get:
  `<name>.<deploy-domain>`.
- **repo** — a git URL or `owner/repo`.
- **private** — set `true` for a private GitHub repo; an access token is fetched
  automatically.
- **update** — set `true` to update an existing app (redeploy); omit for a new one.
- **env** — if the user supplied environment variables or an `.env` file, pass the
  content here. It is handled securely and never echoed. **Never paste secrets
  back into the chat**, and don't ask the user to repeat them in the open.
- **requested_by** — the requesting user's name or email, for the audit log.

For a "barebone" app with no repo (e.g. "deploy a blank Next.js app"), ask the
user for a starter repository to deploy, or confirm one they name — the
deployment agent deploys from a repo, it does not scaffold from nothing.

## Managing existing apps

The deployment agent also exposes tools you can ask it to use via a plain
`request_deployment`-style instruction, or that surface directly:

- **list_apps** — all deployed apps with status and URLs.
- **app_status** / **app_url** / **app_logs** — inspect one app.
- **stop_app** / **start_app** — pause or resume a container.
- **remove_app** — permanently delete an app (confirm with the user first).
- **host_resources** — the VPS memory/disk/CPU usage.

## Reporting back

- On success, give the user the public URL plainly.
- If a deploy is **refused for capacity**, tell the user the hosting VPS is full
  and they must free space or remove an app — offer to `list_apps` or report
  `host_resources` so they can choose what to drop.
- If the deployment agent reports a failure it could not fix on its own, relay
  the root cause it found in plain language rather than raw logs.

## Safety

- Removing an app is destructive — confirm before calling `remove_app`.
- Treat any env content as secret: never echo it, log it, or read it back aloud.
