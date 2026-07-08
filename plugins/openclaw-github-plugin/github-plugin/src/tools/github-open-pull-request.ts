import { Type } from "typebox";
import { githubRequest } from "../auth/github-auth.js";
import type { GithubPluginConfig, ToolFactory } from "./types.js";

type OpenPullRequestParams = {
  owner: string;
  repo: string;
  title: string;
  head: string;
  base: string;
  body?: string;
  draft?: boolean;
  maintainer_can_modify?: boolean;
};

export function githubOpenPullRequestTool(tool: ToolFactory) {
  return tool({
    name: "github_open_pull_request",
    label: "GitHub: Open Pull Request",
    description:
      "Create a GitHub pull request from a head branch into a base branch.",
    parameters: Type.Object({
      owner: Type.String({
        description: "Repository owner, organization, or user name.",
      }),
      repo: Type.String({
        description: "Repository name without the .git extension.",
      }),
      title: Type.String({
        description: "Pull request title.",
      }),
      head: Type.String({
        description: "Branch containing changes. For same-repo PRs, use the branch name.",
      }),
      base: Type.String({
        description: "Branch you want the changes pulled into, for example main.",
      }),
      body: Type.Optional(Type.String({
        description: "Pull request body.",
      })),
      draft: Type.Optional(Type.Boolean({
        description: "Whether to create the pull request as a draft.",
        default: false,
      })),
      maintainer_can_modify: Type.Optional(Type.Boolean({
        description: "Whether maintainers can modify the pull request branch.",
        default: true,
      })),
    }),

    async execute(params: OpenPullRequestParams, config: GithubPluginConfig) {
      const data = await githubRequest(config, "POST", "/repos/{owner}/{repo}/pulls", {
        owner: params.owner,
        repo: params.repo,
        title: params.title,
        head: params.head,
        base: params.base,
        body: params.body,
        draft: params.draft ?? false,
        maintainer_can_modify: params.maintainer_can_modify ?? true,
      });

      return {
        owner: params.owner,
        repo: params.repo,
        number: data.number,
        title: data.title,
        state: data.state,
        draft: data.draft,
        head: data.head?.ref,
        base: data.base?.ref,
        htmlUrl: data.html_url,
        apiUrl: data.url,
      };
    },
  });
}
