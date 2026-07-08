// Package deploy is the orchestration core: it turns a repo reference into a
// running, proxy-routed container and keeps the registry in sync. Every step is
// deterministic and shells out through the runner, so the agent driving it only
// ever chooses typed inputs — never free-form shell.
package deploy

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"strconv"
	"time"

	"github.com/msc-project-2026/real-time-agent-collab/deploy-cli/internal/audit"
	"github.com/msc-project-2026/real-time-agent-collab/deploy-cli/internal/dockerx"
	"github.com/msc-project-2026/real-time-agent-collab/deploy-cli/internal/naming"
	"github.com/msc-project-2026/real-time-agent-collab/deploy-cli/internal/registry"
	"github.com/msc-project-2026/real-time-agent-collab/deploy-cli/internal/runner"
	"github.com/msc-project-2026/real-time-agent-collab/deploy-cli/internal/system"
)

// Config holds host conventions the engine deploys against.
type Config struct {
	AppsDir       string // per-app checkouts live here, e.g. /opt/apps
	AppEnvDir     string // private env files, e.g. /opt/apps/.env-store
	DomainSuffix  string // e.g. 203-0-113-1.sslip.io
	Network       string // caddy-docker-proxy network name
	DefaultPort   int    // container port apps listen on (PORT env)
	DefaultMemMB  int    // per-app memory cap
	DefaultCPUs   string // per-app cpu cap, e.g. "0.5"
	RestartPolicy string // e.g. unless-stopped
	Thresholds    system.Thresholds
}

// Engine executes deploy operations.
type Engine struct {
	Config
	run    runner.Runner
	docker *dockerx.Client
	reg    *registry.DB
	audit  *audit.Logger
}

// New wires an Engine from its dependencies.
func New(cfg Config, r runner.Runner, reg *registry.DB, log *audit.Logger) *Engine {
	return &Engine{
		Config: cfg,
		run:    r,
		docker: dockerx.New(r),
		reg:    reg,
		audit:  log,
	}
}

// DeployRequest is a single deploy invocation.
type DeployRequest struct {
	Name        string // validated slug
	RepoURL     string
	Ref         string // branch or tag; empty = default branch
	EnvContent  string // optional env file content supplied by the agent
	Token       string // optional git auth token for private repos (never logged)
	RequestedBy string // for the audit trail
	Replace     bool   // true = redeploy of an existing app
}

// DeployResult is returned to the agent. On failure it carries build/run logs so
// the debugger tier has something to work with.
type DeployResult struct {
	App      registry.App  `json:"app"`
	URL      string        `json:"url"`
	Strategy BuildStrategy `json:"strategy"`
	Logs     string        `json:"logs,omitempty"`
}

// Deploy runs the full pipeline. A non-nil error means the deploy failed; the
// registry row is left in StatusFailed with the error recorded, and the returned
// result (if any) includes logs.
func (e *Engine) Deploy(ctx context.Context, req DeployRequest) (*DeployResult, error) {
	if err := naming.ValidateSlug(req.Name); err != nil {
		return nil, err
	}
	if req.RepoURL == "" {
		return nil, errors.New("repo URL is required")
	}

	exists, err := e.reg.Exists(req.Name)
	if err != nil {
		return nil, err
	}
	switch {
	case exists && !req.Replace:
		return nil, fmt.Errorf("app %q already exists; use redeploy to update it", req.Name)
	case !exists && req.Replace:
		return nil, fmt.Errorf("app %q does not exist; use deploy to create it", req.Name)
	}

	// Capacity guard for brand-new apps: refuse gracefully instead of degrading
	// the whole host. Redeploys reuse existing footprint, so they skip the check.
	if !req.Replace {
		if res, err := system.Read(e.AppsDir); err == nil {
			if over, reason := res.ExceedsThresholds(e.Thresholds); over {
				return nil, fmt.Errorf("host is out of capacity (%s); free space or remove an app before deploying", reason)
			}
		}
	}

	domain := naming.Domain(req.Name, e.DomainSuffix)
	container := naming.ContainerName(req.Name)
	appDir := filepath.Join(e.AppsDir, req.Name)

	app := &registry.App{
		Name:          req.Name,
		RepoURL:       req.RepoURL,
		GitRef:        req.Ref,
		Domain:        domain,
		ContainerName: container,
		Status:        registry.StatusDeploying,
	}
	if err := e.reg.Upsert(app); err != nil {
		return nil, err
	}

	result, deployErr := e.runPipeline(ctx, req, app, appDir, container, domain)
	e.audit.Log(audit.Entry{
		Action:      actionName(req.Replace),
		App:         req.Name,
		RequestedBy: req.RequestedBy,
		Result:      okFail(deployErr),
		Error:       errStr(deployErr),
		Params: map[string]any{
			"repo": req.RepoURL,
			"ref":  req.Ref,
		},
	})
	return result, deployErr
}

func (e *Engine) runPipeline(ctx context.Context, req DeployRequest, app *registry.App, appDir, container, domain string) (*DeployResult, error) {
	fail := func(err error, logs string) (*DeployResult, error) {
		_ = e.reg.SetStatus(req.Name, registry.StatusFailed, err.Error())
		return &DeployResult{App: *app, Logs: logs}, err
	}

	sha, err := e.syncRepo(ctx, appDir, req.RepoURL, req.Ref, req.Token)
	if err != nil {
		return fail(err, "")
	}
	app.LastDeploySHA = sha

	envFile, err := e.resolveEnvFile(appDir, req.Name, req.EnvContent)
	if err != nil {
		return fail(err, "")
	}

	image := naming.ContainerName(req.Name) + ":" + shortSHA(sha)
	strategy, buildRes, err := e.buildImage(ctx, appDir, image, e.DefaultPort)
	if err != nil {
		return fail(err, buildLogs(buildRes))
	}
	app.Image = image

	// Replace any previous container atomically enough for a single-host setup:
	// remove the old one, then launch the new image.
	e.docker.Remove(ctx, container)
	runRes, err := e.docker.Run(ctx, dockerx.RunOpts{
		Name:     container,
		Image:    image,
		Network:  e.Network,
		EnvFile:  envFile,
		Env:      map[string]string{"PORT": strconv.Itoa(e.DefaultPort)},
		MemoryMB: e.DefaultMemMB,
		CPUs:     e.DefaultCPUs,
		Restart:  e.RestartPolicy,
		Labels:   caddyLabels(container, domain, e.DefaultPort),
	})
	if err != nil {
		return fail(fmt.Errorf("container failed to start: %w", err), runResLogs(runRes))
	}

	if err := e.waitHealthy(ctx, container); err != nil {
		logs, _ := e.docker.Logs(ctx, container, 100)
		return fail(err, logs)
	}

	app.Status = registry.StatusRunning
	app.LastError = ""
	if err := e.reg.Upsert(app); err != nil {
		return nil, err
	}
	return &DeployResult{
		App:      *app,
		URL:      "https://" + domain,
		Strategy: strategy,
	}, nil
}

// waitHealthy confirms the container is running and not crash-looping in the
// first few seconds after launch.
func (e *Engine) waitHealthy(ctx context.Context, container string) error {
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		state, _ := e.docker.ContainerState(ctx, container)
		switch state {
		case "running":
			// Give it a brief settle window to catch immediate crash loops.
			time.Sleep(2 * time.Second)
			if s, _ := e.docker.ContainerState(ctx, container); s == "running" {
				return nil
			}
		case "exited", "dead", "":
			return fmt.Errorf("container exited immediately after start")
		}
		time.Sleep(1 * time.Second)
	}
	return fmt.Errorf("container did not become healthy within timeout")
}

// caddyLabels produces caddy-docker-proxy routing labels: host-based routing to
// the container's internal port. Because each app's hostname is declared here in
// a label, Caddy provisions a Let's Encrypt certificate for it automatically via
// HTTP-01 — no on-demand TLS needed.
func caddyLabels(container, domain string, port int) map[string]string {
	return map[string]string{
		"caddy":               domain,
		"caddy.reverse_proxy": "{{upstreams " + strconv.Itoa(port) + "}}",
	}
}

func actionName(replace bool) string {
	if replace {
		return "redeploy"
	}
	return "deploy"
}

func shortSHA(sha string) string {
	if len(sha) >= 8 {
		return sha[:8]
	}
	if sha == "" {
		return "latest"
	}
	return sha
}

func buildLogs(r *runner.Result) string {
	if r == nil {
		return ""
	}
	return r.Stdout + r.Stderr
}

func runResLogs(r *runner.Result) string {
	if r == nil {
		return ""
	}
	return r.Stdout + r.Stderr
}

func okFail(err error) string {
	if err != nil {
		return "fail"
	}
	return "ok"
}

func errStr(err error) string {
	if err != nil {
		return err.Error()
	}
	return ""
}
