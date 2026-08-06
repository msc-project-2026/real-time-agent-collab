import { Type } from "typebox";
import { githubRequest } from "../auth/github-auth.js";
import { getIssueOrThrow, mapIssue } from "./github_issue_utils.js";
import type { GithubPluginConfig, ToolFactory } from "./types.js";

type UpdateIssueParams = {
  owner: string;
  repo: string;
  issue_number: number;
  title?: string;
  body?: string;
  state?: "open" | "closed";
  labels?: string[];
  assignees?: string[];
  milestone?: number | null;
};

const updateFields = ["title", "body", "state", "labels", "assignees", "milestone"] as const;

export function githubUpdateIssueTool(tool: ToolFactory) {
  return tool({
    name: "github_update_issue",
    label: "GitHub: Update Issue",
    description:
      "Update, close, or reopen an issue. Labels and assignees replace their current complete sets; empty arrays clear them.",
    parameters: Type.Object({
      owner: Type.String({ description: "Repository owner, organization, or user name." }),
      repo: Type.String({ description: "Repository name without the .git extension." }),
      issue_number: Type.Integer({ description: "The issue number.", minimum: 1 }),
      title: Type.Optional(Type.String({ description: "Replacement issue title.", minLength: 1 })),
      body: Type.Optional(Type.String({ description: "Replacement issue body in GitHub-flavored Markdown." })),
      state: Type.Optional(Type.Union([
        Type.Literal("open"),
        Type.Literal("closed"),
      ], { description: "Set closed to close the issue or open to reopen it." })),
      labels: Type.Optional(Type.Array(Type.String(), {
        description: "Complete replacement set of label names. Use [] to clear all labels.",
      })),
      assignees: Type.Optional(Type.Array(Type.String(), {
        description: "Complete replacement set of assignee logins. Use [] to clear all assignees.",
      })),
      milestone: Type.Optional(Type.Union([
        Type.Integer({ minimum: 1 }),
        Type.Null(),
      ], { description: "Replacement milestone number, or null to remove the milestone." })),
    }),

    async execute(params: UpdateIssueParams, config: GithubPluginConfig) {
      const hasUpdate = updateFields.some((field) => params[field] !== undefined);
      if (!hasUpdate) {
        throw new Error("At least one issue field must be provided to update.");
      }

      await getIssueOrThrow(config, params.owner, params.repo, params.issue_number);

      const updates = Object.fromEntries(
        updateFields
          .filter((field) => params[field] !== undefined)
          .map((field) => [field, params[field]]),
      );

      const data = await githubRequest(config, "PATCH", "/repos/{owner}/{repo}/issues/{issue_number}", {
        owner: params.owner,
        repo: params.repo,
        issue_number: params.issue_number,
        ...updates,
      });

      return {
        owner: params.owner,
        repo: params.repo,
        issue: mapIssue(data, true),
      };
    },
  });
}
