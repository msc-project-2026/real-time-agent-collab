package deploy

import (
	"context"
	"os"
	"path/filepath"

	"github.com/msc-project-2026/real-time-agent-collab/deploy-cli/internal/audit"
	"github.com/msc-project-2026/real-time-agent-collab/deploy-cli/internal/registry"
)

// Stop stops a running app's container and marks it stopped.
func (e *Engine) Stop(ctx context.Context, name, requestedBy string) (*registry.App, error) {
	app, err := e.reg.Get(name)
	if err != nil {
		return nil, err
	}
	err = e.docker.Stop(ctx, app.ContainerName)
	e.audit.Log(audit.Entry{Action: "stop", App: name, RequestedBy: requestedBy, Result: okFail(err), Error: errStr(err)})
	if err != nil {
		return nil, err
	}
	if err := e.reg.SetStatus(name, registry.StatusStopped, ""); err != nil {
		return nil, err
	}
	app.Status = registry.StatusStopped
	return app, nil
}

// Start restarts a previously stopped app's container.
func (e *Engine) Start(ctx context.Context, name, requestedBy string) (*registry.App, error) {
	app, err := e.reg.Get(name)
	if err != nil {
		return nil, err
	}
	err = e.docker.Start(ctx, app.ContainerName)
	e.audit.Log(audit.Entry{Action: "start", App: name, RequestedBy: requestedBy, Result: okFail(err), Error: errStr(err)})
	if err != nil {
		return nil, err
	}
	if err := e.reg.SetStatus(name, registry.StatusRunning, ""); err != nil {
		return nil, err
	}
	app.Status = registry.StatusRunning
	return app, nil
}

// Remove tears an app down completely: container, checkout, private env file,
// and registry row. It is idempotent across the pieces so a partial prior
// failure still cleans up.
func (e *Engine) Remove(ctx context.Context, name, requestedBy string) error {
	app, err := e.reg.Get(name)
	if err != nil {
		return err
	}
	e.docker.Remove(ctx, app.ContainerName)
	_ = os.RemoveAll(filepath.Join(e.AppsDir, name))
	_ = os.Remove(filepath.Join(e.AppEnvDir, name+".env"))
	err = e.reg.Delete(name)
	e.audit.Log(audit.Entry{Action: "remove", App: name, RequestedBy: requestedBy, Result: okFail(err), Error: errStr(err)})
	return err
}

// Logs returns the last tail lines of an app's container logs.
func (e *Engine) Logs(ctx context.Context, name string, tail int) (string, error) {
	app, err := e.reg.Get(name)
	if err != nil {
		return "", err
	}
	return e.docker.Logs(ctx, app.ContainerName, tail)
}

// Status returns the registry row plus the live container state, which can drift
// from the recorded status if a container crashed or was stopped out-of-band.
func (e *Engine) Status(ctx context.Context, name string) (*registry.App, string, error) {
	app, err := e.reg.Get(name)
	if err != nil {
		return nil, "", err
	}
	state, _ := e.docker.ContainerState(ctx, app.ContainerName)
	if state == "" {
		state = "absent"
	}
	return app, state, nil
}

// List returns all registered apps.
func (e *Engine) List() ([]registry.App, error) {
	return e.reg.List()
}

// URL returns the public URL for an app.
func (e *Engine) URL(name string) (string, error) {
	app, err := e.reg.Get(name)
	if err != nil {
		return "", err
	}
	return "https://" + app.Domain, nil
}
