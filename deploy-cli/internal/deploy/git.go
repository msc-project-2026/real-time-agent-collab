package deploy

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// authedURL injects a GitHub App / PAT token into an https clone URL so private
// repos can be fetched. The token is only ever placed on the argv for the git
// process; it is never stored in the registry or returned to callers, so it
// must not be logged by anything that captures these args.
func authedURL(repoURL, token string) string {
	if token == "" {
		return repoURL
	}
	if strings.HasPrefix(repoURL, "https://") {
		return "https://x-access-token:" + token + "@" + strings.TrimPrefix(repoURL, "https://")
	}
	return repoURL
}

// syncRepo clones repoURL into dir at ref, or fetches and hard-resets an
// existing checkout to ref. It returns the resolved commit SHA.
func (e *Engine) syncRepo(ctx context.Context, dir, repoURL, ref, token string) (string, error) {
	url := authedURL(repoURL, token)

	gitDir := filepath.Join(dir, ".git")
	if _, err := os.Stat(gitDir); err == nil {
		// Existing checkout: fetch then hard-reset to the requested ref.
		if _, err := e.run.RunIn(ctx, dir, nil, "git", "remote", "set-url", "origin", url); err != nil {
			return "", err
		}
		if _, err := e.run.RunIn(ctx, dir, nil, "git", "fetch", "--depth", "1", "origin", refOrHead(ref)); err != nil {
			return "", fmt.Errorf("git fetch failed: %w", err)
		}
		if _, err := e.run.RunIn(ctx, dir, nil, "git", "reset", "--hard", "FETCH_HEAD"); err != nil {
			return "", err
		}
	} else {
		if err := os.MkdirAll(dir, 0o750); err != nil {
			return "", err
		}
		args := []string{"clone", "--depth", "1"}
		if ref != "" {
			args = append(args, "--branch", ref)
		}
		args = append(args, url, dir)
		if _, err := e.run.Run(ctx, "git", args...); err != nil {
			return "", fmt.Errorf("git clone failed: %w", err)
		}
	}

	// Scrub the token back out of the stored remote so it never lingers on disk.
	_, _ = e.run.RunIn(ctx, dir, nil, "git", "remote", "set-url", "origin", repoURL)

	return e.headSHA(ctx, dir)
}

func (e *Engine) headSHA(ctx context.Context, dir string) (string, error) {
	res, err := e.run.RunIn(ctx, dir, nil, "git", "rev-parse", "HEAD")
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(res.Stdout), nil
}

func refOrHead(ref string) string {
	if ref == "" {
		return "HEAD"
	}
	return ref
}
