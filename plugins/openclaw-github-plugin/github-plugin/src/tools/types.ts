export type GithubPluginConfig = {
  appId: string;
  privateKey?: string;
  privateKeyFile?: string;
  installationId: string;
};

export type ToolFactory = (definition: any) => any;
