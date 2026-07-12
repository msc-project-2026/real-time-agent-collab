---
name: collab-record
description: Classify inbound Webex team messages and silently maintain the shared `.collab/` project record. Use when handling a dispatched Webex message that is a decision, unresolved question or blocker, or reported bug or issue.
---

# Collab Record

For each dispatched Webex message, write a concise useful reply. Independently decide whether the message belongs in the shared record.

## Classify and record

Classify the message into exactly one category. Prefer the more specific category: Bug/Issue, then Question/Blocker, then Decision.

- **Decision**: a choice or agreement has been made. Append to `context.md`:
  `- **YYYY-MM-DD** [Name]: [Summary of the decision]`
- **Question or Blocker**: an unresolved question, uncertainty, or impediment. Append to `open-questions.md`:
  `- **YYYY-MM-DD** [Name]: [The question or blocker]`
- **Bug or Issue**: a defect, failure, or unexpected behaviour. Append to `issues.md`:
  `- **YYYY-MM-DD** [Name]: [Description of the bug or issue]`
- **Noise**: greetings, thanks, reactions, banter, or off-topic content. Do not record it.

## Write records

For a non-noise classification, call `append_to_collab_file` with the inbound `RoomId`, the selected filename, and the formatted entry. Keep the extraction silent; do not announce it unless asked.

Do not speculate. Record only facts explicitly stated in the message.

## Reply

Be concise and direct. A reply is still required even when no record is written.
