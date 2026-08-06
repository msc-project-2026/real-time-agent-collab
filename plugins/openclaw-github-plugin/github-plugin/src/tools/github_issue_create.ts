import { Type } from "typebox";
import { githubRequest } from "../auth/github-auth.js";
import { mapIssue } from "./github_issue_utils.js";
import type { GithubPluginConfig, ToolFactory } from "./types.js";

type CreateIssueParams = {
  owner: string;
  repo: string;
  title: string;
  body?: string;
  labels?: string[];
  assignees?: string[];
  milestone?: number;
};

export function githubCreateIssueTool(tool: ToolFactory) {
  return tool({
    name: "github_create_issue",
    label: "GitHub: Create Issue",
    description: "Create an issue in a repository, optionally assigning labels, users, and a milestone.",
    parameters: Type.Object({
      owner: Type.String({ description: "Repository owner, organization, or user name." }),
      repo: Type.String({ description: "Repository name without the .git extension." }),
      title: Type.String({ description: "Issue title.", minLength: 1 }),
      body: Type.Optional(Type.String({ description: "Issue body in GitHub-flavored Markdown." })),
      labels: Type.Optional(Type.Array(Type.String(), { description: "Existing repository label names." })),
      assignees: Type.Optional(Type.Array(Type.String(), { description: "GitHub logins to assign." })),
      milestone: Type.Optional(Type.Integer({ description: "Milestone number to associate.", minimum: 1 })),
    }),

    async execute(params: CreateIssueParams, config: GithubPluginConfig) {
      const data = await githubRequest(config, "POST", "/repos/{owner}/{repo}/issues", {
        owner: params.owner,
        repo: params.repo,
        title: params.title,
        body: params.body,
        labels: params.labels,
        assignees: params.assignees,
        milestone: params.milestone,
      });

      return {
        owner: params.owner,
        repo: params.repo,
        issue: mapIssue(data, true),
      };
    },
  });
}
