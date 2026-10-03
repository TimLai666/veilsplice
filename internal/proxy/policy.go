package proxy

import (
	"encoding/json"
	"net"
	"net/url"
	"regexp"
	"strings"
)

const MaxInputBytes = 64 << 10
const MaxPolicyBytes = 256 << 10
const maxExpandedBytes = 1 << 20
const maxSecretBytes = 16 << 10

var namePattern = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_]{0,63}$`)
var envPattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,127}$`)

type Policy struct {
	Secrets map[string]string `json:"secrets"` // Alias to a specific environment variable.
	Targets map[string]Target `json:"targets"`
}

type Target struct {
	URL      string          `json:"url"`
	Method   string          `json:"method"`
	Secrets  []string        `json:"secrets"`
	Headers  []string        `json:"headers"`
	Query    []string        `json:"query"`
	Body     string          `json:"body"` // none, json, or form
	Form     []string        `json:"form,omitempty"`
	Response *ResponsePolicy `json:"response,omitempty"`
}

type ResponsePolicy struct {
	JSONPointer string            `json:"json_pointer"`
	Fields      map[string]string `json:"fields"` // date, number, boolean, or string
	MaxBytes    int64             `json:"max_bytes"`
	MaxItems    int               `json:"max_items"`
}

type Template struct {
	Target  string            `json:"target"`
	Headers map[string]string `json:"headers,omitempty"`
	Query   map[string]string `json:"query,omitempty"`
	JSON    json.RawMessage   `json:"json,omitempty"`
	Form    map[string]string `json:"form,omitempty"`
}

func ParsePolicy(data []byte) (Policy, error) {
	var p Policy
	if len(data) > MaxPolicyBytes || decodeStrict(data, &p) != nil {
		return p, ErrPolicy
	}
	if len(p.Targets) == 0 || len(p.Targets) > 100 || len(p.Secrets) > 100 {
		return p, ErrPolicy
	}
	for alias, env := range p.Secrets {
		if !namePattern.MatchString(alias) || !envPattern.MatchString(env) {
			return p, ErrPolicy
		}
	}
	for name, t := range p.Targets {
		if !namePattern.MatchString(name) {
			return p, ErrPolicy
		}
		if _, err := targetURL(t.URL); err != nil {
			return p, ErrPolicy
		}
		switch t.Method {
		case "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD":
		default:
			return p, ErrPolicy
		}
		if t.Body != "none" && t.Body != "json" && t.Body != "form" {
			return p, ErrPolicy
		}
		if (t.Method == "GET" || t.Method == "HEAD") && t.Body != "none" {
			return p, ErrPolicy
		}
		if t.Body != "form" && len(t.Form) > 0 {
			return p, ErrPolicy
		}
		seen := map[string]bool{}
		for _, s := range t.Secrets {
			if _, ok := p.Secrets[s]; !ok || seen[s] {
				return p, ErrPolicy
			}
			seen[s] = true
		}
		seen = map[string]bool{}
		for _, h := range t.Headers {
			h = strings.ToLower(h)
			if !validHeaderName(h) || forbiddenHeader(h) || seen[h] {
				return p, ErrPolicy
			}
			seen[h] = true
		}
		for _, keys := range [][]string{t.Query, t.Form} {
			seen = map[string]bool{}
			for _, k := range keys {
				if !validField(k) || seen[k] {
					return p, ErrPolicy
				}
				seen[k] = true
			}
		}
		if t.Response != nil && !validResponsePolicy(*t.Response) {
			return p, ErrPolicy
		}
	}
	return p, nil
}

func ParseTemplate(data []byte) (Template, error) {
	var t Template
	if len(data) > MaxInputBytes || decodeStrict(data, &t) != nil || !namePattern.MatchString(t.Target) {
		return t, ErrInput
	}
	return t, nil
}

func targetURL(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || len(raw) > 2048 || u.Scheme != "https" || u.Opaque != "" || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.RawFragment != "" {
		return nil, ErrDestination
	}
	host := u.Hostname()
	if !validHost(host) || (u.Port() != "" && u.Port() != "443") || u.Host != host && u.Host != host+":443" {
		return nil, ErrDestination
	}
	if strings.Contains(raw, "${") || strings.ContainsAny(raw, "\r\n\\") {
		return nil, ErrDestination
	}
	return u, nil
}

func validHost(host string) bool {
	if len(host) > 253 || strings.ToLower(host) != host || !strings.Contains(host, ".") || net.ParseIP(host) != nil {
		return false
	}
	for _, suffix := range []string{".localhost", ".local", ".internal", ".test", ".invalid", ".onion"} {
		if strings.HasSuffix(host, suffix) {
			return false
		}
	}
	for _, label := range strings.Split(host, ".") {
		if len(label) == 0 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return false
		}
		for _, c := range label {
			if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-') {
				return false
			}
		}
	}
	return true
}

func validField(s string) bool {
	return s != "" && len(s) <= 128 && !strings.Contains(s, "${") && !strings.ContainsAny(s, "\x00\r\n")
}
func validHeaderName(s string) bool {
	if s == "" || len(s) > 128 {
		return false
	}
	for _, c := range s {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || strings.ContainsRune("!#$%&'*+-.^_`|~", c)) {
			return false
		}
	}
	return true
}
func forbiddenHeader(h string) bool {
	switch strings.ToLower(h) {
	case "host", "connection", "proxy-connection", "proxy-authorization", "proxy-authenticate", "forwarded", "x-forwarded-host", "x-forwarded-for", "x-forwarded-proto", "content-length", "content-type", "transfer-encoding", "trailer", "te", "upgrade", "accept-encoding":
		return true
	}
	return strings.HasPrefix(strings.ToLower(h), "proxy-")
}

func validResponsePolicy(p ResponsePolicy) bool {
	if p.MaxBytes < 1 || p.MaxBytes > maxExpandedBytes || p.MaxItems < 1 || p.MaxItems > 1000 || len(p.Fields) < 1 || len(p.Fields) > 64 {
		return false
	}
	if _, err := pointerParts(p.JSONPointer); err != nil {
		return false
	}
	for k, typ := range p.Fields {
		if !validField(k) {
			return false
		}
		switch typ {
		case "date", "number", "boolean", "string":
		default:
			return false
		}
	}
	return true
}
