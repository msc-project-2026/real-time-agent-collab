import { Type } from "typebox";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { getInstallationToken, resolvePrivateKey, createJwt, getInstallationDetails } from "./auth/github-auth.js";



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
    // -----------------------------------------------------------------------
    // github_whoami
    // A minimal smoke-test tool. Verifies the full auth chain works by
    // fetching installation details from GitHub and returning them to the agent.
    // Once this passes, we know JWT → Installation Token → API call all work.
    // -----------------------------------------------------------------------
    tool({
      name: "github_whoami",
      label: "GitHub: Verify Connection",
      description:
        "Verify the GitHub connection is working. Fetches the GitHub App installation details and returns the authenticated account name and permissions.",
      parameters: Type.Object({}),




      async execute(_params, config) {
        // Step 1: create JWT for app-level authentication
        const privateKey = resolvePrivateKey(config);
        const appJwt = createJwt(config.appId, privateKey);

        // Step 2: use JWT to call the app installation endpoint
        const data = await getInstallationDetails(appJwt, config.installationId);

        // Step 3: also verify installation token exchange works
        let installTokenOk = false;
        let tokenErrorMessage = "";
        try {
          const installToken = await getInstallationToken(config);
          installTokenOk = typeof installToken === "string" && installToken.length > 0;
        } catch (err) {
          tokenErrorMessage = err instanceof Error ? err.message : String(err);
        }

        // Step 4: return a clean summary — this is what the agent will see
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

        // LLM Friendly Warning
        if (!installTokenOk) {
          result.warning = `CRITICAL: JWT was valid, but generating an Installation Access Token failed. 
          You CANNOT read or write repositories. Error details: ${tokenErrorMessage}`;
        }

        return result;
      },
    }),
  ],
});