package cli

import (
	"reflect"
	"testing"
)

func TestSplitShellWords(t *testing.T) {
	cases := []struct {
		in   string
		want []string
	}{
		{`deploy --name x --repo https://github.com/o/r`,
			[]string{"deploy", "--name", "x", "--repo", "https://github.com/o/r"}},
		{`status --name "my app"`,
			[]string{"status", "--name", "my app"}},
		{`deploy --ref 'feature/x y'`,
			[]string{"deploy", "--ref", "feature/x y"}},
		{`   list   `,
			[]string{"list"}},
		{`a\ b c`,
			[]string{"a b", "c"}},
	}
	for _, tc := range cases {
		got, err := splitShellWords(tc.in)
		if err != nil {
			t.Errorf("%q: unexpected error %v", tc.in, err)
			continue
		}
		if !reflect.DeepEqual(got, tc.want) {
			t.Errorf("%q => %#v, want %#v", tc.in, got, tc.want)
		}
	}

	if _, err := splitShellWords(`deploy --name "unterminated`); err == nil {
		t.Error("expected error for unterminated quote")
	}
}
