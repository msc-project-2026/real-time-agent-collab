## Description

This is a tool plugin implemented to connect OpenClaw with Github App

About Openclaw tool plugins:
https://docs.openclaw.ai/plugins/tool-plugins



## Folder structure

```
github-plugin/
├── src/
│   ├── index.ts                ← Plugin entry point
│   └── auth/
│       └── github-auth.js      ← GitHub authentication module
├── tsconfig.json               
└── package.json                 

```


## Installation


### Prerequisites

Before installing the plugin, make sure:

- Node.js and npm are installed.
- OpenClaw CLI is installed.
- Your GitHub App has been configured correctly.
- The required GitHub App credentials are available.



### 1. Install Dependencies

```
cd github-plugin
npm install
```

### 2. Compile the TypeScript Source

`npm run build`

### 3. Build the OpenClaw Plugin

`npm run plugin:build`

After a successful build, the `dist/` directory should look like:

```
dist/
├── index.js
├── index.d.ts
└── auth/
    └── github-auth.js 

```

### 4. Install the Plugin into OpenClaw


4.1 credential management

- Put github private key (.pem file) under the folder: `./openclaw/secrets/github-private-key.pem`


4.2 Update openclaw.json

1. plugins.allow
2. plugins.entries."github-plugin"
3. tools.alsoAllow

```

"plugins": {
    "allow": [
      "github-plugin"
    ],
    "entries": {
      "github-plugin": {
        "enabled": true,
        "config": {
          "appId": "xxxxx",
          "installationId": "xxxxx",
          "privateKeyFile": "path_to_github-private-key.pem"
        }
      },

"tools": {
  "profile": "coding",
  "alsoAllow": [
    "github_whoami",
    "github_list_repos",
    "github_get_repository",
    "github_list_branches",
    "github_get_file",
    "github_create_branch",
    "github_upsert_file",
    "github_open_pull_request",
    "github_list_tree",
    "github_list_issues",
    "github_get_issue",
    "github_create_issue",
    "github_update_issue",
    "github_list_issue_comments",
    "github_add_issue_comment"
  ]
},

```


4.2 Install the Plugin

```
cd ..

openclaw plugins install ./github-plugin
```

After installation, a new directory should appear under:
`.openclaw/extensions/github-plugin`




### 5. Restart the OpenClaw Gateway

`openclaw gateway restart`



### 6. Verify the Installation

`openclaw plugins inspect github-plugin --runtime`




## Plugin Usage

send a user prompt e.g.

`Use the github_whoami tool to verify the GitHub connection.`

For issue tools, configure the GitHub App with repository **Issues: read**
permission for listing and reading, or **Issues: read and write** permission
for creating, updating, and commenting. Existing installations may need to
approve the new permission.




## Uninstall：

```
openclaw plugins uninstall github-plugin

Uninstall plugin "github-auth"? [y/N]   y

openclaw gateway restart

```

