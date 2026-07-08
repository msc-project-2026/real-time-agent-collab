// Package dockerx wraps the docker CLI operations the deploy engine needs.
// Everything runs through the shared runner so arguments are passed as argv and
// never through a shell.
package dockerx

import (
	"context"
	"strconv"
	"strings"

	"github.com/msc-project-2026/real-time-agent-collab/deploy-cli/internal/runner"
)

// Client issues docker commands.
type Client struct {
	run runner.Runner
}

// New returns a Client backed by r.
func New(r runner.Runner) *Client { return &Client{run: r} }

// ContainerState reports the running state of a container. Empty state means the
// container does not exist.
func (c *Client) ContainerState(ctx context.Context, name string) (string, error) {
	res, err := c.run.Run(ctx, "docker", "inspect", "-f", "{{.State.Status}}", name)
	if err != nil {
		// docker inspect exits non-zero when the container is absent.
		return "", nil
	}
	return strings.TrimSpace(res.Stdout), nil
}

// Stop stops a running container. A missing container is not an error.
func (c *Client) Stop(ctx context.Context, name string) error {
	_, err := c.run.Run(ctx, "docker", "stop", name)
	return err
}

// Start starts an existing stopped container.
func (c *Client) Start(ctx context.Context, name string) error {
	_, err := c.run.Run(ctx, "docker", "start", name)
	return err
}

// Remove force-removes a container. A missing container is not an error.
func (c *Client) Remove(ctx context.Context, name string) {
	_, _ = c.run.Run(ctx, "docker", "rm", "-f", name)
}

// Logs returns the last tail lines of a container's logs (stdout+stderr).
func (c *Client) Logs(ctx context.Context, name string, tail int) (string, error) {
	tailArg := "all"
	if tail > 0 {
		tailArg = strconv.Itoa(tail)
	}
	res, err := c.run.Run(ctx, "docker", "logs", "--tail", tailArg, name)
	if err != nil {
		return res.Stdout + res.Stderr, err
	}
	// docker logs writes app stderr to our stderr buffer; include both.
	return res.Stdout + res.Stderr, nil
}

// Build builds an image from contextDir using an in-repo Dockerfile.
func (c *Client) Build(ctx context.Context, contextDir, tag string) (*runner.Result, error) {
	return c.run.Run(ctx, "docker", "build", "-t", tag, contextDir)
}

// RunOpts configures a detached container launch.
type RunOpts struct {
	Name     string
	Image    string
	Network  string            // caddy-docker-proxy network to join
	EnvFile  string            // absolute path, optional
	Env      map[string]string // additional inline env (e.g. PORT)
	MemoryMB int               // hard memory cap
	CPUs     string            // e.g. "0.5"
	Labels   map[string]string // caddy-docker-proxy routing labels
	Restart  string            // e.g. "unless-stopped"
}

// Run launches a detached container with resource limits and routing labels. No
// host ports are published; the reverse proxy reaches the container over the
// shared network.
func (c *Client) Run(ctx context.Context, o RunOpts) (*runner.Result, error) {
	args := []string{"run", "-d", "--name", o.Name}
	if o.Restart != "" {
		args = append(args, "--restart", o.Restart)
	}
	if o.Network != "" {
		args = append(args, "--network", o.Network)
	}
	if o.MemoryMB > 0 {
		args = append(args, "--memory", strconv.Itoa(o.MemoryMB)+"m")
	}
	if o.CPUs != "" {
		args = append(args, "--cpus", o.CPUs)
	}
	if o.EnvFile != "" {
		args = append(args, "--env-file", o.EnvFile)
	}
	for k, v := range o.Env {
		args = append(args, "-e", k+"="+v)
	}
	for k, v := range o.Labels {
		args = append(args, "--label", k+"="+v)
	}
	args = append(args, o.Image)
	return c.run.Run(ctx, "docker", args...)
}
