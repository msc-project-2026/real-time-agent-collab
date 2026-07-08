import { Type } from "typebox";
import { githubRequest } from "../auth/github-auth.js";
import type { GithubPluginConfig, ToolFactory } from "./types.js";

type CreateBranchParams = {
  owner: string;
  repo: string;
  new_branch: string;
  base_branch?: string;
  base_sha?: string;
};

function branchNameFromRef(ref: string) {
  return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
}

export function githubCreateBranchTool(tool: ToolFactory) {
  return tool({
    name: "github_create_branch",
    label: "GitHub: Create Branch",
    description:
      "Create a new branch from a base branch or explicit commit SHA.",
    parameters: Type.Object({
      owner: Type.String({
        description: "Repository owner, organization, or user name.",
      }),
      repo: Type.String({
        description: "Repository name without the .git extension.",
      }),
      new_branch: Type.String({
        description: "Name of the new branch to create, for example codex/update-readme.",
      }),
      base_branch: Type.Optional(Type.String({
        description: "Existing branch to copy from. Defaults to the repository default branch when base_sha is omitted.",
      })),
      base_sha: Type.Optional(Type.String({
        description: "Explicit commit SHA to create the new branch from. If provided, base_branch is not needed.",
      })),
    }),

    async execute(params: CreateBranchParams, config: GithubPluginConfig) {
      let baseSha = params.base_sha;
      let baseBranch = params.base_branch;

      if (!baseSha) {
        if (!baseBranch) {
          const repoData = await githubRequest(config, "GET", "/repos/{owner}/{repo}", {
            owner: params.owner,
            repo: params.repo,
          });
          baseBranch = repoData.default_branch;
        }

        if (!baseBranch) {
          throw new Error("Unable to resolve base branch for the new branch.");
        }

        const baseRef = await githubRequest(config, "GET", "/repos/{owner}/{repo}/git/ref/{ref}", {
          owner: params.owner,
          repo: params.repo,
          ref: `heads/${branchNameFromRef(baseBranch)}`,
        });
        baseSha = baseRef.object?.sha;
      }

      if (!baseSha) {
        throw new Error("Unable to resolve base commit SHA for the new branch.");
      }

      const created = await githubRequest(config, "POST", "/repos/{owner}/{repo}/git/refs", {
        owner: params.owner,
        repo: params.repo,
        ref: `refs/heads/${branchNameFromRef(params.new_branch)}`,
        sha: baseSha,
      });

      return {
        owner: params.owner,
        repo: params.repo,
        branch: branchNameFromRef(params.new_branch),
        baseBranch,
        baseSha,
        ref: created.ref,
        url: created.url,
      };
    },
  });
}
