import { beforeAll, describe, expect, it } from "vitest";
import { clearTokenCache } from "../src/auth/github-auth.js";
import { githubAddIssueCommentTool } from "../src/tools/github_issue_add_comment.js";
import { githubCreateIssueTool } from "../src/tools/github_issue_create.js";
import { githubGetIssueTool } from "../src/tools/github_issue_get.js";
import { githubListIssueCommentsTool } from "../src/tools/github_issue_list_comments.js";
import { githubListIssuesTool } from "../src/tools/github_issue_list.js";
import { githubUpdateIssueTool } from "../src/tools/github_issue_update.js";
import type { GithubPluginConfig } from "../src/tools/types.js";

const runIntegration = process.env.RUN_GITHUB_INTEGRATION === "1";
const integrationDescribe = runIntegration ? describe : describe.skip;
const captureTool = (definition: any) => definition;

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required integration-test environment variable: ${name}`);
  }
  return value;
}

integrationDescribe("GitHub Issue API integration", () => {
  let owner: string;
  let repo: string;
  let config: GithubPluginConfig;

  const createIssue = githubCreateIssueTool(captureTool);
  const getIssue = githubGetIssueTool(captureTool);
  const listIssues = githubListIssuesTool(captureTool);
  const updateIssue = githubUpdateIssueTool(captureTool);
  const addComment = githubAddIssueCommentTool(captureTool);
  const listComments = githubListIssueCommentsTool(captureTool);

  beforeAll(() => {
    owner = requiredEnv("GITHUB_TEST_OWNER");
    repo = requiredEnv("GITHUB_TEST_REPO");
    config = {
      appId: requiredEnv("GITHUB_APP_ID"),
      installationId: requiredEnv("GITHUB_INSTALLATION_ID"),
      privateKeyFile: requiredEnv("GITHUB_PRIVATE_KEY_FILE"),
    };

    // Always begin with a fresh installation token for this test run.
    clearTokenCache(config.installationId);
  });

  it("completes the full issue lifecycle", async () => {
    const runId = Date.now();
    const originalTitle = `[openclaw-integration] ${runId}`;
    const updatedTitle = `[openclaw-integration-updated] ${runId}`;
    const originalBody = `Created by integration test ${runId}`;
    const updatedBody = `Updated by integration test ${runId}`;
    const commentBody = `Integration test comment ${runId}`;

    let issueNumber: number | undefined;
    let issueClosed = false;

    try {
      const created = await createIssue.execute({
        owner,
        repo,
        title: originalTitle,
        body: originalBody,
      }, config);

      issueNumber = created.issue.number;
      expect(issueNumber).toBeGreaterThan(0);
      expect(created.issue.title).toBe(originalTitle);
      expect(created.issue.body).toBe(originalBody);
      expect(created.issue.state).toBe("open");
      expect(created.issue.htmlUrl).toContain(`/${owner}/${repo}/issues/`);

      const fetched = await getIssue.execute({
        owner,
        repo,
        issue_number: issueNumber,
      }, config);

      expect(fetched.issue.number).toBe(issueNumber);
      expect(fetched.issue.title).toBe(originalTitle);
      expect(fetched.issue.body).toBe(originalBody);
      expect(fetched.issue.state).toBe("open");

      // A newly created issue can take a few seconds to appear in the list
      // endpoint even though fetching it directly by number already succeeds.
      await expect.poll(async () => {
        const listed = await listIssues.execute({
          owner,
          repo,
          state: "open",
          sort: "created",
          direction: "desc",
          per_page: 100,
          page: 1,
        }, config);

        return listed.issues.map((item: any) => item.number);
      }, {
        interval: 2_000,
        timeout: 20_000,
      }).toContain(issueNumber);

      const addedComment = await addComment.execute({
        owner,
        repo,
        issue_number: issueNumber,
        body: commentBody,
      }, config);

      expect(addedComment.comment.id).toBeGreaterThan(0);
      expect(addedComment.comment.body).toBe(commentBody);

      const comments = await listComments.execute({
        owner,
        repo,
        issue_number: issueNumber,
        per_page: 100,
        page: 1,
      }, config);

      expect(comments.comments.some((item: any) => item.body === commentBody)).toBe(true);

      const updated = await updateIssue.execute({
        owner,
        repo,
        issue_number: issueNumber,
        title: updatedTitle,
        body: updatedBody,
      }, config);

      expect(updated.issue.title).toBe(updatedTitle);
      expect(updated.issue.body).toBe(updatedBody);

      const fetchedAfterUpdate = await getIssue.execute({
        owner,
        repo,
        issue_number: issueNumber,
      }, config);

      expect(fetchedAfterUpdate.issue.title).toBe(updatedTitle);
      expect(fetchedAfterUpdate.issue.body).toBe(updatedBody);

      const closed = await updateIssue.execute({
        owner,
        repo,
        issue_number: issueNumber,
        state: "closed",
      }, config);

      expect(closed.issue.state).toBe("closed");
      issueClosed = true;

      const fetchedAfterClose = await getIssue.execute({
        owner,
        repo,
        issue_number: issueNumber,
      }, config);

      expect(fetchedAfterClose.issue.state).toBe("closed");
      expect(fetchedAfterClose.issue.closedAt).not.toBeNull();
    } finally {
      // Keep the test repository tidy if an assertion fails after creation.
      if (issueNumber && !issueClosed) {
        try {
          await updateIssue.execute({
            owner,
            repo,
            issue_number: issueNumber,
            state: "closed",
          }, config);
        } catch (cleanupError) {
          console.warn(`Unable to close integration test issue #${issueNumber}:`, cleanupError);
        }
      }

      clearTokenCache(config.installationId);
    }
  }, 120_000);
});
