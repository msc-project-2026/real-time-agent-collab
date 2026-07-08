package deploy

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"github.com/msc-project-2026/real-time-agent-collab/deploy-cli/internal/runner"
)

// BuildStrategy names how an image was produced, for reporting back to the agent.
type BuildStrategy string

const (
	StrategyDockerfile BuildStrategy = "dockerfile"
	StrategyNixpacks   BuildStrategy = "nixpacks"
)

// buildImage produces a runnable image tagged `image` from the checkout at dir.
// It prefers a repo-provided Dockerfile (respecting how the author wants it
// built) and otherwise falls back to nixpacks auto-detection, which handles
// requirements.txt / package.json / go.mod / etc. without language-specific
// logic here. If neither can build it, that is a real, surfaced failure.
func (e *Engine) buildImage(ctx context.Context, dir, image string, port int) (BuildStrategy, *runner.Result, error) {
	if hasDockerfile(dir) {
		res, err := e.docker.Build(ctx, dir, image)
		return StrategyDockerfile, res, err
	}
	// nixpacks build . --name <image>  — sets PORT so the app binds correctly.
	res, err := e.run.RunIn(ctx, dir, nil, "nixpacks", "build", ".",
		"--name", image,
		"--env", fmt.Sprintf("PORT=%d", port))
	if err != nil {
		return StrategyNixpacks, res, fmt.Errorf("no Dockerfile found and nixpacks could not build this repo: %w", err)
	}
	return StrategyNixpacks, res, nil
}

func hasDockerfile(dir string) bool {
	_, err := os.Stat(filepath.Join(dir, "Dockerfile"))
	return err == nil
}

// resolveEnvFile decides which env file to hand the container. Precedence:
//  1. explicit content supplied by the agent (written to the app's private
//     .env, permissioned to the deploy user only),
//  2. a .env already committed in the repo checkout,
//  3. none.
//
// It returns the absolute path to use, or "" when there is no env file.
func (e *Engine) resolveEnvFile(dir, appName, suppliedContent string) (string, error) {
	privatePath := filepath.Join(e.AppEnvDir, appName+".env")

	if suppliedContent != "" {
		if err := os.MkdirAll(e.AppEnvDir, 0o750); err != nil {
			return "", err
		}
		if err := os.WriteFile(privatePath, []byte(suppliedContent), 0o600); err != nil {
			return "", fmt.Errorf("write env file: %w", err)
		}
		return privatePath, nil
	}

	repoEnv := filepath.Join(dir, ".env")
	if _, err := os.Stat(repoEnv); err == nil {
		return repoEnv, nil
	}

	// A previously supplied env file for this app persists across redeploys.
	if _, err := os.Stat(privatePath); err == nil {
		return privatePath, nil
	}
	return "", nil
}
