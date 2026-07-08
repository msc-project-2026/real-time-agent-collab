import { Buffer } from "node:buffer";
import { Type } from "typebox";
import { githubRequest } from "../auth/github-auth.js";
import type { GithubPluginConfig, ToolFactory } from "./types.js";

type GetFileParams = {
  owner: string;
  repo: string;
  path: string;
  ref?: string;
};

export function githubGetFileTool(tool: ToolFactory) {
  return tool({
    name: "github_get_file",
    label: "GitHub: Get File",
    description:
      "Read a single file from a repository at an optional branch, tag, or commit ref.",
    parameters: Type.Object({
      owner: Type.String({
        description: "Repository owner, organization, or user name.",
      }),
      repo: Type.String({
        description: "Repository name without the .git extension.",
      }),
      path: Type.String({
        description: "File path inside the repository, for example README.md or src/index.ts.",
      }),
      ref: Type.Optional(Type.String({
        description: "Branch, tag, or commit SHA to read from. Defaults to the repository default branch.",
      })),
    }),

    async execute(params: GetFileParams, config: GithubPluginConfig) {
      const data = await githubRequest(config, "GET", "/repos/{owner}/{repo}/contents/{path}", {
        owner: params.owner,
        repo: params.repo,
        path: params.path,
        ref: params.ref,
      });

      if (Array.isArray(data)) {
        throw new Error(`Path is a directory, not a single file: ${params.path}`);
      }

      if (data.type !== "file") {
        throw new Error(`Path is not a regular file: ${params.path} (type: ${data.type})`);
      }

      const content = data.encoding === "base64"
        ? Buffer.from(data.content ?? "", "base64").toString("utf8")
        : data.content;

      return {
        owner: params.owner,
        repo: params.repo,
        path: data.path,
        name: data.name,
        sha: data.sha,
        size: data.size,
        encoding: data.encoding,
        content,
        htmlUrl: data.html_url,
        downloadUrl: data.download_url,
      };
    },
  });
}
