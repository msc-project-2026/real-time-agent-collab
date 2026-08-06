import { Type } from "typebox";
import { getIssueOrThrow, mapIssue } from "./github_issue_utils.js";
import type { GithubPluginConfig, ToolFactory } from "./types.js";

type GetIssueParams = {
  owner: string;
  repo: string;
  issue_number: number;
};

export function githubGetIssueTool(tool: ToolFactory) {
  return tool({
    name: "github_get_issue",
    label: "GitHub: Get Issue",
    description: "Get one repository issue, including its full Markdown body. Rejects pull request numbers.",
    parameters: Type.Object({
      owner: Type.String({ description: "Repository owner, organization, or user name." }),
      repo: Type.String({ description: "Repository name without the .git extension." }),
      issue_number: Type.Integer({ description: "The issue number.", minimum: 1 }),
    }),

    async execute(params: GetIssueParams, config: GithubPluginConfig) {
      const data = await getIssueOrThrow(config, params.owner, params.repo, params.issue_number);

      return {
        owner: params.owner,
        repo: params.repo,
        issue: mapIssue(data, true),
      };
    },
  });
}
