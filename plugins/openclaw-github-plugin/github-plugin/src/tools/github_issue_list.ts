import { Type } from "typebox";
import { githubRequest } from "../auth/github-auth.js";
import { isPullRequestIssue, mapIssue } from "./github_issue_utils.js";
import type { GithubPluginConfig, ToolFactory } from "./types.js";

type ListIssuesParams = {
  owner: string;
  repo: string;
  state?: "open" | "closed" | "all";
  labels?: string[];
  assignee?: string;
  creator?: string;
  sort?: "created" | "updated" | "comments";
  direction?: "asc" | "desc";
  since?: string;
  per_page?: number;
  page?: number;
};

export function githubListIssuesTool(tool: ToolFactory) {
  return tool({
    name: "github_list_issues",
    label: "GitHub: List Issues",
    description:
      "List issues in a repository with optional filters. Pull requests returned by GitHub's shared Issues API are excluded.",
    parameters: Type.Object({
      owner: Type.String({ description: "Repository owner, organization, or user name." }),
      repo: Type.String({ description: "Repository name without the .git extension." }),
      state: Type.Optional(Type.Union([
        Type.Literal("open"),
        Type.Literal("closed"),
        Type.Literal("all"),
      ], { description: "Issue state to return. Defaults to open." })),
      labels: Type.Optional(Type.Array(Type.String(), {
        description: "Only return issues that have all of these label names.",
      })),
      assignee: Type.Optional(Type.String({
        description: "Filter by assignee login. GitHub also accepts none or *.",
      })),
      creator: Type.Optional(Type.String({ description: "Filter by creator login." })),
      sort: Type.Optional(Type.Union([
        Type.Literal("created"),
        Type.Literal("updated"),
        Type.Literal("comments"),
      ], { description: "Field used to sort results. Defaults to created." })),
      direction: Type.Optional(Type.Union([
        Type.Literal("asc"),
        Type.Literal("desc"),
      ], { description: "Sort direction. Defaults to desc." })),
      since: Type.Optional(Type.String({
        description: "Only return issues updated after this ISO 8601 timestamp.",
      })),
      per_page: Type.Optional(Type.Integer({
        description: "Number of GitHub API results to fetch per page. Maximum 100.",
        minimum: 1,
        maximum: 100,
        default: 30,
      })),
      page: Type.Optional(Type.Integer({
        description: "Page number to fetch.",
        minimum: 1,
        default: 1,
      })),
    }),

    async execute(params: ListIssuesParams, config: GithubPluginConfig) {
      const page = params.page ?? 1;
      const perPage = params.per_page ?? 30;
      const data = await githubRequest(config, "GET", "/repos/{owner}/{repo}/issues", {
        owner: params.owner,
        repo: params.repo,
        state: params.state ?? "open",
        labels: params.labels?.join(","),
        assignee: params.assignee,
        creator: params.creator,
        sort: params.sort,
        direction: params.direction,
        since: params.since,
        per_page: perPage,
        page,
      });

      const issues = data.filter((item: any) => !isPullRequestIssue(item));

      return {
        owner: params.owner,
        repo: params.repo,
        page,
        perPage,
        fetchedCount: data.length,
        issueCount: issues.length,
        issues: issues.map((issue: any) => mapIssue(issue)),
      };
    },
  });
}
