import { Buffer } from "node:buffer";
import { Type } from "typebox";
import { githubRequest } from "../auth/github-auth.js";
import type { GithubPluginConfig, ToolFactory } from "./types.js";

type UpsertFileParams = {
  owner: string;
  repo: string;
  path: string;
  content: string;
  message: string;
  branch?: string;
  content_is_base64?: boolean;
};

function isNotFoundError(err: unknown) {
  return typeof err === "object" && err !== null && "status" in err && (err as { status?: number }).status === 404;
}

export function githubUpsertFileTool(tool: ToolFactory) {
  return tool({
    name: "github_upsert_file",
    label: "GitHub: Upsert File",
    description:
      "Create or update a file in a repository. If the file exists, the tool reads its SHA before updating it.",
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
      content: Type.String({
        description: "New file content. Treated as UTF-8 text unless content_is_base64 is true.",
      }),
      message: Type.String({
        description: "Commit message for the file change.",
      }),
      branch: Type.Optional(Type.String({
        description: "Branch to write to. Defaults to the repository default branch.",
      })),
      content_is_base64: Type.Optional(Type.Boolean({
        description: "Set true when content is already base64-encoded.",
        default: false,
      })),
    }),

    async execute(params: UpsertFileParams, config: GithubPluginConfig) {
      let existingSha: string | undefined;

      try {
        const existing = await githubRequest(config, "GET", "/repos/{owner}/{repo}/contents/{path}", {
          owner: params.owner,
          repo: params.repo,
          path: params.path,
          ref: params.branch,
        });

        if (Array.isArray(existing) || existing.type !== "file") {
          throw new Error(`Cannot update ${params.path} because it is not a regular file.`);
        }

        existingSha = existing.sha;
      } catch (err) {
        if (!isNotFoundError(err)) {
          throw err;
        }
      }

      const encodedContent = params.content_is_base64
        ? params.content
        : Buffer.from(params.content, "utf8").toString("base64");

      const data = await githubRequest(config, "PUT", "/repos/{owner}/{repo}/contents/{path}", {
        owner: params.owner,
        repo: params.repo,
        path: params.path,
        message: params.message,
        content: encodedContent,
        branch: params.branch,
        sha: existingSha,
      });

      return {
        owner: params.owner,
        repo: params.repo,
        path: params.path,
        branch: params.branch,
        action: existingSha ? "updated" : "created",
        commitSha: data.commit?.sha,
        commitHtmlUrl: data.commit?.html_url,
        contentSha: data.content?.sha,
        contentHtmlUrl: data.content?.html_url,
      };
    },
  });
}
