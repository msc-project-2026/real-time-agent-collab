import { Type } from "typebox";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { githubCreateBranchTool } from "./tools/github-create-branch.js";
import { githubGetFileTool } from "./tools/github-get-file.js";
import { githubGetRepositoryTool } from "./tools/github-get-repository.js";
import { githubListReposTool } from "./tools/github-list-repos.js";
import { githubListBranchesTool } from "./tools/github-list-branches.js";
import { githubListTreeTool } from "./tools/github-list-tree.js";
import { githubOpenPullRequestTool } from "./tools/github-open-pull-request.js";
import { githubUpsertFileTool } from "./tools/github-upsert-file.js";
import { githubWhoamiTool } from "./tools/github-whoami.js";
import { githubAddIssueCommentTool } from "./tools/github_issue_add_comment.js";
import { githubCreateIssueTool } from "./tools/github_issue_create.js";
import { githubGetIssueTool } from "./tools/github_issue_get.js";
import { githubListIssueCommentsTool } from "./tools/github_issue_list_comments.js";
import { githubListIssuesTool } from "./tools/github_issue_list.js";
import { githubUpdateIssueTool } from "./tools/github_issue_update.js";



export default defineToolPlugin({
  id: "github-plugin",
  name: "github-plugin",
  description: "Connect to GitHub using GitHub App authentication.",

  // These fields come from the Gateway config (openclaw.json).
  // Never hard-code secrets here — OpenClaw reads them from the plugin.
  configSchema: Type.Object({
    appId: Type.String({
      description: "GitHub App ID (the number shown on the App settings page).",
    }),
    privateKey: Type.Optional(Type.String({
      description: "PEM-encoded private key content (the contents of your .pem file). Prefer privateKeyFile for a file path instead.",
    })),
    privateKeyFile: Type.Optional(Type.String({
      description: "Path to a PEM-encoded private key file (e.g. ~/.openclaw/secrets/github-private-key.pem).",
    })),
    installationId: Type.String({
      description: "Installation ID (found in the URL after installing the App).",
    }),
  }),

  tools: (tool) => [
    githubWhoamiTool(tool),
    githubListReposTool(tool),
    githubGetRepositoryTool(tool),
    githubListBranchesTool(tool),
    githubListTreeTool(tool),
    githubGetFileTool(tool),
    githubCreateBranchTool(tool),
    githubUpsertFileTool(tool),
    githubOpenPullRequestTool(tool),
    githubListIssuesTool(tool),
    githubGetIssueTool(tool),
    githubCreateIssueTool(tool),
    githubUpdateIssueTool(tool),
    githubListIssueCommentsTool(tool),
    githubAddIssueCommentTool(tool),
  ],
});
