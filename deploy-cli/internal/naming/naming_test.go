package naming

import "testing"

func TestValidateSlug(t *testing.T) {
	valid := []string{"app", "my-app", "app1", "a", "web-app-test", "x1y2z3"}
	for _, s := range valid {
		if err := ValidateSlug(s); err != nil {
			t.Errorf("expected %q valid, got %v", s, err)
		}
	}

	invalid := []string{
		"",         // empty
		"-app",     // leading hyphen
		"app-",     // trailing hyphen
		"App",      // uppercase
		"my--app",  // double hyphen
		"my_app",   // underscore
		"app.name", // dot (path/label traversal risk)
		"../etc",   // traversal
		"caddy",    // reserved
		"deploy",   // reserved
		"a/b",      // slash
		" app",     // space
	}
	for _, s := range invalid {
		if err := ValidateSlug(s); err == nil {
			t.Errorf("expected %q invalid, got nil", s)
		}
	}
}

func TestDomain(t *testing.T) {
	got := Domain("myapp", "203-0-113-1.sslip.io")
	want := "myapp.203-0-113-1.sslip.io"
	if got != want {
		t.Errorf("Domain = %q, want %q", got, want)
	}
	// A leading dot on the suffix should be tolerated.
	if got := Domain("a", ".apps.example.com"); got != "a.apps.example.com" {
		t.Errorf("Domain leading-dot = %q", got)
	}
}

func TestContainerName(t *testing.T) {
	if got := ContainerName("myapp"); got != "app-myapp" {
		t.Errorf("ContainerName = %q", got)
	}
}
