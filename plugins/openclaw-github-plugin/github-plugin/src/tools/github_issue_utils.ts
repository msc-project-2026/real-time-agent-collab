import { githubRequest } from "../auth/github-auth.js";
import type { GithubPluginConfig } from "./types.js";

export function isPullRequestIssue(data: any): boolean {
  return data?.pull_request != null;
}

function mapLabels(labels: any): Array<{ name: string; color?: string; description?: string }> {
  if (!Array.isArray(labels)) return [];

  return labels.map((label: any) => typeof label === "string"
    ? { name: label }
    : {
        name: label.name,
        color: label.color,
        description: label.description ?? undefined,
      });
}

export function mapIssue(data: any, includeBody = false) {
  return {
    number: data.number,
    title: data.title,
    ...(includeBody ? { body: data.body ?? "" } : {}),
    state: data.state,
    stateReason: data.state_reason ?? undefined,
    author: data.user?.login,
    labels: mapLabels(data.labels),
    assignees: Array.isArray(data.assignees)
      ? data.assignees.map((assignee: any) => assignee.login)
      : [],
    milestone: data.milestone
      ? { number: data.milestone.number, title: data.milestone.title }
      : null,
    comments: data.comments ?? 0,
    locked: data.locked ?? false,
    createdAt: data.created_at,
    updatedAt: data.updated_at,
    closedAt: data.closed_at ?? null,
    htmlUrl: data.html_url,
  };
}

export function mapIssueComment(data: any) {
  return {
    id: data.id,
    author: data.user?.login,
    body: data.body ?? "",
    createdAt: data.created_at,
    updatedAt: data.updated_at,
    htmlUrl: data.html_url,
  };
}

export async function getIssueOrThrow(
  config: GithubPluginConfig,
  owner: string,
  repo: string,
  issueNumber: number,
) {
  const data = await githubRequest(config, "GET", "/repos/{owner}/{repo}/issues/{issue_number}", {
    owner,
    repo,
    issue_number: issueNumber,
  });

  if (isPullRequestIssue(data)) {
    throw new Error(`#${issueNumber} is a pull request, not an issue. Use a pull-request tool instead.`);
  }

  return data;
}
