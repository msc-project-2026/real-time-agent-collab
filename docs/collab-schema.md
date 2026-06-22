# `.collab/` Directory Schema

## Purpose
The `.collab/` directory lives in the primary project repo and is the shared context store for the collaboration agent. Any agent should be able to read from these files to to understand the current state of the project, issues and unresolved questions.

## Cross-cutting conventions

These apply to all four files and exist to ensure all files are formatted in the same manner.

**Timestamps.** ISO 8601, UTC, e.g. `2026-06-18T14:32:00Z`. Every file carries at least one 'last_updated' field.

**IDs.** Where entries need to be referenced elsewhere, use a short prefixed sequential ID: `Q-001`, `Q-002` for questions, `I-001`, `I-002` for issues. An agent generates the next ID by taking the highest existing ID in the file and incrementing it.

**Concurrency.** `config.json` and `context.md` are low-frequency, whole-state files, therefore last-write-wins is acceptable but an agent should re-read file immediately before writing to minimise affecting another write. `open-questions.md` and `issues.md` are append/update logs, therefore agents should never delete existing entries, only appending new ones or flipping a `status` field for an existing entry.

**Status** Nothing gets deleted from `open-questions.md` or `issues.md`. Resolved issues or questions are simply marked as resolved, to allow for all previous entries to be left as a record.

---

## `config.json`

**Format:** JSON

**Purpose:** project configuration which defines which repos the agent swarm operates on, and how chats or workspace sessions map to them

**Fields:**
| Field | Type | Description |
|---|---|---|
| `repos` | array of `{name, url}` | every repo the swarm can act on |
| `space_mapping` | object, `{chat_id: repo_name}` | which chat/workspace corresponds to which repo |
| `last_updated` | string (ISO timestamp) | when this file was last changed |

**Update behaviour:** overwritten in full whenever project structure changes

**Empty/initial state:**
```json
{
    "repos": [],
    "space_mapping": {},
    "last_updated": null
}
```

**Populated example:**
```json
{
    "repos": [
        {
            "name": "real-time-agent-collab","url": "https://github.com/msc/real-time-agent-collab"
        },
        {
            "name": "web-app-test",
            "url": "https://github.com/msc/web-app-test"
        }
    ],
    "space_mapping": {
        "chat-111a": "real-time-agent-collab",
        "chat-111b": "web-app-test"
    },
    "last_updated": "2026-06-18T09:00:00Z"
}
```

---

## `context.md`

**Format:** Markdown with fixed headings

**Purpose:** a quick orientation snapshot of what's currently going on (should always be short enough that an agent can read it and immediately know the current state)

**Sections:**
- `## Current Topic`: one line defining what the team is presently focused on
- `## Active Discussion`: a short summary of ongoing discussions
- `## Recent Decisions`: a bounded list (10 entries), each line `- [timestamp] decision`

**Update behaviour:** `Current Topic` and `Active Discussion` are overwritten in place each time the focus shifts. `Recent Decisions` entries are prepended (newest first), with the oldest being dropped once list exceeds 10 entries

**Empty/initial state:**
```markdown
# Context

## Current Topic
_None yet._

## Active Discussion
_None yet._

## Recent Decisions
_None yet._
```

**Populated example:**
```markdown
# Context

## Current Topic
Designing the `.collab/` schema

## Active Discussion
Team agreed agents should not delete any entries from open-questions.md or issues.md, only updating status 

## Recent Decisions
- [2026-06-18T09:15:00Z] Use ISO 8601 UTC timestamps everywhere in .collab/
- [2026-06-18T09:00:00Z] config.json overwritten completely instead of appending
```

---

## `open-questions.md`

**Format:** Markdown with structured entries

**Purpose:** unresolved questions raised in chat that require a human (or other agent) to weigh in

**Fields per entry:**
- `ID`: `Q-00N`
- `Question`: the question itself
- `Raised by`: agent name or person 
- `Raised at`: timestamp
- `Status`: `open` or `resolved`
- `Resolution`: filled in once resolved, otherwise omitted

**Updated behaviour:** new entries appended at the bottom. When a question is answered, `Status` is changed to `resolved` and a `Resolution` is added

**Empty/initial state:**
```markdown
# Open Questions

_No open questions._
```

**Populated example:**
```markdown
# Open Questions

## Q-001 
- **Question:** Should `context.md` be overwritten or appended to on each update
- **Raised by:** Agent-007
- **Raised at:** 2026-06-18T09:05:00Z
- **Status:** resolved
- **Resolution:** Overwritten for Current Topic/Active Discussions, Recent Decisions uses bounded append

## Q-002
- **Question:** Do we need file locking or is last-write-wins acceptable?
- **Raised by:** Agent-001
- **Raised at:** 2026-06-18T09:30:00Z
- **Status:** open
```

---

## `issues.md`

**Format:** Markdown with structured entries

**Purpose:** bugs or problems identified by any source (chat discussions, agent browsing, source code)

**Fields per entry:**
- `ID`: `I-00N`
- `Issue Title`: short description of the issue
- `Source`: `chat`, `browser`, or `source`
- `Severity`: `low`, `medium`, `high`
- `Status`: `open`, `in-progress`, `resolved`
- `Reported at`: timestamp
- `Description`: more details on the issue

**Update behaviour:** new entries appended at the bottom. `Status` is updated as work progresses

**Empty/initial state:**
```markdown
# Issues

_No issues logged._
```

**Populated example:**
```markdown
# Issues

## I-001
- **Title:** API client retries indefinitely on 401
- **Source:** source
- **Severity:** high
- **Status:** open
- **Reported at:** 2026-06-18T10:00:00Z
- **Description:** Found while reviewing authentication, no max-retry limit results in hanging on a session
```

