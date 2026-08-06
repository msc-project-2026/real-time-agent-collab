import { Type } from "typebox";
import { githubRequest } from "../auth/github-auth.js";
import { getIssueOrThrow, mapIssueComment } from "./github_issue_utils.js";
import type { GithubPluginConfig, ToolFactory } from "./types.js";

type ListIssueCommentsParams = {
  owner: string;
  repo: string;
  issue_number: number;
  since?: string;
  per_page?: number;
  page?: number;
};

export function githubListIssueCommentsTool(tool: ToolFactory) {
  return tool({
    name: "github_list_issue_comments",
    label: "GitHub: List Issue Comments",
    description: "List comments on an issue with pagination. Rejects pull request numbers.",
    parameters: Type.Object({
      owner: Type.String({ description: "Repository owner, organization, or user name." }),
      repo: Type.String({ description: "Repository name without the .git extension." }),
      issue_number: Type.Integer({ description: "The issue number.", minimum: 1 }),
      since: Type.Optional(Type.String({
        description: "Only return comments updated after this ISO 8601 timestamp.",
      })),
      per_page: Type.Optional(Type.Integer({
        description: "Number of comments to return per page. Maximum 100.",
        minimum: 1,
        maximum: 100,
        default: 30,
      })),
      page: Type.Optional(Type.Integer({ description: "Page number to fetch.", minimum: 1, default: 1 })),
    }),

    async execute(params: ListIssueCommentsParams, config: GithubPluginConfig) {
      await getIssueOrThrow(config, params.owner, params.repo, params.issue_number);

      const page = params.page ?? 1;
      const perPage = params.per_page ?? 30;
      const data = await githubRequest(config, "GET", "/repos/{owner}/{repo}/issues/{issue_number}/comments", {
        owner: params.owner,
        repo: params.repo,
        issue_number: params.issue_number,
        since: params.since,
        per_page: perPage,
        page,
      });

      return {
        owner: params.owner,
        repo: params.repo,
        issueNumber: params.issue_number,
        page,
        perPage,
        comments: data.map((comment: any) => mapIssueComment(comment)),
      };
    },
  });
}
