package cli

import (
	"fmt"
	"strings"
)

// splitShellWords tokenizes a command string the way a POSIX shell would split a
// simple command: whitespace-separated words, with single quotes, double quotes,
// and backslash escaping. It performs NO expansion (no globbing, no variable or
// command substitution), so a value coming from SSH_ORIGINAL_COMMAND cannot be
// turned into anything executable — it is only ever split into argv tokens that
// deploy-cli's own flag parser interprets.
func splitShellWords(input string) ([]string, error) {
	var words []string
	var cur strings.Builder
	inWord := false

	const (
		none = iota
		single
		double
	)
	quote := none

	runes := []rune(input)
	for i := 0; i < len(runes); i++ {
		c := runes[i]
		switch quote {
		case single:
			if c == '\'' {
				quote = none
			} else {
				cur.WriteRune(c)
			}
			inWord = true
		case double:
			if c == '"' {
				quote = none
			} else if c == '\\' && i+1 < len(runes) {
				next := runes[i+1]
				// In double quotes a backslash only escapes these.
				if next == '"' || next == '\\' || next == '$' || next == '`' {
					cur.WriteRune(next)
					i++
				} else {
					cur.WriteRune(c)
				}
			} else {
				cur.WriteRune(c)
			}
			inWord = true
		default: // none
			switch {
			case c == '\'':
				quote = single
				inWord = true
			case c == '"':
				quote = double
				inWord = true
			case c == '\\':
				if i+1 < len(runes) {
					cur.WriteRune(runes[i+1])
					i++
				}
				inWord = true
			case c == ' ' || c == '\t' || c == '\n' || c == '\r':
				if inWord {
					words = append(words, cur.String())
					cur.Reset()
					inWord = false
				}
			default:
				cur.WriteRune(c)
				inWord = true
			}
		}
	}
	if quote != none {
		return nil, fmt.Errorf("unterminated quote in command")
	}
	if inWord {
		words = append(words, cur.String())
	}
	return words, nil
}
