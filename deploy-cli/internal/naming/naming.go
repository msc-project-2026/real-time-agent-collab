// Package naming validates app slugs and derives the values that flow from
// them. A slug is used in three security-sensitive positions at once — as a
// DNS subdomain label, a filesystem directory under /opt/apps, and a Docker
// container name / Caddy route label — so it must be locked down before it
// ever reaches a shell, a path join, or a proxy label.
package naming

import (
	"fmt"
	"regexp"
	"strings"
)

// slugPattern is intentionally strict: lowercase letters, digits, and single
// internal hyphens only. It must start and end with an alphanumeric so it is a
// valid DNS label and never resolves to a path traversal or a hidden file.
var slugPattern = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`)

// reserved names would collide with infrastructure containers or routes.
var reserved = map[string]bool{
	"caddy":     true,
	"deploy":    true,
	"registry":  true,
	"localhost": true,
	"www":       true,
}

// ValidateSlug returns an error if name is not a safe app slug. DNS labels are
// capped at 63 characters; the pattern already enforces that upper bound.
func ValidateSlug(name string) error {
	if name == "" {
		return fmt.Errorf("app name is required")
	}
	if len(name) > 63 {
		return fmt.Errorf("app name %q is too long (max 63 characters)", name)
	}
	if !slugPattern.MatchString(name) {
		return fmt.Errorf("app name %q is invalid: use lowercase letters, digits, and single hyphens (must start and end alphanumeric)", name)
	}
	if strings.Contains(name, "--") {
		return fmt.Errorf("app name %q is invalid: double hyphens are not allowed", name)
	}
	if reserved[name] {
		return fmt.Errorf("app name %q is reserved", name)
	}
	return nil
}

// Domain builds the public hostname for an app. suffix is the sslip.io (or real
// domain) base, e.g. "203-0-113-1.sslip.io" or "apps.example.com". The caller is
// responsible for having validated name first.
func Domain(name, suffix string) string {
	return name + "." + strings.TrimPrefix(suffix, ".")
}

// ContainerName is the Docker container name for an app. Prefixed so the
// deploy-managed containers are easy to distinguish from infrastructure ones.
func ContainerName(name string) string {
	return "app-" + name
}
