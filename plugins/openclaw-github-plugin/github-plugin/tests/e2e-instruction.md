# OpenClaw GitHub Issue E2E Test

Use a dedicated GitHub test repository, not a production repository.

## 1. Set test variables

```bash
OWNER="your-owner"
REPO="your-test-repository"
RUN_ID="$(date +%Y%m%d-%H%M%S)"
SESSION="github-issue-e2e-$RUN_ID"

RESULT_DIR="e2e-results/$RUN_ID"
mkdir -p "$RESULT_DIR"
```

Each command saves:

- `.json`: structured Agent result from standard output
- `.log`: verbose output, tool calls, and errors from standard error
- `.exit-code`: `0` for command success; any other value indicates failure

## 2. Verify runtime tool registration

```bash
openclaw plugins inspect github-plugin --runtime --json \
  > "$RESULT_DIR/00-plugin-inspect.json" \
  2> "$RESULT_DIR/00-plugin-inspect.log"

STATUS=$?
echo "$STATUS" > "$RESULT_DIR/00-plugin-inspect.exit-code"
```

Confirm `00-plugin-inspect.json` contains all six tools:

```text
github_create_issue
github_get_issue
github_list_issues
github_add_issue_comment
github_list_issue_comments
github_update_issue
```

Stop if any tool is missing or the exit code is not `0`.

## 3. Create an issue

```bash
openclaw agent \
  --agent main \
  --session-key "$SESSION" \
  --verbose full \
  --json \
  --timeout 240 \
  --message "You are testing the GitHub Issue plugin. You are authorized to operate only on $OWNER/$REPO. You must call github_create_issue now. Create exactly one issue with title '[openclaw-e2e] $RUN_ID' and body 'Created by OpenClaw E2E test $RUN_ID'. Do not create branches, files, commits, or pull requests. Return the issue number, URL, title, and state." \
  > "$RESULT_DIR/01-create-issue.json" \
  2> "$RESULT_DIR/01-create-issue.log"

STATUS=$?
echo "$STATUS" > "$RESULT_DIR/01-create-issue.exit-code"
```

Confirm the exit code is `0`, then read `01-create-issue.json` and record the
created issue number:

```bash
ISSUE_NUMBER="the-created-issue-number"
```

## 4. Get and list the issue

```bash
openclaw agent \
  --agent main \
  --session-key "$SESSION" \
  --verbose full \
  --json \
  --timeout 240 \
  --message "Operate only on $OWNER/$REPO. First, you must call github_get_issue for issue #$ISSUE_NUMBER and verify its title is '[openclaw-e2e] $RUN_ID', its body is 'Created by OpenClaw E2E test $RUN_ID', and its state is open. Then you must call github_list_issues with state=open, sort=created, direction=desc, per_page=100, page=1 and confirm issue #$ISSUE_NUMBER appears. If it is not immediately visible, retry github_list_issues up to 5 times. Return PASS or FAIL for both get and list." \
  > "$RESULT_DIR/02-get-list-issue.json" \
  2> "$RESULT_DIR/02-get-list-issue.log"

STATUS=$?
echo "$STATUS" > "$RESULT_DIR/02-get-list-issue.exit-code"
```

## 5. Add and list a comment

```bash
openclaw agent \
  --agent main \
  --session-key "$SESSION" \
  --verbose full \
  --json \
  --timeout 240 \
  --message "Operate only on issue #$ISSUE_NUMBER in $OWNER/$REPO. You must call github_add_issue_comment and add exactly this comment: 'OpenClaw E2E comment $RUN_ID'. Then call github_list_issue_comments with per_page=100 and page=1, and verify that exact comment is present. Return the created comment ID and PASS or FAIL." \
  > "$RESULT_DIR/03-comment-issue.json" \
  2> "$RESULT_DIR/03-comment-issue.log"

STATUS=$?
echo "$STATUS" > "$RESULT_DIR/03-comment-issue.exit-code"
```

## 6. Update the issue

```bash
openclaw agent \
  --agent main \
  --session-key "$SESSION" \
  --verbose full \
  --json \
  --timeout 240 \
  --message "Operate only on issue #$ISSUE_NUMBER in $OWNER/$REPO. You must call github_update_issue to change its title to '[openclaw-e2e-complete] $RUN_ID' and its body to 'Updated by OpenClaw E2E test $RUN_ID'. Then call github_get_issue and verify both values were persisted and the issue is still open. Return PASS or FAIL." \
  > "$RESULT_DIR/04-update-issue.json" \
  2> "$RESULT_DIR/04-update-issue.log"

STATUS=$?
echo "$STATUS" > "$RESULT_DIR/04-update-issue.exit-code"
```

## 7. Close and verify the issue

```bash
openclaw agent \
  --agent main \
  --session-key "$SESSION" \
  --verbose full \
  --json \
  --timeout 240 \
  --message "Operate only on issue #$ISSUE_NUMBER in $OWNER/$REPO. You must call github_update_issue with state=closed. Then call github_get_issue and verify the final title is '[openclaw-e2e-complete] $RUN_ID', the final body is 'Updated by OpenClaw E2E test $RUN_ID', the state is closed, and closedAt is not null. Return the issue URL and a final PASS or FAIL. Do not delete anything." \
  > "$RESULT_DIR/05-close-issue.json" \
  2> "$RESULT_DIR/05-close-issue.log"

STATUS=$?
echo "$STATUS" > "$RESULT_DIR/05-close-issue.exit-code"
```

## 8. Review results

The result directory should contain:

```text
e2e-results/<RUN_ID>/
├── 00-plugin-inspect.json
├── 00-plugin-inspect.log
├── 00-plugin-inspect.exit-code
├── 01-create-issue.json
├── 01-create-issue.log
├── 01-create-issue.exit-code
├── 02-get-list-issue.json
├── 02-get-list-issue.log
├── 02-get-list-issue.exit-code
├── 03-comment-issue.json
├── 03-comment-issue.log
├── 03-comment-issue.exit-code
├── 04-update-issue.json
├── 04-update-issue.log
├── 04-update-issue.exit-code
├── 05-close-issue.json
├── 05-close-issue.log
└── 05-close-issue.exit-code
```

For every step, verify:

1. The `.exit-code` value is `0`.
2. The `.json` result has `ok: true` and `status: "ok"`.
3. The Agent result reports `PASS` for the requested checks.
4. The `.log` shows the expected tool calls and no errors.

Finally, verify on GitHub that the issue:

- has title `[openclaw-e2e-complete] <RUN_ID>`
- has body `Updated by OpenClaw E2E test <RUN_ID>`
- contains comment `OpenClaw E2E comment <RUN_ID>`
- is closed
- did not create any branch, commit, file, pull request, or additional issue

If a step fails after issue creation, use `github_update_issue` to close the
test issue. Do not delete the issue; keep it for debugging.

## 9. OpenClaw chat smoke test

After the command-line E2E test passes, use the OpenClaw chat interface to
check the normal user experience. Replace `OWNER/REPO` with the dedicated test
repository and send this as one message:

```text
Please complete a GitHub Issue smoke test in OWNER/REPO:

1. Create exactly one Issue titled “[openclaw-chat-test]”.
2. Read that Issue and confirm that its state is open.
3. Add this comment to the same Issue: “OpenClaw chat test comment”.
4. Update its title to “[openclaw-chat-test-complete]”.
5. Close the Issue.
6. Read it again and report its Issue number, URL, title, and final state.

Only operate on this test repository. Do not create any branches, commits,
files, Pull Requests, or additional Issues.

If a step fails after creating the Issue, try to close that Issue and tell me
which step failed.
```

The chat smoke test passes when:

- the Agent selects the correct GitHub Issue tools from natural language
- the Agent remembers the created Issue without asking for its number again
- exactly one Issue is created
- the comment is present
- the final title is `[openclaw-chat-test-complete]`
- the final state is `closed`
- the reply includes the Issue number and URL
- no branch, commit, file, or Pull Request is created

Use the command-line E2E test for repeatable acceptance evidence. Use this chat
test as an additional check of tool selection, context memory, and user
experience.
