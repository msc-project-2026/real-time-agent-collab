import { Type } from "typebox";
import { githubRequest } from "../auth/github-auth.js";
import type { GithubPluginConfig, ToolFactory } from "./types.js";

type ListBranchesParams = {
  owner: string;
  repo: string;
  protected?: boolean;
  per_page?: number;
  page?: number;
};

export function githubListBranchesTool(tool: ToolFactory) {
  return tool({
    name: "github_list_branches",
    label: "GitHub: List Branches",
    description:
      "List branches in a repository so the agent can choose a base branch for changes or pull requests.",
    parameters: Type.Object({
      owner: Type.String({
        description: "Repository owner, organization, or user name.",
      }),
      repo: Type.String({
        description: "Repository name without the .git extension.",
      }),
      protected: Type.Optional(Type.Boolean({
        description: "If provided, filter branches by protection status.",
      })),
      per_page: Type.Optional(Type.Number({
        description: "How many branches to return per page. GitHub max is 100.",
        minimum: 1,
        maximum: 100,
        default: 30,
      })),
      page: Type.Optional(Type.Number({
        description: "Page number to fetch.",
        minimum: 1,
        default: 1,
      })),
    }),

    async execute(params: ListBranchesParams, config: GithubPluginConfig) {
      const data = await githubRequest(config, "GET", "/repos/{owner}/{repo}/branches", {
        owner: params.owner,
        repo: params.repo,
        protected: params.protected,
        per_page: params.per_page ?? 30,
        page: params.page ?? 1,
      });

      return {
        owner: params.owner,
        repo: params.repo,
        page: params.page ?? 1,
        perPage: params.per_page ?? 30,
        branches: data.map((branch: any) => ({
          name: branch.name,
          protected: branch.protected,
          commitSha: branch.commit?.sha,
          commitUrl: branch.commit?.url,
        })),
      };
    },
  });
}
