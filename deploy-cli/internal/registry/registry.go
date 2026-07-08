// Package registry is the source of truth for deployed apps. At hundreds of
// apps a flat JSON file races on concurrent status updates, so this uses SQLite
// in WAL mode: one row per app, keyed by the (already validated) slug.
package registry

import (
	"database/sql"
	"errors"
	"fmt"
	"time"

	_ "modernc.org/sqlite"
)

// Status values an app row moves through.
const (
	StatusDeploying = "deploying"
	StatusRunning   = "running"
	StatusStopped   = "stopped"
	StatusFailed    = "failed"
)

// ErrNotFound is returned when an app slug has no row.
var ErrNotFound = errors.New("app not found")

// App is one deployed application.
type App struct {
	Name          string `json:"name"`
	RepoURL       string `json:"repo_url"`
	GitRef        string `json:"git_ref"`
	Domain        string `json:"domain"`
	ContainerName string `json:"container_name"`
	Image         string `json:"image"`
	Status        string `json:"status"`
	LastDeploySHA string `json:"last_deploy_sha"`
	LastError     string `json:"last_error"`
	CreatedAt     string `json:"created_at"`
	UpdatedAt     string `json:"updated_at"`
}

// DB wraps the SQLite handle.
type DB struct {
	sql *sql.DB
}

// Open opens (and migrates) the registry database at path.
func Open(path string) (*DB, error) {
	// _pragma busy_timeout avoids "database is locked" under concurrent writers;
	// journal_mode=WAL lets reads proceed during a write.
	dsn := fmt.Sprintf("file:%s?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(on)", path)
	sqlDB, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open registry: %w", err)
	}
	db := &DB{sql: sqlDB}
	if err := db.migrate(); err != nil {
		sqlDB.Close()
		return nil, err
	}
	return db, nil
}

// Close releases the database handle.
func (db *DB) Close() error { return db.sql.Close() }

func (db *DB) migrate() error {
	_, err := db.sql.Exec(`
		CREATE TABLE IF NOT EXISTS apps (
			name            TEXT PRIMARY KEY,
			repo_url        TEXT NOT NULL,
			git_ref         TEXT NOT NULL DEFAULT '',
			domain          TEXT NOT NULL,
			container_name  TEXT NOT NULL,
			image           TEXT NOT NULL DEFAULT '',
			status          TEXT NOT NULL,
			last_deploy_sha TEXT NOT NULL DEFAULT '',
			last_error      TEXT NOT NULL DEFAULT '',
			created_at      TEXT NOT NULL,
			updated_at      TEXT NOT NULL
		);
	`)
	if err != nil {
		return fmt.Errorf("migrate registry: %w", err)
	}
	return nil
}

func nowISO() string { return time.Now().UTC().Format(time.RFC3339) }

// Get returns the app row for name, or ErrNotFound.
func (db *DB) Get(name string) (*App, error) {
	row := db.sql.QueryRow(`
		SELECT name, repo_url, git_ref, domain, container_name, image,
		       status, last_deploy_sha, last_error, created_at, updated_at
		FROM apps WHERE name = ?`, name)
	var a App
	err := row.Scan(&a.Name, &a.RepoURL, &a.GitRef, &a.Domain, &a.ContainerName,
		&a.Image, &a.Status, &a.LastDeploySHA, &a.LastError, &a.CreatedAt, &a.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("get app %q: %w", name, err)
	}
	return &a, nil
}

// Exists reports whether an app slug is already taken.
func (db *DB) Exists(name string) (bool, error) {
	_, err := db.Get(name)
	if errors.Is(err, ErrNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// List returns all app rows ordered by name.
func (db *DB) List() ([]App, error) {
	rows, err := db.sql.Query(`
		SELECT name, repo_url, git_ref, domain, container_name, image,
		       status, last_deploy_sha, last_error, created_at, updated_at
		FROM apps ORDER BY name`)
	if err != nil {
		return nil, fmt.Errorf("list apps: %w", err)
	}
	defer rows.Close()

	var apps []App
	for rows.Next() {
		var a App
		if err := rows.Scan(&a.Name, &a.RepoURL, &a.GitRef, &a.Domain, &a.ContainerName,
			&a.Image, &a.Status, &a.LastDeploySHA, &a.LastError, &a.CreatedAt, &a.UpdatedAt); err != nil {
			return nil, fmt.Errorf("scan app: %w", err)
		}
		apps = append(apps, a)
	}
	return apps, rows.Err()
}

// Upsert creates or replaces an app row, stamping timestamps. CreatedAt is
// preserved on update.
func (db *DB) Upsert(a *App) error {
	now := nowISO()
	a.UpdatedAt = now
	if a.CreatedAt == "" {
		if existing, err := db.Get(a.Name); err == nil {
			a.CreatedAt = existing.CreatedAt
		} else {
			a.CreatedAt = now
		}
	}
	_, err := db.sql.Exec(`
		INSERT INTO apps (name, repo_url, git_ref, domain, container_name, image,
		                  status, last_deploy_sha, last_error, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(name) DO UPDATE SET
			repo_url        = excluded.repo_url,
			git_ref         = excluded.git_ref,
			domain          = excluded.domain,
			container_name  = excluded.container_name,
			image           = excluded.image,
			status          = excluded.status,
			last_deploy_sha = excluded.last_deploy_sha,
			last_error      = excluded.last_error,
			updated_at      = excluded.updated_at`,
		a.Name, a.RepoURL, a.GitRef, a.Domain, a.ContainerName, a.Image,
		a.Status, a.LastDeploySHA, a.LastError, a.CreatedAt, a.UpdatedAt)
	if err != nil {
		return fmt.Errorf("upsert app %q: %w", a.Name, err)
	}
	return nil
}

// SetStatus updates only the status (and last_error) of an app.
func (db *DB) SetStatus(name, status, lastErr string) error {
	res, err := db.sql.Exec(`
		UPDATE apps SET status = ?, last_error = ?, updated_at = ? WHERE name = ?`,
		status, lastErr, nowISO(), name)
	if err != nil {
		return fmt.Errorf("set status for %q: %w", name, err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// Delete removes an app row. Returns ErrNotFound if it did not exist.
func (db *DB) Delete(name string) error {
	res, err := db.sql.Exec(`DELETE FROM apps WHERE name = ?`, name)
	if err != nil {
		return fmt.Errorf("delete app %q: %w", name, err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}
