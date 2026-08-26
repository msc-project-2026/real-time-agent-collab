# Real Time Collab Agent — Architecture v3

This supersedes the original PRD's processing model. The Webex-space-as-canonical-unit and deterministic-tools-for-side-effects principles carry forward; the batch/debounce pipeline, route taxonomy, and conversations.json do not. Where this doc is silent, the original PRD's intent (config confirmation flow, auditability, GitHub-optional) still holds.

## 1. Core principles

- **The model is stateless between calls.** Nothing persists inside the model between turns; everything it reasons over must be explicitly constructed and sent. This is architecture, not an implementation detail — it's the reason every decision below is shaped the way it is.
- **Every run starts fresh.** No long-lived, accumulating canonical sessions. Each triggered run is an isolated subagent spawn, context built entirely from structured files/index reads by our own code, not by trusting session-native accumulation or default compaction behavior (whose semantics we could not fully pin down — see §8a). Spawns are coordinated as steps under one Task Flow per message, not disconnected one-offs — see §7, §8.
- **Deterministic pre-signals bypass the model; one unified judgment handles what's genuinely ambiguous.** Mentions, config-command syntax, message metadata — checked in code, never re-derived by the LLM. The model is used once per decision point, not spread across redundant classification passes.
- **Side effects only through deterministic, invariant-enforcing tools.** The model proposes; tools validate and write. Tools don't trust prompt compliance (e.g. task graph consistency, cycle rejection, config promotion preconditions).
- **Structured state for anything authoritative or durable; ephemeral context for reasoning only.** Tasks are structured, tool-mediated, and bulk-injected (active set) or targeted-searched (archived). Raw conversation is a rolling window, not preserved indefinitely. Nothing in between (no mutable "conversations" entity) — see §7 for why that was cut.
- **Minimize per-call fixed overhead.** Dedicated agent workspace, separate from any general-purpose instance; trimmed tool/skill profile — no irrelevant example tools/skills inflating every system prompt (confirmed real cost via `/context detail`: ~7.5k tokens of fixed tool/skill schema overhead in a generic profile).

## 2. Per-thread window

One rolling structure per thread (root + each 1-level nested thread), replacing the earlier separate "buffer" and "context window" files — they were the same content at different lifecycle stages, now unified:

- Messages are tagged `pending` on arrival, `processed` once a triggered run has consumed them.
- `processed` portion is size-capped (rolling window).
- `pending` portion has its own independent backstop cap (max size / max wait) that forces a flush regardless of the readiness judgment (§4) — a safety valve against a thread that never crystallizes into a "ready" unit, not a primary trigger.
- Config-tagged messages are appended normally (not treated specially) — the readiness gate is instructed that a pure control-plane ask isn't inherently substantive, but if the same message also contains something substantive, it can still count toward readiness. No special-casing needed.
- Window is strictly per-thread. The tagging gate (§4) and its readiness decision only ever consider the thread the current message belongs to.

## 3. Message metadata

Each inbound message carries, minimally:

- `msg-id`
- `threadId` (root msg-id, or null for main)
- `senderId`
- `content`/text
- `botIsMentioned` (from Webex, deterministic)
- `datetime`

Worth carrying `datetime` explicitly now, unlike in a native-session design — since we're not relying on session-transcript ordering to imply sequence, timestamp has to travel with the message itself.

On arrival, a message is appended to its thread's window as `pending` immediately — before the tagging gate runs, as the very first deterministic step. This is a durability choice, not a modeling one: the message is stored regardless of what tagging or dispatch later decide, so nothing depends on those steps succeeding for the message to be captured. It also means the tagging gate's "pending slice" context (§4) already includes the current message — there's no separate "message + slice" concatenation to reason about, just "the slice, which now includes this message."

### 3a. Outbound recording — a sender decision, not a passive echo

**Addition (send-time recording revision):** the above describes *inbound* messages. Outbound messages (the model's own replies, and this plugin's own deterministic sends — config/task cards, task-notify's ack, the "thinking" placeholder) are **not** recorded via Webex's webhook echo (Webex redelivers every message in a space, including the bot's own — the naive approach would be to let that echo append it the same way an inbound message is). Instead, every sender goes through one shared function, `sendOutboundMessage` (`send.js`), which calls whatever actually reaches Webex (`sendFn`, real by default) and then — unless the caller explicitly opts out via `recordToThread: false` — records the result through the *same* `appendMessageToThreadWindow` inbound messages use, not a parallel implementation. `inbound/message.js` checks `personId === botId` *before* ever calling `appendMessageToThreadWindow`, so the echo never double-records or fights a deliberately-unrecorded send.

This makes recording an explicit, per-send decision instead of an automatic side effect of delivery:
- Real replies (`respond`, via `channel.js`), config/task cards, and task-notify's ack all record by default (`recordToThread: true`) — genuine content worth the model remembering later.
- The "thinking" placeholder (§5) is the one deliberate exception — sent with `recordToThread: false`, since a transient "processing…" filler has no value in a later prompt and must never resurface there.

**Threading a reply doesn't always target an existing thread** — a question asked bare in `__main__` gets a reply that starts a *brand-new* thread, rooted at the question itself, exactly the case `appendMessageToThreadWindow`'s root-seeding (§2) already exists for on the inbound side. Every sender supplies a `fetchMessageById` for this case, resolved as cheaply as it can: `channel.js` (the model's own replies) doesn't have the triggering message in memory, only its id, so it does a real Webex fetch; every deterministic sender (task-notify, cards, the placeholder) already has the triggering message in memory from the flow that's carrying it, so it just resolves to that directly — no network round-trip.

## 4. Tagging gate (per message, single cheap call, fresh context each time)

Context: the thread's `pending` slice only, which by this point already includes the current message (§3 — not the full processed window; this call is deliberately narrow and cheap).

Output schema, structured to reflect that these are semantically different things:

```
messageTags: {
  isAddressed: bool     // semantic addressing, NOT the deterministic botIsMentioned flag
  configRequest: bool   // semantic detection of a config ask, fallback to deterministic slash-command match where applicable
}
pendingThreadWindowDecision: {
  sliceReady: bool       // is there a complete, coherent unit of meaning in the pending slice yet
  reason: string
}
```

**Correction (send-time recording revision):** this field was originally named `ready`, renamed `sliceReady` once `shouldRespond`/`shouldProcess` (§5) sat alongside it and "ready" alone became ambiguous about what's ready.

**Addition (send-time recording revision):** `sliceReady` also covers a genuinely urgent, need-for-help signal even when the specific ask isn't fully articulated (e.g. "we're blocked," "this needs to happen today") — the gate is instructed to err toward capturing it now rather than waiting for it to be stated more precisely. Lower-risk than it might look: `sliceReady` alone no longer triggers a reply (§5's `shouldRespond`/`shouldProcess` split) — it only lets `extract`/`summarize` look at the content sooner, and `extract`'s own closed-taxonomy judgment (§7c) is a second, independent filter against over-extraction even if the gate lets urgent-but-vague content through.

This call does nothing but classify — no side effects, no tool calls that trigger anything downstream. The gate's only action is a single tool call carrying the schema above as structured parameters (e.g. `tag_message(isAddressed, configRequest, sliceReady, reason)`) — we never parse the model's free-text output to extract a decision. The tool call itself may enforce minimal shape validation (all fields present, correct types), but performs no dispatch. All dispatch logic lives entirely in our code (§5), reading the tool call's parameters, not in the model's hands — this keeps it unit-testable independent of the LLM.

## 5. Dispatch (deterministic code, not a model decision)

```
isBotAddressed = messageTags.isAddressed
shouldRespond = isBotMentioned OR isBotAddressed   // OR computed in code, never asked of the model twice
shouldProcess = shouldRespond OR pendingThreadWindowDecision.sliceReady
```

- `messageTags.configRequest` → route to the config flow (§6), independent of the general pipeline. Not Task-Flow-wrapped — see §6.
- `shouldProcess` → flush thread's pending slice, advance the flow and spawn `extract`/`summarize` (§7) — task/summary value doesn't depend on being spoken to, so these run whenever the slice is ready OR the bot was addressed, independent of each other.
- `shouldRespond` → spawn `respond` (§7), **sequenced after `extract`/`summarize`/`task-notify` settle** (see §5a below), not alongside them. **Correction (response-policy + extraction-calibration revision):** `respond` originally spawned on the same `shouldProcess` condition, with a prompt-level instruction to stay silent when only `sliceReady` (not addressed) was true. Manual testing showed this wasn't reliable — `respond` narrated an already-extracted, human-assigned task unprompted. Replaced with a controller-level gate: `respond` is only spawned at all when `shouldRespond` is true, guaranteeing silence rather than prompting for it.
- None of the above → `finish` the flow. Message stays `pending`. This is the common case, and it's a legitimate single-step flow — nothing wrong with a flow that only ever ran one task.

### 5a. The "last message" invariant, and the deterministic `respond` skip

**Addition (send-time recording revision):** a second bug surfaced once `shouldRespond` gating (above) shipped — when the same message both addressed the bot *and* caused a self-assigned task to auto-approve, the user got two separate messages: `task-notify`'s deterministic ack, and `respond`'s own independent conversational reply, narrating the same event twice.

The fix rests on a structural invariant of the dispatch loop above: gate evaluation runs fresh on every inbound message, over whatever's currently in the pending slice, and flushes *immediately* the moment `shouldProcess` becomes true. So for any message in a flushed batch *except the last one*, its own arrival-time evaluation (over the smaller slice that existed then) must have come back `shouldProcess: false` — otherwise the slice would already have flushed, smaller, right there. That holds for `shouldRespond` specifically too: if an earlier message's own addressing signal had been true at its own arrival, it would have flushed immediately, alone or with whatever had accumulated before it. **Within any flushed batch, only the last-arrived message could possibly be the one responsible for `shouldRespond` being true** — every earlier message in that batch got swept along by `sliceReady`/accumulation, not because it itself demanded a reply.

This lets the double-message case be resolved deterministically, no model judgment involved: `task-notify` (which already queries tasks touched by the *whole* batch, not just the last message — unrelated, unchanged mechanism) additionally checks, per notified task, whether that task's own evidence (`message_ids`) includes the batch's last-arrived message — `coversLastMessage`. `run-message-flow.js` spawns `respond` only when `shouldRespond` is true **and** no notified task's `coversLastMessage` is true; otherwise `respond` is skipped entirely (not spawned, not merely told to stay silent), since `task-notify` already sent something for the exact message that would have triggered `respond`'s own reply.

**Known, accepted narrow gap**: if the triggering message combines a task instruction *and* something unrelated (e.g. "please research X, and also, what's the deploy schedule?"), skipping `respond` entirely also drops the answer to the unrelated part — there's no attempt to have `respond` answer just the leftover portion. Accepted as a simplicity trade-off, not an oversight.

Because `respond` no longer runs alongside `extract`/`summarize` (it now runs after `task-notify`, which itself runs after `extract`), the perceived responsiveness gap is covered by a separate, unrelated-in-mechanism placeholder: the moment `shouldRespond` is confirmed, `sendThinkingAck` (`processing/thinking-ack.js`) sends one of a short rotating set of "processing…" phrases, deliberately with `recordToThread: false` (§3a) — standing in for a typing indicator, which Webex's bot API doesn't expose (confirmed: no such REST endpoint exists; the community-documented workaround for exactly this situation is a placeholder message).

The gate itself is also a flow step, not a bare session spawn — see §7a for why gate and processing live under one flow rather than two.

Flags/directives computed here are passed into the main session run as inputs, not re-derived there — avoids the double-classification problem the original route taxonomy had.

(Window-append timing — see §3: the message is already stored as `pending` before this stage runs, so dispatch here only decides what happens _next_, not whether the message gets recorded.)

## 6. Config flow

Implemented, not just designed — this one's built. Two handlers, cleanly separated:

- **Request handler** — triggered on `configRequest`. Reads active config, sends an interactive card into the Webex space showing current values and proposed changes.
- **Response handler** — hooked to that card. On submission, validates the update; if valid, saves it and sends a confirmation in a thread under the requesting message; if invalid, sends an error in the same thread instead.

The card itself is the pending-proposal step (it shows exactly what would change before anything is committed), and submitting it is the confirmation act — so this still satisfies the original PRD's proposal-first, explicit-confirmation principle, just via a UI affordance rather than a natural-language back-and-forth.

## 7. Processing flow (Task Flow)

Session-per-run (§8) describes the execution primitive — an isolated subagent spawn with fully code-constructed context. This section describes how those spawns are _coordinated_: not as independent, disconnected sessions the way the original design had it, but as steps under one durable OpenClaw Task Flow per message.

### 7a. One flow per message, not one flow per stage

A single managed flow is created once a message reaches the tagging gate (§4). The gate is itself the flow's first step, not a separate mechanism in front of it. The controller reads the gate's result and decides, in code, what happens next — this is the same dispatch logic as §5, just now expressed as flow transitions rather than bare session spawns:

- Nothing warranted → `finish` the flow. Single-step flow, done.
- `configRequest` → hand off to the config flow (§6) and `finish`. Config is deliberately **not** modeled as flow steps — it's not a multi-step LLM orchestration problem, it's a card-driven request/response pair; wrapping it in Task Flow would add coordination machinery it doesn't need.
- Mention or ready → `resume` (advance `currentStep`, carry the flushed batch/directives forward in `stateJson`) and spawn the next step(s).

One flow per message keeps the gate's output and the processing steps' input connected through the flow's own `stateJson`, rather than requiring the controller to manually stitch two separately-tracked records together.

### 7b. Granularity, dependencies, and the latency/quality tradeoff

This is intentionally an open structure, not a fixed pipeline shape — the flow can hold as many or as few steps as the work warrants, and that's a decision to revisit as the system matures, not one to lock in now. What's fixed is the mechanism; what's flexible is how finely you cut it.

**What a step is.** Each step is either an isolated subagent spawn (`api.runtime.subagent.run(...)` for the actual work, `runTask(...)` to register it under the flow — see §8 for why these are two separate calls) or, if a step is purely deterministic with no LLM involved, plain controller code with no spawn at all. Not every step needs to be a tracked task — only the ones worth independently inspecting or retrying.

**Coarse version (what §7 originally specified):** one step does task extraction, summary/index write, and the communication decision together, via sequential tool calls inside a single spawn. Fewer moving parts, lower latency (one model invocation, not several), but each step's prompt carries more responsibility at once.

**Finer version:** split into separate steps — e.g. `extract`, `summarize`, `respond` — each a narrowly-scoped spawn with its own tailored instructions (§8's agent-identity mechanism is what makes this cheap to do well). More focused prompts, easier to eval and debug in isolation, but more separate model invocations.

**Sequential vs. parallel is a real choice, not a default.** A flow isn't forced into a single chain:

- _Sequential_ — `resume` (advance `currentStep`) then `runTask`, repeated per step. Use this where a step genuinely needs a prior step's output.
- _Parallel_ — multiple `runTask` calls issued against the same flow without an intervening `resume`, where steps don't depend on each other's results. `extract` and `summarize` are a natural pair for this: both read the same input (flushed batch + window), neither needs the other's output. **Not yet verified against a concrete example** — worth a small spike confirming concurrent, non-chained `runTask` calls under one flow behave as expected before relying on it.
- `respond` is the one genuine sequential dependency worth keeping — it plausibly needs `extract`'s result (to reference a task it just logged), so `extract → respond` stays a chain even if `summarize` runs alongside `extract` rather than after it.

**What should actually decide the split — latency, not token cost.** Cost is close to a wash either way (isolated spawns are already cheap per the trimmed tool profile, and flow bookkeeping is pure metadata, not LLM spend), so token count isn't the deciding factor. Latency is: each additional _sequential_ step is a full separate model invocation, not a tool round-trip inside a live context — slower, not just pricier. This lands hardest on exactly the path the project's problem statement cares most about: responding immediately when directly addressed. Parallel steps don't cost latency the same way; only chains do. So the practical rule: split freely where steps can run in parallel or where latency isn't user-facing (e.g. summary/index writing, which nothing is waiting on); be more conservative splitting on the `extract → respond` chain specifically, since that's the one path where added latency is directly felt by someone waiting for a reply.

**Recommended sequencing:** build the coarse, single-step version first (this is what §7 as originally written already specifies), get real latency and quality numbers once it's running, then decompose based on evidence — starting with pulling `summarize` out as a parallel sibling to `extract` (cheap, no latency cost on the mention path), before considering separating `respond` out at all.

**Implementation guardrail:** before the full rewrite depends on Task Flow, do a minimal Task Flow API spike: create one managed flow, run one isolated gate spawn, link the spawn with `runTask`, update `stateJson` with `expectedRevision`, finish the flow, and confirm the resulting `flowId`, `taskId`, `runId`, and `sessionKey` are inspectable and usable for usage correlation. If that spike exposes API friction, keep the architecture's deterministic controller logic but adjust the orchestration envelope before building the full pipeline.

**Closed (send-time recording revision):** the gap noted here originally — a sent reply needing to be written back into the thread's window itself, as `processed`, so a human's follow-up has it in context — is now built, and this section's own recommendation (`respond` as a genuine sequential dependency) is exactly the current shape too: `respond` (response-policy revision) runs sequenced after `extract`/`summarize`/`task-notify`, not alongside them, and every send (real replies via `channel.js`, and this plugin's own deterministic sends) records itself through one shared function (`sendOutboundMessage`, §3a) rather than relying on the inbound webhook echo. See §3a and §5a for the full mechanism.

### 7c. Task schema

```
id: autogenerated
title: string              // short human-readable summary — required; a task with no
                            // rendering beyond type/status/assignee isn't reviewable
description: string        // optional longer elaboration
type: development | design | research   // closed positive taxonomy (see below), not urgency
assigned: unknown | <member/sender id>
deadline: unknown | datetime
status: unapproved | backlog | in_progress | in_review | done | archived   // drives the UI approve flow
confidence: null | number (0-1)   // only meaningful when assigned === "agent" — the
                                   // extraction model's own estimate that a self-assigned
                                   // task is genuinely warranted
delegation: null | { target: string, delegatedAt: datetime }   // set only by the
                                   // confidence auto-approval override below
message_ids: [...]        // direct evidence — NOT via any intermediate conversation hop
child_tasks: [...]        // single direction only
// parent_tasks is NEVER stored — derived by reverse lookup from child_tasks at read time
```

**Correction (response-policy + extraction-calibration revision):** `type`'s taxonomy was originally open-ended (`development | design | research | ...`, including a fourth `coordination` value at the tool layer). Manual testing showed this was too permissive — a technology decision and a direct question to the agent both got extracted as tasks. Closed to exactly `development | design | research`, each with a positive definition of what it concretely covers (see `processing/extract/instruction.js`); anything else is out of scope for `write_task`, however notable it is in the conversation.

**Addition (response-policy + extraction-calibration revision):** `confidence`/`delegation` are new, real, backend-owned fields. For a self-assigned task (`assigned === "agent"`), the model never sets `status` directly — it sets `confidence` instead, and `write_task` applies a deterministic auto-approval override: if `confidence >= CONFIDENCE_AUTO_APPROVE_THRESHOLD` (0.7) and the task's status immediately before this call was still `unapproved`, the tool forces `status: in_progress` and sets `delegation` (target chosen from a fixed per-type mapping, mirrored on the board's own dummy delegation targets). Below the threshold, the task stays `unapproved` pending human approval via a card (`processing/task-notify.js`, `task-card/`). This is distinct from the board's own manual delegate button, which is still local-only/unimplemented — see §14.

**Correction (phase 6 implementation):** the original schema above omitted `title`/`description` — an oversight caught building the board UI against it. A task record with no human-readable summary isn't actually reviewable by a person, only machine-filterable. `title` is required (same footing as `type`); `description` is optional elaboration. Both are ordinary patchable fields (last-write-wins on update), same as `type`/`assigned`/`deadline`/`status` — not append-only like `message_ids`/`child_tasks`.

**Correction (board-workflow revision):** `status`'s original enum (`open | approved | delegated | done | archived`) collapsed "approved and being worked on" into one value and treated delegation as a status. Replaced with `unapproved` (pre-approval, drives the Review Queue — same role `open` played) plus a traditional post-approval pipeline (`backlog | in_progress | in_review | done`), so human-assigned work in progress is actually trackable rather than sitting in one undifferentiated `approved` bucket. `archived` is unchanged. Delegation is no longer a status value at all — it's a board-local action (pick a target once a task's `assigned` is the special `agent` entry), not yet part of this persisted schema; see §14.

- `child_tasks` writes are tool-enforced: setting A→B automatically the reverse-derivable link, and cycles are rejected at the tool layer. `parent_tasks` is never stored on the task record itself — same non-mutation principle as summary `supersedes` (§9). For lookup, this can use the same lightweight reverse-index-table pattern as the supersession index (`child_id → parent_id` rows) rather than a full scan across all tasks, particularly once task count grows.
- A dedicated `search_tasks(include_archived: true)` tool exists for the case where a message references a task outside the active bulk-injected set (already completed/archived) — found tasks can have status flipped back via the same status-transition tool used elsewhere. **This requires its own search index (full-text or embedding-based) over archived tasks — it is not free, and is a distinct build item from the recall index in §9, not something that falls out of it.**
- Non-task categories (decisions, risks, coordination facts) are explicitly **not** structured or schema-tracked in v2. They're still captured, at lower fidelity, inside batch summaries (§9) — this was a deliberate scope narrowing to protect extraction reliability on the one type that matters for the project's actual goal (feeding the swarm), not a silent loss. Worth revisiting only if evals show real gaps.

## 8. Session, flow, and agent-workspace mechanics

### 8a. The execution primitive hasn't changed

Every step is still an **isolated, non-persistent subagent spawn** — blank slate, no accumulated context, fully code-constructed input. That principle survives unchanged from the original design; what changed is that spawns are no longer disconnected, individually-tracked one-offs — they're coordinated as steps of an OpenClaw Task Flow (§7). The original motivation still holds: authoring exactly what's in context every time avoids the accumulation/quality-degradation problems of the earlier long-lived-session design, and sidesteps needing to resolve OpenClaw's own unclear docs on bootstrap-file refresh timing and compaction behavior — every spawn is definitionally a first turn.

### 8b. Task vs. Flow — the two real constructs

Two things, not three — "run" is informal shorthand for an execution, not a separate named entity:

- **Task** — the atomic unit of detached work. One subagent spawn, one background job. Individually inspectable (`openclaw tasks show <id>`).
- **Flow** — a durable coordination record _above_ tasks. Doesn't do work itself; tracks a sequence of child tasks as one unit, with its own status, JSON state, and revision counter (persisted in the `flow_runs` table). Two modes:
  - **Managed** — our own controller code explicitly creates the flow and drives it between steps. This is what §7 uses.
  - **Mirrored** — auto-created, zero code, wraps a single detached spawn for a stable status handle. Not directly relevant here since every message that reaches the gate gets a real managed flow, but worth knowing it exists as the "no orchestration needed" fallback.

Controller lifecycle, in the order it's actually called:

```
createManaged({ controllerId, goal, currentStep, stateJson })
runTask({ flowId, runtime, childSessionKey, runId, task })   // per step that needs independent tracking
setWaiting({ flowId, expectedRevision, currentStep, waitJson })   // only if a step must pause on an external event
resume({ flowId, expectedRevision, currentStep, stateJson })   // advance between sequential steps
finish({ flowId, expectedRevision, stateJson })   // or fail(...)
requestCancel({ flowId, expectedRevision }) / cancel({ flowId, cfg })   // deliberate early stop, available at any point
```

Every mutating call after creation requires `expectedRevision`, threaded forward from the previous call's return — a stale write is rejected as a conflict rather than silently clobbering. This is the mechanism that replaces the bespoke watermark-plus-idempotent-replay plan from the previous draft: recovery reduces to reading the flow's persisted `currentStep`/`stateJson` rather than us tracking our own last-processed-message marker. `currentStep` and `stateJson` are entirely our own invented shape — TaskFlow doesn't impose a schema on them, and it owns none of the branching logic; every decision in §5 and §7a stays in our controller code, same as always.

### 8c. Two separate calls — tracking vs. actual content

Important distinction, easy to get wrong: `runTask`'s `task` field is a **short display label** for the audit trail, not the prompt. The actual context we construct (window, active tasks, flushed batch, dispatch directives) goes through a _separate_ call, `api.runtime.subagent.run({ sessionKey, message })` — `message` is the real content field. That call starts the spawn and returns `{ runId, sessionKey }`, which is then what gets passed into `runTask` to link the two records together:

```
const run = await api.runtime.subagent.run({ sessionKey, message: renderedPrompt });
const task = taskFlow.runTask({ flowId, runtime: "subagent", childSessionKey: run.sessionKey, runId: run.runId, task: "extract" });
```

`message` itself isn't the full raw input either — OpenClaw wraps it in a small fixed envelope ("[Subagent Context]... [Subagent Task] `<our message>` Begin.") before it reaches the model. The genuinely fixed prefix — system prompt, tool schemas, workspace bootstrap files — is owned separately again, by whichever agent identity the spawn targets. See 8d.

### 8d. Agent-workspace mapping — one identity per distinct instruction set, not per step

Multi-agent registration is cheap: an agent without its own explicit workspace path just gets an agent-id subdirectory under the shared root, so adding more identities is a config-entry cost, not an infrastructure one. This is the lever for keeping step-specific task-framing instructions at system-prompt level (elevated instruction-following priority, in general model behavior — not confirmed as an OpenClaw-specific mechanism, just inherited from the underlying model) without duplicating them into `message` on every call, and without cramming every step's instructions into one shared file.

Each spawn targets a specific agent id (`targetAgentId`), whose own `AGENTS.md` holds that identity's task framing as system-level content; `message` carries only the per-run dynamic state. Concretely, given the granularity from §7b:

- `collab-gate` — its own `AGENTS.md`, tagging-only framing.
- `collab-main` (or split further into `collab-extract` / `collab-summarize` / `collab-respond` if §7b's finer decomposition is adopted) — framing for whichever processing responsibilities that identity covers.

**Agent-identity count doesn't have to match step count.** If `extract` and `summarize` end up close enough in framing, they can share one identity even while running as two separate flow steps — the workspace/identity axis and the step-granularity axis are independent decisions, both revisitable without touching the other. All identities share the same storage root, tool profile, and everything else that isn't instruction-specific — only the per-identity `AGENTS.md` diverges.

### 8e. Audit trail and retention

The flow ledger itself already gives free visibility into step sequence, status, and timing (`openclaw tasks flow show <id>`), and OpenClaw's own maintenance sweep prunes terminal flows after 7 days — so the manual rolling-window session cleanup from the previous draft is no longer something we need to build ourselves. What the ledger does _not_ store is the actual prompt content (`message` payloads) sent at each step — for that, still worth a minimal, deliberately small append-write per step (run/task id, the constructed `message`, tool calls and results, final outcome) to our own storage, alongside config/state/batch files under the same storage/path module. Same scope as before: no query engine, no dashboard, one row/file per step, opened by id when reviewing.

## 9. Recall / vector index

Replaces the originally-planned `conversations.json` entirely — that entity's three original justifications (compaction-resistant digest, synthesis input for extraction, item-grouping) were each independently superseded by later decisions (vector index existing, extraction reading the raw window directly, items narrowing to tasks-only). What survives is narrower: a write-once-per-batch summary, not a mutable tracked entity.

**Index structure — one index per `space_id`, own directory, no mixing across spaces.** Each entry:

```
id: autogenerated
space_id / thread_id
summary_text          // distilled gist of the batch, NOT raw message text
keywords: [...]        // extracted at write time, for hybrid retrieval — semantic search alone
                        // can miss exact names/numbers/specifics that don't shift the meaning-vector much
message_ids: [...]     // backreference for fetching raw evidence if ever needed
created_at
supersedes: [id, ...]  // set only on the NEW entry, at write time, if a targeted lookup finds
                        // a clear predecessor. Never mutate the old entry.
```

- **Raw messages are not indexed** — only distilled summaries, keyed by the readiness-gate boundary (same unit already flowing through the main session run, no new chunking logic needed). This was a deliberate trade to fix retrieval noise (raw chat is mostly low-information) — accepted risk: a recall answer hinging on a verbatim detail not captured in the summary text may not surface via similarity search even though it exists in a linked raw message. Worth an explicit eval case, not assumed solved.
- **Supersession is a separate reverse-lookup index** (`old_id → new_id` rows), not a field on the old summary — this keeps every summary genuinely immutable after creation (errors in the write-time match are recoverable — the original is untouched and independently retrievable — rather than destructive, which an update-in-place model would have been). Fetching a summary also checks this index for anything that supersedes it.
- **Retrieval surfaces the chain, not just the current head.** A matched summary is returned alongside anything that supersedes it (and transitively, anything superseding _that_), not resolved down to a single latest version before reaching the consumer. Earlier versions can still be exactly what's relevant — e.g. "what did we consider before we landed on X" genuinely wants the superseded entry, not the current one. The answering call gets the full chain with timestamps and picks based on what's actually being asked, rather than the retrieval layer deciding recency always wins.
- **Query-time retrieval**: embed the question with the same embedding model used for writes (must match), nearest-neighbor search space-wide (index is already per-`space_id` — see below), ranked by similarity, hybrid-boosted by same-thread match and keyword overlap. Return top-k with metadata. **Correction (phase 7 implementation):** as originally written, this section filtered retrieval to `thread_id` before ranking. Implementation deliberately deviates — thread match is a ranking *signal*, not an exclusionary filter, since relevant history from another thread in the same space should still be able to surface (a cross-thread question shouldn't be structurally blind to the answer). The index remains one-per-`space_id`; only the thread-scoping changed.
- **Write-time lookup**: also corrected from the original design. Rather than the controller deterministically embedding the new batch's raw content to fetch lookup candidates, the summarize step (v3 §7c-adjacent, phase 7) is given the same query tool as query-time retrieval (`search_recall`) and decides for itself whether/how to search for a supersession candidate, anywhere in the space — this sidesteps a real mismatch between embedding raw batch text and embedding distilled summary text (different style/length, plausibly poor similarity even for genuinely related content), since the model can phrase its own query however makes sense. There is no deterministic controller-side candidate pre-fetch. The one deterministic context still provided is a small same-thread recency block (last few summaries for the current thread only) for continuity — a distinct, cheaper concern from the space-wide supersession search.
- Storage growth (index size over the project's lifetime) is not expected to be a practical problem at this project's scale, but every entry carries `created_at`/`thread_id`/`kind` from day one (no need for `space_id` on the entry itself, since the index is already partitioned by space at the directory level) specifically so a future retention/tiering policy is a metadata query later, not an index redesign now.

## 10. Observability and usage tracking

Usage tracking is a first-class part of the architecture, not an external tracing afterthought. The system should record structured metadata for every model-backed spawn so cost, latency, and behaviour can be analysed during development and evaluation.

The primary model-backed stages are:

- `tagging_gate` — the cheap per-message readiness/tagging call;
- `main_run` — the processing spawn that may perform task extraction/update, summary/index writing, and communication/answering.

Task extraction and answering are phases inside `main_run`, not separate top-level usage stages unless the architecture later splits them into separate Task Flow steps. The config flow is not model-backed in the current design, so it is not part of model-usage accounting except as deterministic timing/log metadata.

Every model-backed spawn should persist a usage record linked to the Task Flow structure, where available:

```
usage_id
evalRunId          // evaluation only, if applicable
scenarioId         // evaluation only, if applicable
spaceId
threadId
flowId
taskId
runId
sessionKey
stage              // tagging_gate | main_run | future split step
targetAgentId
triggerMessageIds
model
provider
inputTokens
outputTokens
cacheReadTokens
cacheWriteTokens
totalTokens
startedAt
completedAt
durationMs
status
error
```

The key linkage fields are `flowId`, `taskId`, `runId`, and `sessionKey`. These make it possible to reconstruct cost and latency per message, per flow, per step, per scenario, and per agent identity. Where OpenClaw diagnostic events do not expose enough information to correlate a usage event perfectly, fields should be left null rather than guessed.

Usage records should live alongside the plugin's own state, for example:

```text
.collab/spaces/<spaceId>/usage/usage.jsonl
```

For evaluation, each archived run should export both raw usage records and an aggregated usage summary. The summary should answer:

- how many model calls the scenario required;
- how many calls were tagging gates vs main runs;
- which step or agent identity consumed most tokens;
- how much direct-response paths cost compared with silent processing paths;
- whether isolated spawns and trimmed agent workspaces reduced per-call context size as expected.

This does not require Langfuse or a separate plugin. If OpenClaw emits `model.usage` diagnostic events, the existing Webex plugin should subscribe to those events and correlate them with Task Flow/run metadata. The goal is lightweight structured observability, not full distributed tracing.

## 11. Evaluation harness

Evaluation is a first-class workstream because the architecture needs stable seams for repeatable testing. The system should support synthetic Webex-like scenario runs that bypass the external Webex API but exercise the same internal pipeline as production.

Scenario scripts are ordered message streams. They do not contain `round` as an input concept. In the previous design, artificial rounds approximated debounce boundaries; in this design, flushes are determined by the tagging gate, mentions, config requests, and safety backstops. The observed flow/flush boundaries are therefore outputs of the system, not scenario annotations.

The evaluation path should preserve the production flow:

```text
scenario messages
→ synthetic hydrated Webex messages
→ same inbound/capture path
→ same per-thread window append
→ same managed flow creation
→ same tagging gate step
→ same deterministic dispatch
→ same isolated main-run spawn when triggered
→ same task writes
→ same summary/index writes
→ same communication decision and send tool
→ captured outbound sends
→ exported state, flows/tasks, usage, timings, and scoring inputs
```

The harness should not mock the model, bypass the tagging gate, or call private processing functions directly except through explicit test seams. Its value is that it tests the actual architecture without depending on live Webex delivery.

Each evaluation execution should get a unique `evalRunId`. Past runs for the same scenario should be archived, not overwritten, so changes in prompts, step granularity, agent identities, and model choice can be compared over time. A typical archive layout can be:

```text
plugins/webex/eval/outputs/<scenario-id>/<evalRunId>/
```

Each archived run should export at least:

- scenario metadata and ordered input messages;
- final per-thread windows;
- final task state;
- summary/index entries, or a readable exported representation of them;
- captured outbound messages;
- flow/task records or a normalized representation of them;
- tagging decisions;
- main-run tool calls/results, if logged;
- token usage records;
- token usage summary;
- timings;
- scoring inputs for task extraction/update and response quality.

Evaluation should compare expected outcomes against observed task state, response quality, summary/recall evidence, flow behaviour, and usage. It should not assume a predetermined batch boundary in the scenario file.

## 12. Explicit deltas from the original PRD

- Route taxonomy (`config_request`/`recall_request`/`task_request`/`append_only`/`append_and_process`/`process_pending_batch`/`ignore`) → replaced by deterministic pre-signals (mention, config-pattern) + one unified per-flush judgment. `recall_request` doesn't exist as a route at all — recall is answered on-demand via the index, not pre-classified.
- Debounce timer → removed, replaced by a content-based readiness gate with a size/time backstop as a safety valve only.
- Batch lifecycle (pending/processing/processed state machine) → replaced by OpenClaw Task Flow's revision-checked `currentStep`/`stateJson`, coordinating the gate and processing steps as one durable flow (§7, §8).
- `conversations.json` → removed. Replaced by write-once batch summaries in the vector index.
- Item taxonomy (task/issue/question/decision/risk/dependency/coordination) → narrowed to `tasks` only, as the schema in §7c. Everything else captured at lower fidelity inside summaries, not structurally tracked.
- Multiple long-lived, per-space accumulating sessions (one for routing, one for conversation processing, one for item extraction — each resending the full instruction/context of the previous turn on every subsequent forward pass) → replaced by isolated, fresh-per-run subagent spawns coordinated as steps under one Task Flow per message, with fully code-constructed context per spawn (§7, §8).
- Bespoke watermark + idempotent replay plan (an earlier draft's proposed reliability mechanism) → superseded before implementation by Task Flow's built-in revision tracking and resumability — no longer something to build by hand.
- Manual rolling-window session cleanup (cap N, evict oldest) → superseded by Task Flow's own 7-day terminal-flow pruning; no longer something we need to manage ourselves.

## 13. Open questions to verify while/before building

These are genuine unknowns from OpenClaw's docs/API that this architecture was designed to be robust to, but are still worth confirming directly against source/behavior rather than assumed:

- Whether the Cisco LLM proxy passes `cache_control` through, and how it's declared as a provider in `openclaw.json` (pending Arthur — non-blocking optimization, not a design dependency now that we're not relying on native accumulation for cost savings). Worth also confirming _how breakpoints get set_ if this is available — Anthropic allows multiple `cache_control` markers per request, not just one at the end of the prefix, meaning a stable section (e.g. task-framing instructions, tool schemas) could plausibly stay cached even while interleaved with the per-run dynamic state block (active tasks, thread window) that changes every call. Worth investigating rather than assuming isolated-per-run sessions forfeit all caching benefit by default.
- Exact contract of tool-result pruning / `before_prompt_build` hook — lower priority now given isolated-per-run sessions mean there's little accumulated tool-result cruft to prune within a single run, but still worth a look if any one run's sequential tool-call chain (§7) grows long enough to matter.
- Whether concurrent, non-chained `runTask` calls under one flow (the `extract`/`summarize` parallel case, §7b) actually behave as expected — verified from source that `runTask` and `subagent.run` exist and are separate calls (§8c), but not verified against a concrete example of issuing two without an intervening `resume`.
- Default behavior of `api.runtime.subagent.run`/`runTask` when `targetAgentId` is omitted — confirmed the parameter exists and is how agent-identity targeting (§8d) works, not confirmed what happens if it's left unset (inherits caller's own identity, or requires explicit targeting always).
- Exact shape and correlation fields of OpenClaw `model.usage` diagnostics — confirm whether usage events include `runId`, `sessionKey`, `sessionId`, `model`, `provider`, and cache-token fields directly, or whether the plugin needs a small in-memory correlation map from `runId`/`sessionKey` to `flowId`/`taskId`/`stage` (§10).

## 14. Deferred / explicitly out of scope

- Swarm integration (task delegation execution) — this system stops at "task approved and handed off," per original scope.
- Spec-kit integration — simulated only, not wired to the real swarm's spec documents.
- GitHub webhooks/writes — optional, opportunistic only, unchanged from original PRD.
- Structured extraction of non-task item types (decisions/risks/coordination) — possible future work if summaries prove insufficient for the UI-surfacing use case, not designed now.
- Shared per-task session for swarm handoff coordination — a real future question, explicitly parked.
- The board's own **manual** delegate-button write-back — a human delegating an already-approved task through the board UI is still local-only state (`board/src/App.jsx`), not persisted. Only the automatic, confidence-driven path (§7c) is real: `tasks-store.js`'s `delegation` field and the auto-approval override in `write_task` are implemented and write through. Manual write-back is deferred to the larger board write-back update, alongside making the space-member list (currently dummy, `config/members.js`) real.
