import { Type } from "typebox";
import { githubRequest } from "../auth/github-auth.js";
import type { GithubPluginConfig, ToolFactory } from "./types.js";

type ListTreeParams = {
  owner: string;
  repo: string;
  path?: string;
  ref?: string;
};

export function githubListTreeTool(tool: ToolFactory) {
  return tool({
    name: "github_list_tree",
    label: "GitHub: List Tree",
    description:
      "List files and directories at a repository path, such as the repository root or src/.",
    parameters: Type.Object({
      owner: Type.String({
        description: "Repository owner, organization, or user name.",
      }),
      repo: Type.String({
        description: "Repository name without the .git extension.",
      }),
      path: Type.Optional(Type.String({
        description: "Directory path inside the repository. Omit or use an empty string for the repository root.",
        default: "",
      })),
      ref: Type.Optional(Type.String({
        description: "Branch, tag, or commit SHA to read from. Defaults to the repository default branch.",
      })),
    }),

    async execute(params: ListTreeParams, config: GithubPluginConfig) {
      const path = params.path ?? "";
      const route = path
        ? "/repos/{owner}/{repo}/contents/{path}"
        : "/repos/{owner}/{repo}/contents";

      const data = await githubRequest(config, "GET", route, {
        owner: params.owner,
        repo: params.repo,
        path,
        ref: params.ref,
      });

      if (!Array.isArray(data)) {
        throw new Error(`Path is a file, not a directory: ${path || "/"}`);
      }

      return {
        owner: params.owner,
        repo: params.repo,
        path,
        ref: params.ref,
        entries: data.map((entry: any) => ({
          name: entry.name,
          path: entry.path,
          type: entry.type,
          sha: entry.sha,
          size: entry.size,
          htmlUrl: entry.html_url,
          downloadUrl: entry.download_url,
        })),
      };
    },
  });
}
