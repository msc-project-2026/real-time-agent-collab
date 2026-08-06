import { beforeEach, describe, expect, it, vi } from "vitest";
import { githubRequest } from "../src/auth/github-auth.js";
import { githubAddIssueCommentTool } from "../src/tools/github_issue_add_comment.js";
import { githubCreateIssueTool } from "../src/tools/github_issue_create.js";
import { githubGetIssueTool } from "../src/tools/github_issue_get.js";
import { githubListIssueCommentsTool } from "../src/tools/github_issue_list_comments.js";
import { githubListIssuesTool } from "../src/tools/github_issue_list.js";
import { githubUpdateIssueTool } from "../src/tools/github_issue_update.js";

vi.mock("../src/auth/github-auth.js", () => ({
  githubRequest: vi.fn(),
}));

const requestMock = vi.mocked(githubRequest);
const config = {
  appId: "1",
  installationId: "2",
  privateKey: "test-key",
};
const captureTool = (definition: any) => definition;

function issue(overrides: Record<string, unknown> = {}) {
  return {
    number: 7,
    title: "Fix the bug",
    body: "Details",
    state: "open",
    state_reason: null,
    user: { login: "octocat" },
    labels: [{ name: "bug", color: "ff0000", description: "A bug" }],
    assignees: [{ login: "maintainer" }],
    milestone: null,
    comments: 1,
    locked: false,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    closed_at: null,
    html_url: "https://github.com/octo/repo/issues/7",
    ...overrides,
  };
}

function comment(overrides: Record<string, unknown> = {}) {
  return {
    id: 99,
    user: { login: "octocat" },
    body: "A comment",
    created_at: "2026-01-03T00:00:00Z",
    updated_at: "2026-01-03T00:00:00Z",
    html_url: "https://github.com/octo/repo/issues/7#issuecomment-99",
    ...overrides,
  };
}

beforeEach(() => {
  requestMock.mockReset();
});

describe("github_list_issues", () => {
  it("passes filters and removes pull requests from the response", async () => {
    requestMock.mockResolvedValue([
      issue(),
      issue({ number: 8, pull_request: { url: "https://api.github.com/pulls/8" } }),
    ]);
    const tool = githubListIssuesTool(captureTool);

    const result = await tool.execute({
      owner: "octo",
      repo: "repo",
      state: "all",
      labels: ["bug", "urgent"],
      per_page: 10,
      page: 2,
    }, config);

    expect(requestMock).toHaveBeenCalledWith(config, "GET", "/repos/{owner}/{repo}/issues", expect.objectContaining({
      owner: "octo",
      repo: "repo",
      state: "all",
      labels: "bug,urgent",
      per_page: 10,
      page: 2,
    }));
    expect(result.fetchedCount).toBe(2);
    expect(result.issueCount).toBe(1);
    expect(result.issues).toHaveLength(1);
  });
});

describe("github_get_issue", () => {
  it("returns the complete issue body", async () => {
    requestMock.mockResolvedValue(issue());
    const tool = githubGetIssueTool(captureTool);

    const result = await tool.execute({ owner: "octo", repo: "repo", issue_number: 7 }, config);

    expect(result.issue.body).toBe("Details");
  });

  it("rejects pull request numbers", async () => {
    requestMock.mockResolvedValue(issue({ pull_request: { url: "https://api.github.com/pulls/7" } }));
    const tool = githubGetIssueTool(captureTool);

    await expect(tool.execute({ owner: "octo", repo: "repo", issue_number: 7 }, config))
      .rejects.toThrow("#7 is a pull request");
  });
});

describe("github_create_issue", () => {
  it("creates an issue with optional metadata", async () => {
    requestMock.mockResolvedValue(issue());
    const tool = githubCreateIssueTool(captureTool);

    await tool.execute({
      owner: "octo",
      repo: "repo",
      title: "Fix the bug",
      body: "Details",
      labels: ["bug"],
      assignees: ["maintainer"],
      milestone: 3,
    }, config);

    expect(requestMock).toHaveBeenCalledWith(config, "POST", "/repos/{owner}/{repo}/issues", {
      owner: "octo",
      repo: "repo",
      title: "Fix the bug",
      body: "Details",
      labels: ["bug"],
      assignees: ["maintainer"],
      milestone: 3,
    });
  });
});

describe("github_update_issue", () => {
  it("rejects an update with no changed fields", async () => {
    const tool = githubUpdateIssueTool(captureTool);

    await expect(tool.execute({ owner: "octo", repo: "repo", issue_number: 7 }, config))
      .rejects.toThrow("At least one issue field");
    expect(requestMock).not.toHaveBeenCalled();
  });

  it("preserves empty arrays when clearing labels and assignees", async () => {
    requestMock.mockResolvedValueOnce(issue()).mockResolvedValueOnce(issue({ labels: [], assignees: [] }));
    const tool = githubUpdateIssueTool(captureTool);

    await tool.execute({
      owner: "octo",
      repo: "repo",
      issue_number: 7,
      labels: [],
      assignees: [],
    }, config);

    expect(requestMock).toHaveBeenLastCalledWith(config, "PATCH", "/repos/{owner}/{repo}/issues/{issue_number}", {
      owner: "octo",
      repo: "repo",
      issue_number: 7,
      labels: [],
      assignees: [],
    });
  });
});

describe("issue comments", () => {
  it("lists comments after validating the issue", async () => {
    requestMock.mockResolvedValueOnce(issue()).mockResolvedValueOnce([comment()]);
    const tool = githubListIssueCommentsTool(captureTool);

    const result = await tool.execute({
      owner: "octo",
      repo: "repo",
      issue_number: 7,
      per_page: 20,
      page: 2,
    }, config);

    expect(result.comments).toHaveLength(1);
    expect(requestMock).toHaveBeenLastCalledWith(config, "GET", "/repos/{owner}/{repo}/issues/{issue_number}/comments", expect.objectContaining({
      issue_number: 7,
      per_page: 20,
      page: 2,
    }));
  });

  it("adds a comment after validating the issue", async () => {
    requestMock.mockResolvedValueOnce(issue()).mockResolvedValueOnce(comment({ body: "Investigating" }));
    const tool = githubAddIssueCommentTool(captureTool);

    const result = await tool.execute({
      owner: "octo",
      repo: "repo",
      issue_number: 7,
      body: "Investigating",
    }, config);

    expect(result.comment.body).toBe("Investigating");
    expect(requestMock).toHaveBeenLastCalledWith(config, "POST", "/repos/{owner}/{repo}/issues/{issue_number}/comments", {
      owner: "octo",
      repo: "repo",
      issue_number: 7,
      body: "Investigating",
    });
  });
});
