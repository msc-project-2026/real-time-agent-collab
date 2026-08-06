import { Type } from "typebox";
import { githubRequest } from "../auth/github-auth.js";
import { getIssueOrThrow, mapIssueComment } from "./github_issue_utils.js";
import type { GithubPluginConfig, ToolFactory } from "./types.js";

type AddIssueCommentParams = {
  owner: string;
  repo: string;
  issue_number: number;
  body: string;
};

export function githubAddIssueCommentTool(tool: ToolFactory) {
  return tool({
    name: "github_add_issue_comment",
    label: "GitHub: Add Issue Comment",
    description: "Add a Markdown comment to an issue. Rejects pull request numbers.",
    parameters: Type.Object({
      owner: Type.String({ description: "Repository owner, organization, or user name." }),
      repo: Type.String({ description: "Repository name without the .git extension." }),
      issue_number: Type.Integer({ description: "The issue number.", minimum: 1 }),
      body: Type.String({ description: "Comment body in GitHub-flavored Markdown.", minLength: 1 }),
    }),

    async execute(params: AddIssueCommentParams, config: GithubPluginConfig) {
      await getIssueOrThrow(config, params.owner, params.repo, params.issue_number);

      const data = await githubRequest(config, "POST", "/repos/{owner}/{repo}/issues/{issue_number}/comments", {
        owner: params.owner,
        repo: params.repo,
        issue_number: params.issue_number,
        body: params.body,
      });

      return {
        owner: params.owner,
        repo: params.repo,
        issueNumber: params.issue_number,
        comment: mapIssueComment(data),
      };
    },
  });
}
