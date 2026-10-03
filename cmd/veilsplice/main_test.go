package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCheckDoesNotNeedSecretOrNetwork(t *testing.T) {
	dir := t.TempDir()
	policy := filepath.Join(dir, "policy.json")
	data := `{"secrets":{"demo":"VEILSPLICE_TEST_UNSET_DEMO"},"targets":{"demo":{"url":"https://api.example.com/v1/quotes","method":"GET","secrets":["demo"],"headers":["Authorization"],"query":[],"body":"none"}}}`
	if err := os.WriteFile(policy, []byte(data), 0600); err != nil {
		t.Fatal(err)
	}
	var out, stderr bytes.Buffer
	code := run([]string{"-check", "-policy", policy}, strings.NewReader(`{"target":"demo","headers":{"Authorization":"Bearer ${secret:demo}"}}`), &out, &stderr)
	if code != 0 || out.String() != "{\"syntax_valid\":true}\n" || stderr.Len() != 0 {
		t.Fatalf("check failed: code %d", code)
	}
}
func TestCLIErrorNeverEchoesArguments(t *testing.T) {
	var out, stderr bytes.Buffer
	code := run([]string{"-SECRET_FAKE_TOKEN"}, strings.NewReader(""), &out, &stderr)
	if code != 1 || strings.Contains(stderr.String(), "SECRET_FAKE_TOKEN") || stderr.String() != "{\"error\":\"invalid_input\"}\n" {
		t.Fatal("CLI argument leak")
	}
}
func TestReadInputLimit(t *testing.T) {
	if _, err := readInput("-", 4, strings.NewReader("12345")); err == nil {
		t.Fatal("oversized input accepted")
	}
}
