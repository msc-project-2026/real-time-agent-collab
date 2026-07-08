// Package runner is the single choke point for shelling out to git, docker, and
// nixpacks. Every external command goes through Run, which takes an explicit
// argv slice — never a shell string — so untrusted values (repo URLs, refs)
// cannot be interpreted by a shell.
package runner

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

// Result captures the outcome of a command.
type Result struct {
	Stdout   string
	Stderr   string
	ExitCode int
}

// Runner executes external commands. It is an interface so the deploy engine can
// be unit-tested with a fake.
type Runner interface {
	Run(ctx context.Context, name string, args ...string) (*Result, error)
	RunIn(ctx context.Context, dir string, env []string, name string, args ...string) (*Result, error)
}

// Exec is the real implementation backed by os/exec.
type Exec struct{}

// Run executes name with args and returns the captured result. A non-zero exit
// returns a non-nil error whose message includes trimmed stderr.
func (Exec) Run(ctx context.Context, name string, args ...string) (*Result, error) {
	return Exec{}.RunIn(ctx, "", nil, name, args...)
}

// RunIn is Run with a working directory and extra environment entries
// ("KEY=VALUE"). A nil env inherits the parent environment.
func (Exec) RunIn(ctx context.Context, dir string, env []string, name string, args ...string) (*Result, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	if dir != "" {
		cmd.Dir = dir
	}
	if env != nil {
		cmd.Env = env
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err := cmd.Run()
	res := &Result{
		Stdout: stdout.String(),
		Stderr: stderr.String(),
	}
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			res.ExitCode = exitErr.ExitCode()
			return res, fmt.Errorf("%s exited %d: %s", name, res.ExitCode, strings.TrimSpace(stderr.String()))
		}
		return res, fmt.Errorf("run %s: %w", name, err)
	}
	return res, nil
}

// WithTimeout returns a context that cancels after d, plus its cancel func.
func WithTimeout(parent context.Context, d time.Duration) (context.Context, context.CancelFunc) {
	return context.WithTimeout(parent, d)
}
