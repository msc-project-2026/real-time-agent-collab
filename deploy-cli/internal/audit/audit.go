// Package audit records one JSON line per deploy action to an append-only file,
// mirroring the gate-audit convention used elsewhere in this repo. It gives an
// action trail independent of docker logs, and — like the original — logging
// must never block or fail the operation it is recording.
package audit

import (
	"encoding/json"
	"os"
	"path/filepath"
	"time"
)

// Logger appends audit entries to a JSONL file.
type Logger struct {
	path string
}

// New returns a Logger writing to path. The directory is created if needed.
func New(path string) *Logger {
	if path != "" {
		_ = os.MkdirAll(filepath.Dir(path), 0o750)
	}
	return &Logger{path: path}
}

// Entry is one audit record. Fields are kept flat for easy grepping.
type Entry struct {
	TS          string         `json:"ts"`
	Action      string         `json:"action"`
	App         string         `json:"app,omitempty"`
	RequestedBy string         `json:"requested_by,omitempty"`
	Result      string         `json:"result"`
	Error       string         `json:"error,omitempty"`
	Params      map[string]any `json:"params,omitempty"`
}

// Log writes one entry. Errors are swallowed: an audit failure must not break
// the caller.
func (l *Logger) Log(e Entry) {
	if l == nil || l.path == "" {
		return
	}
	e.TS = time.Now().UTC().Format(time.RFC3339)
	line, err := json.Marshal(e)
	if err != nil {
		return
	}
	f, err := os.OpenFile(l.path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o640)
	if err != nil {
		return
	}
	defer f.Close()
	_, _ = f.Write(append(line, '\n'))
}
