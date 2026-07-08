import { Type } from "typebox";
import { githubRequest } from "../auth/github-auth.js";
import type { GithubPluginConfig, ToolFactory } from "./types.js";

type ListRepositoriesParams = {
  per_page?: number;
  page?: number;
};

export function githubListReposTool(tool: ToolFactory) {
  return tool({
    name: "github_list_repos",
    label: "GitHub: List Repositories",
    description:
      "List all repositories accessible to the GitHub App installation. Returns an array of repository names and their visibility (public/private).",
    parameters: Type.Object({
      per_page: Type.Optional(Type.Number({
        description: "How many repositories to return per page. GitHub max is 100.",
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

    async execute(params: ListRepositoriesParams, config: GithubPluginConfig) {
      const perPage = params.per_page ?? 30;
      const page = params.page ?? 1;

      const data = await githubRequest(config, "GET", "/installation/repositories", {
        per_page: perPage,
        page,
      });

      return {
        total_count: data.total_count,
        repositorySelection: data.repository_selection,
        page,
        perPage,
        repositories: data.repositories.map((repo: any) => ({
          owner: repo.owner?.login,
          name: repo.name,
          fullName: repo.full_name,
          private: repo.private,
          defaultBranch: repo.default_branch,
          htmlUrl: repo.html_url,
          permissions: repo.permissions,
        })),
      };
    },
  });
}
