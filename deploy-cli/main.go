// Command deploy-cli is the deterministic deployment control surface that runs
// on the target VPS. The agent invokes its typed subcommands over SSH; it clones
// or updates a repo, builds it (Dockerfile or nixpacks), runs it behind the
// Caddy reverse proxy, and tracks every app in a local SQLite registry.
package main

import (
	"os"

	"github.com/msc-project-2026/real-time-agent-collab/deploy-cli/internal/cli"
)

func main() {
	os.Exit(cli.Run(os.Args[1:]))
}
