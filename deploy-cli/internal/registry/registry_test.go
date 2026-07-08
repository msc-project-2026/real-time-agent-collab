package registry

import (
	"path/filepath"
	"testing"
)

func openTemp(t *testing.T) *DB {
	t.Helper()
	db, err := Open(filepath.Join(t.TempDir(), "registry.db"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

func TestUpsertGetDelete(t *testing.T) {
	db := openTemp(t)

	if _, err := db.Get("missing"); err != ErrNotFound {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}

	app := &App{
		Name:          "myapp",
		RepoURL:       "https://github.com/o/r",
		Domain:        "myapp.example.com",
		ContainerName: "app-myapp",
		Status:        StatusDeploying,
	}
	if err := db.Upsert(app); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	if app.CreatedAt == "" || app.UpdatedAt == "" {
		t.Fatal("timestamps not stamped")
	}

	got, err := db.Get("myapp")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.RepoURL != app.RepoURL || got.Status != StatusDeploying {
		t.Fatalf("mismatch: %+v", got)
	}

	// Update preserves created_at.
	created := got.CreatedAt
	got.Status = StatusRunning
	got.CreatedAt = ""
	if err := db.Upsert(got); err != nil {
		t.Fatalf("upsert update: %v", err)
	}
	after, _ := db.Get("myapp")
	if after.CreatedAt != created {
		t.Errorf("created_at changed on update: %q -> %q", created, after.CreatedAt)
	}
	if after.Status != StatusRunning {
		t.Errorf("status not updated: %q", after.Status)
	}

	exists, _ := db.Exists("myapp")
	if !exists {
		t.Error("expected exists")
	}

	if err := db.SetStatus("myapp", StatusFailed, "boom"); err != nil {
		t.Fatalf("setstatus: %v", err)
	}
	after, _ = db.Get("myapp")
	if after.Status != StatusFailed || after.LastError != "boom" {
		t.Errorf("setstatus not applied: %+v", after)
	}

	if err := db.Delete("myapp"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if err := db.Delete("myapp"); err != ErrNotFound {
		t.Errorf("second delete: expected ErrNotFound, got %v", err)
	}
}

func TestListOrdered(t *testing.T) {
	db := openTemp(t)
	for _, n := range []string{"charlie", "alpha", "bravo"} {
		if err := db.Upsert(&App{Name: n, RepoURL: "u", Domain: "d", ContainerName: "c", Status: StatusRunning}); err != nil {
			t.Fatal(err)
		}
	}
	apps, err := db.List()
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"alpha", "bravo", "charlie"}
	if len(apps) != len(want) {
		t.Fatalf("len = %d", len(apps))
	}
	for i, a := range apps {
		if a.Name != want[i] {
			t.Errorf("apps[%d] = %q, want %q", i, a.Name, want[i])
		}
	}
}
