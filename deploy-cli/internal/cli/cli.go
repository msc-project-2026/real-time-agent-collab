// Package cli wires the deploy engine to a small stdlib-flag command surface.
// Every command prints a single JSON object to stdout — success or failure — so
// the agent driving the CLI over SSH parses one deterministic shape and never
// scrapes human text.
package cli

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"strconv"

	"github.com/msc-project-2026/real-time-agent-collab/deploy-cli/internal/audit"
	"github.com/msc-project-2026/real-time-agent-collab/deploy-cli/internal/deploy"
	"github.com/msc-project-2026/real-time-agent-collab/deploy-cli/internal/registry"
	"github.com/msc-project-2026/real-time-agent-collab/deploy-cli/internal/runner"
	"github.com/msc-project-2026/real-time-agent-collab/deploy-cli/internal/system"
)

// Run is the CLI entrypoint. It returns a process exit code.
func Run(args []string) int {
	// Forced-command mode: when invoked over SSH with a restricted key
	// (command="deploy-cli" in authorized_keys), sshd runs us with no args and
	// puts the client's requested command in SSH_ORIGINAL_COMMAND. We tokenize it
	// ourselves — without any shell — so the key can never open a shell.
	if len(args) == 0 {
		if orig := os.Getenv("SSH_ORIGINAL_COMMAND"); orig != "" {
			parsed, err := splitShellWords(orig)
			if err != nil {
				emitErr(err)
				return 2
			}
			args = parsed
		}
	}
	if len(args) < 1 {
		emitErr(fmt.Errorf("usage: deploy-cli <command> [flags]"))
		return 2
	}

	cfg, err := loadConfig()
	if err != nil {
		emitErr(err)
		return 1
	}

	reg, err := registry.Open(cfg.registryDB)
	if err != nil {
		emitErr(err)
		return 1
	}
	defer reg.Close()

	eng := deploy.New(cfg.engine, runner.Exec{}, reg, audit.New(cfg.auditLog))
	ctx := context.Background()

	cmd, rest := args[0], args[1:]
	switch cmd {
	case "deploy":
		return cmdDeploy(ctx, eng, rest, false)
	case "redeploy":
		return cmdDeploy(ctx, eng, rest, true)
	case "list":
		return cmdList(eng)
	case "status":
		return cmdStatus(ctx, eng, rest)
	case "stop":
		return cmdLifecycle(ctx, eng, rest, "stop")
	case "start":
		return cmdLifecycle(ctx, eng, rest, "start")
	case "remove":
		return cmdRemove(ctx, eng, rest)
	case "url":
		return cmdURL(eng, rest)
	case "logs":
		return cmdLogs(ctx, eng, rest)
	case "ports":
		return cmdPorts()
	case "resources":
		return cmdResources(cfg.engine.AppsDir, cfg.engine.Thresholds)
	case "health":
		return cmdHealth(ctx, reg)
	default:
		emitErr(fmt.Errorf("unknown command %q", cmd))
		return 2
	}
}

func cmdDeploy(ctx context.Context, eng *deploy.Engine, args []string, replace bool) int {
	fs := flag.NewFlagSet("deploy", flag.ContinueOnError)
	name := fs.String("name", "", "app slug (subdomain + container name)")
	repo := fs.String("repo", "", "git repository URL")
	ref := fs.String("ref", "", "branch or tag (default: repo default branch)")
	envFile := fs.String("env-file", "", "path to an env file to inject (use - for stdin)")
	token := fs.String("token", "", "git auth token for private repos (never logged)")
	by := fs.String("by", "", "requester identity for the audit log")
	if err := fs.Parse(args); err != nil {
		emitErr(err)
		return 2
	}

	envContent, err := readEnvContent(*envFile)
	if err != nil {
		emitErr(err)
		return 1
	}

	res, err := eng.Deploy(ctx, deploy.DeployRequest{
		Name:        *name,
		RepoURL:     *repo,
		Ref:         *ref,
		EnvContent:  envContent,
		Token:       *token,
		RequestedBy: *by,
		Replace:     replace,
	})
	if err != nil {
		// A deploy failure still returns a result payload (logs) for the debugger
		// tier, alongside the error.
		emit(map[string]any{"ok": false, "error": err.Error(), "result": res})
		return 1
	}
	emit(map[string]any{"ok": true, "result": res})
	return 0
}

func cmdList(eng *deploy.Engine) int {
	apps, err := eng.List()
	if err != nil {
		emitErr(err)
		return 1
	}
	if apps == nil {
		apps = []registry.App{}
	}
	emit(map[string]any{"ok": true, "apps": apps})
	return 0
}

func cmdStatus(ctx context.Context, eng *deploy.Engine, args []string) int {
	fs := flag.NewFlagSet("status", flag.ContinueOnError)
	name := fs.String("name", "", "app slug")
	if err := fs.Parse(args); err != nil {
		emitErr(err)
		return 2
	}
	app, state, err := eng.Status(ctx, *name)
	if err != nil {
		emitErr(err)
		return 1
	}
	emit(map[string]any{"ok": true, "app": app, "container_state": state})
	return 0
}

func cmdLifecycle(ctx context.Context, eng *deploy.Engine, args []string, action string) int {
	fs := flag.NewFlagSet(action, flag.ContinueOnError)
	name := fs.String("name", "", "app slug")
	by := fs.String("by", "", "requester identity for the audit log")
	if err := fs.Parse(args); err != nil {
		emitErr(err)
		return 2
	}
	var app *registry.App
	var err error
	if action == "stop" {
		app, err = eng.Stop(ctx, *name, *by)
	} else {
		app, err = eng.Start(ctx, *name, *by)
	}
	if err != nil {
		emitErr(err)
		return 1
	}
	emit(map[string]any{"ok": true, "app": app})
	return 0
}

func cmdRemove(ctx context.Context, eng *deploy.Engine, args []string) int {
	fs := flag.NewFlagSet("remove", flag.ContinueOnError)
	name := fs.String("name", "", "app slug")
	by := fs.String("by", "", "requester identity for the audit log")
	if err := fs.Parse(args); err != nil {
		emitErr(err)
		return 2
	}
	if err := eng.Remove(ctx, *name, *by); err != nil {
		emitErr(err)
		return 1
	}
	emit(map[string]any{"ok": true, "removed": *name})
	return 0
}

func cmdURL(eng *deploy.Engine, args []string) int {
	fs := flag.NewFlagSet("url", flag.ContinueOnError)
	name := fs.String("name", "", "app slug")
	if err := fs.Parse(args); err != nil {
		emitErr(err)
		return 2
	}
	url, err := eng.URL(*name)
	if err != nil {
		emitErr(err)
		return 1
	}
	emit(map[string]any{"ok": true, "name": *name, "url": url})
	return 0
}

func cmdLogs(ctx context.Context, eng *deploy.Engine, args []string) int {
	fs := flag.NewFlagSet("logs", flag.ContinueOnError)
	name := fs.String("name", "", "app slug")
	tail := fs.Int("tail", 200, "number of trailing log lines")
	if err := fs.Parse(args); err != nil {
		emitErr(err)
		return 2
	}
	logs, err := eng.Logs(ctx, *name, *tail)
	if err != nil {
		emit(map[string]any{"ok": false, "error": err.Error(), "logs": logs})
		return 1
	}
	emit(map[string]any{"ok": true, "name": *name, "logs": logs})
	return 0
}

func cmdPorts() int {
	port, err := system.FreePort()
	if err != nil {
		emitErr(err)
		return 1
	}
	emit(map[string]any{"ok": true, "free_port": port})
	return 0
}

func cmdResources(appsDir string, t system.Thresholds) int {
	res, err := system.Read(appsDir)
	if err != nil {
		emitErr(err)
		return 1
	}
	over, reason := res.ExceedsThresholds(t)
	emit(map[string]any{"ok": true, "resources": res, "over_capacity": over, "reason": reason})
	return 0
}

func cmdHealth(ctx context.Context, reg *registry.DB) int {
	// Registry opened successfully in Run; confirm docker is reachable.
	res, err := runner.Exec{}.Run(ctx, "docker", "version", "-f", "{{.Server.Version}}")
	if err != nil {
		emit(map[string]any{"ok": false, "error": "docker unavailable: " + err.Error()})
		return 1
	}
	_, _ = reg.List()
	emit(map[string]any{"ok": true, "docker_version": trim(res.Stdout)})
	return 0
}

// readEnvContent resolves the --env-file flag into content: "" means none, "-"
// reads stdin, otherwise it reads the named file.
func readEnvContent(path string) (string, error) {
	switch path {
	case "":
		return "", nil
	case "-":
		data, err := io.ReadAll(os.Stdin)
		return string(data), err
	default:
		data, err := os.ReadFile(path)
		if err != nil {
			return "", fmt.Errorf("read env file: %w", err)
		}
		return string(data), nil
	}
}

func emit(v any) {
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	_ = enc.Encode(v)
}

func emitErr(err error) {
	emit(map[string]any{"ok": false, "error": err.Error()})
}

func trim(s string) string {
	for len(s) > 0 && (s[len(s)-1] == '\n' || s[len(s)-1] == '\r' || s[len(s)-1] == ' ') {
		s = s[:len(s)-1]
	}
	return s
}

// config holds resolved runtime configuration.
type config struct {
	engine     deploy.Config
	registryDB string
	auditLog   string
}

func loadConfig() (config, error) {
	appsDir := envOr("DEPLOY_APPS_DIR", "/opt/apps")
	c := config{
		registryDB: envOr("DEPLOY_REGISTRY_DB", "/opt/apps/.registry/registry.db"),
		auditLog:   envOr("DEPLOY_AUDIT_LOG", "/opt/apps/.registry/deploy-audit.jsonl"),
		engine: deploy.Config{
			AppsDir:       appsDir,
			AppEnvDir:     envOr("DEPLOY_ENV_DIR", "/opt/apps/.env-store"),
			DomainSuffix:  os.Getenv("DEPLOY_DOMAIN_SUFFIX"),
			Network:       envOr("DEPLOY_NETWORK", "caddy"),
			DefaultPort:   envInt("DEPLOY_PORT", 3000),
			DefaultMemMB:  envInt("DEPLOY_MEM_MB", 512),
			DefaultCPUs:   envOr("DEPLOY_CPUS", "0.5"),
			RestartPolicy: envOr("DEPLOY_RESTART", "unless-stopped"),
			Thresholds: system.Thresholds{
				MaxMemPct:  envFloat("DEPLOY_MAX_MEM_PCT", system.DefaultThresholds.MaxMemPct),
				MaxDiskPct: envFloat("DEPLOY_MAX_DISK_PCT", system.DefaultThresholds.MaxDiskPct),
			},
		},
	}
	if c.engine.DomainSuffix == "" {
		return c, fmt.Errorf("DEPLOY_DOMAIN_SUFFIX is required (e.g. 203-0-113-1.sslip.io)")
	}
	return c, nil
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func envFloat(key string, def float64) float64 {
	if v := os.Getenv(key); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil {
			return f
		}
	}
	return def
}
