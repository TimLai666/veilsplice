package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestCheckIsOfflineAndValidatesSchema(t *testing.T) {
	var out, stderr bytes.Buffer
	code := run([]string{"-check"}, strings.NewReader(`{"operation":"prices_authenticated","stock_id":"2330","start_date":"2026-09-01","end_date":"2026-09-30"}`), &out, &stderr)
	if code != 0 || out.String() != "{\"request_valid\":true}\n" || stderr.Len() != 0 {
		t.Fatal("valid offline check failed")
	}
	out.Reset()
	stderr.Reset()
	code = run([]string{"-check"}, strings.NewReader(`{"operation":"prices_authenticated","stock_id":"2330","start_date":"2026-09-01","end_date":"2026-10-31"}`), &out, &stderr)
	if code != 1 || out.Len() != 0 || stderr.String() != "{\"error\":\"invalid_input\"}\n" {
		t.Fatal("check did not enforce date cap")
	}
}
func TestPolicySecretAndFileArgumentsForbidden(t *testing.T) {
	for _, args := range [][]string{{"-policy", "attacker.json"}, {"-request", "secret.txt"}, {"-token", "FAKE_SENTINEL"}, {"-secret", "OTHER_ALIAS"}, {"-url", "https://attacker.example"}, {"unexpected"}} {
		var out, stderr bytes.Buffer
		if run(args, strings.NewReader(`{"operation":"usage_authenticated"}`), &out, &stderr) != 1 || out.Len() != 0 || stderr.String() != "{\"error\":\"invalid_input\"}\n" {
			t.Fatal("unsafe CLI option accepted or echoed")
		}
	}
}
func TestInputBoundAndErrorRedaction(t *testing.T) {
	for _, in := range []string{strings.Repeat("x", 2049), `{"operation":"FAKE_PRIVATE_SENTINEL"}`, `{"operation":"usage_authenticated","token":"FAKE_PRIVATE_SENTINEL"}`} {
		var out, stderr bytes.Buffer
		if run([]string{"-check"}, strings.NewReader(in), &out, &stderr) != 1 || strings.Contains(stderr.String(), "FAKE_PRIVATE_SENTINEL") || out.Len() != 0 {
			t.Fatal("invalid input leaked or accepted")
		}
	}
}
