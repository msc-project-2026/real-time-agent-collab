import { Type } from "typebox";
import { githubRequest } from "../auth/github-auth.js";
import type { GithubPluginConfig, ToolFactory } from "./types.js";

type GetRepositoryParams = {
  owner: string;
  repo: string;
};

export function githubGetRepositoryTool(tool: ToolFactory) {
  return tool({
    name: "github_get_repository",
    label: "GitHub: Get Repository",
    description:
      "Get basic repository information including default branch, visibility, clone URLs, and app permissions.",
    parameters: Type.Object({
      owner: Type.String({
        description: "Repository owner, organization, or user name.",
      }),
      repo: Type.String({
        description: "Repository name without the .git extension.",
      }),
    }),

    async execute(params: GetRepositoryParams, config: GithubPluginConfig) {
      const data = await githubRequest(config, "GET", "/repos/{owner}/{repo}", {
        owner: params.owner,
        repo: params.repo,
      });

      return {
        id: data.id,
        owner: data.owner?.login,
        name: data.name,
        fullName: data.full_name,
        description: data.description,
        private: data.private,
        visibility: data.visibility,
        defaultBranch: data.default_branch,
        fork: data.fork,
        archived: data.archived,
        disabled: data.disabled,
        htmlUrl: data.html_url,
        cloneUrl: data.clone_url,
        sshUrl: data.ssh_url,
        permissions: data.permissions,
        pushedAt: data.pushed_at,
        updatedAt: data.updated_at,
      };
    },
  });
}
