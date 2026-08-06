# GitHub Issue Integration Test

For the OpenClaw Agent end-to-end test, see
[`e2e-instruction.md`](./e2e-instruction.md).

This test uses a real GitHub App to create, read, list, update, comment on,
and close an issue in a real repository.

## 1. Prepare a test repository

Create or choose a repository used only for testing. Make sure **Issues** is
enabled. Do not run this test against a production repository.

## 2. Configure the GitHub App

In the GitHub App settings:

1. Open **Permissions & events**.
2. Set **Repository permissions → Issues** to **Read and write**.
3. Install the App on the test repository.
4. If permissions were changed after installation, approve the updated
   permissions.

Record the following values:

- GitHub App ID
- Installation ID
- Test repository owner
- Test repository name
- Path to the App private key (`.pem`)

Keep the private key outside the repository and never commit it.

## 3. Open PowerShell

Change to the plugin directory:

```powershell
cd path-to-repo\github-plugin
```

Replace `path-to-repo` with the location where you cloned this repository.

## 4. Set the environment variables

Replace the example values:

```powershell
$env:RUN_GITHUB_INTEGRATION = "1"
$env:GITHUB_TEST_OWNER = "your-account-or-organization"
$env:GITHUB_TEST_REPO = "your-test-repository"
$env:GITHUB_APP_ID = "your-app-id"
$env:GITHUB_INSTALLATION_ID = "your-installation-id"
$env:GITHUB_PRIVATE_KEY_FILE = "path-to-private-key\github-private-key.pem"
```

`RUN_GITHUB_INTEGRATION` is a safety switch. The test runs only when its value
is exactly `"1"`; if it is unset or has any other value, the integration test
is skipped. These variables only apply to the current PowerShell session.

## 5. Add the npm script

Ensure `github-plugin/package.json` contains this entry inside `scripts`:

```json
{
  "scripts": {
    "test:integration": "vitest run tests/issues.integration.test.ts"
  }
}
```

Keep the existing scripts and add a comma between script entries when needed.
If `test:integration` is already present, no change is required.

## 6. Run the integration test

```powershell
npm.cmd run test:integration
```

A successful run should report:

```text
Test Files  1 passed
Tests       1 passed
```

## 7. Check the result on GitHub

The test repository should contain a closed issue with a title beginning with:

```text
[openclaw-integration-updated]
```

The issue should contain one integration-test comment. The test closes issues;
it does not delete them. If the test fails after creating an issue, it will
still attempt to close that issue.

## Troubleshooting

- `401`: Check the App ID and private key.
- `403`: Confirm the App has **Issues: Read and write** and the permission
  update has been approved.
- `404`: Confirm the owner, repository, installation ID, and that the App is
  installed on the test repository.
- `410`: Confirm Issues is enabled for the repository.
- `422`: Check repository configuration and the GitHub validation message.

Without `RUN_GITHUB_INTEGRATION=1`, the integration test is safely skipped.
