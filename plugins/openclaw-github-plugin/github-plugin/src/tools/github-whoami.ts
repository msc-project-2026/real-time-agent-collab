import { Type } from "typebox";
import { createJwt, getInstallationDetails, githubRequest, resolvePrivateKey } from "../auth/github-auth.js";
import type { GithubPluginConfig, ToolFactory } from "./types.js";

export function githubWhoamiTool(tool: ToolFactory) {
  return tool({
    name: "github_whoami",
    label: "GitHub: Verify Connection",
    description:
      "Verify the GitHub connection is working. Fetches the GitHub App installation details and returns the authenticated account name and permissions.",
    parameters: Type.Object({}),

    async execute(_params: Record<string, never>, config: GithubPluginConfig) {
      // Step 1: create JWT for app-level authentication
      const privateKey = resolvePrivateKey(config);
      const appJwt = createJwt(config.appId, privateKey);

      // Step 2: use JWT to call the app installation endpoint
      const data = await getInstallationDetails(appJwt, config.installationId);

      // Step 3: also verify installation token exchange works
      let installTokenOk = false;
      let tokenErrorMessage = "";
      try {
        await githubRequest(config, "GET", "/installation/repositories", {
          per_page: 1,
        });
        installTokenOk = true;
      } catch (err) {
        tokenErrorMessage = err instanceof Error ? err.message : String(err);
      }

      // Step 4: return a clean summary - this is what the agent will see
      const result: any = {
        // If token exchange fails, we treat it as not fully authenticated
        // because we can't perform any actual repo operations.
        authenticated: installTokenOk,
        account: data.account?.login,
        accountType: data.account?.type,
        appId: data.app_id,
        repositorySelection: data.repository_selection,
        permissions: data.permissions,
        installationTokenWorks: installTokenOk,
      };

      if (!installTokenOk) {
        result.warning = `CRITICAL: JWT was valid, but generating an Installation Access Token failed.
          You CANNOT read or write repositories. Error details: ${tokenErrorMessage}`;
      }

      return result;
    },
  });
}
