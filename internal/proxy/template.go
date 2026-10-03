package proxy

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
)

type expansion struct {
	ctx     context.Context
	backend SecretBackend
	allowed map[string]bool
	values  map[string]string
	used    int
}

func (e *expansion) expand(s string) (string, error) {
	var b strings.Builder
	for {
		i := strings.Index(s, "${")
		if i < 0 {
			b.WriteString(s)
			break
		}
		b.WriteString(s[:i])
		s = s[i:]
		end := strings.IndexByte(s, '}')
		if !strings.HasPrefix(s, "${secret:") || end < 0 {
			return "", ErrInput
		}
		name := s[len("${secret:"):end]
		if !namePattern.MatchString(name) || !e.allowed[name] {
			return "", ErrDenied
		}
		v, ok := e.values[name]
		if !ok {
			var err error
			v, err = e.backend.Resolve(e.ctx, name)
			if err != nil || !validSecret(v) {
				return "", ErrSecret
			}
			e.values[name] = v
		}
		b.WriteString(v) // Never scan the inserted secret again.
		if b.Len() > maxExpandedBytes {
			return "", ErrInput
		}
		s = s[end+1:]
	}
	if b.Len() > maxExpandedBytes || e.used+b.Len() > maxExpandedBytes {
		return "", ErrInput
	}
	e.used += b.Len()
	return b.String(), nil
}

func (e *expansion) jsonValue(v any) (any, error) {
	switch x := v.(type) {
	case string:
		return e.expand(x)
	case []any:
		for i := range x {
			v, err := e.jsonValue(x[i])
			if err != nil {
				return nil, err
			}
			x[i] = v
		}
		return x, nil
	case map[string]any:
		for k, v := range x {
			if strings.Contains(k, "${") {
				return nil, ErrInput
			}
			out, err := e.jsonValue(v)
			if err != nil {
				return nil, err
			}
			x[k] = out
		}
		return x, nil
	default:
		return v, nil
	}
}

func contains(list []string, value string, fold bool) bool {
	for _, s := range list {
		if s == value || fold && strings.EqualFold(s, value) {
			return true
		}
	}
	return false
}

func (e *expansion) build(t Template, policy Target) (*http.Request, error) {
	u, err := targetURL(policy.URL)
	if err != nil {
		return nil, ErrDenied
	}
	if (policy.Body != "json" && t.JSON != nil) || (policy.Body != "form" && t.Form != nil) || (policy.Body == "json" && t.JSON == nil) || (policy.Body == "form" && t.Form == nil) {
		return nil, ErrDenied
	}
	query := url.Values{}
	for key, value := range t.Query {
		if !contains(policy.Query, key, false) {
			return nil, ErrDenied
		}
		v, err := e.expand(value)
		if err != nil {
			return nil, err
		}
		query.Set(key, v)
	}
	u.RawQuery = query.Encode()
	if len(u.String()) > maxExpandedBytes {
		return nil, ErrInput
	}
	var body []byte
	contentType := ""
	switch policy.Body {
	case "json":
		var v any
		if decodeStrict(t.JSON, &v) != nil {
			return nil, ErrInput
		}
		v, err = e.jsonValue(v)
		if err != nil {
			return nil, err
		}
		body, err = json.Marshal(v)
		if err != nil {
			return nil, ErrInput
		}
		contentType = "application/json"
	case "form":
		form := url.Values{}
		for key, value := range t.Form {
			if !contains(policy.Form, key, false) {
				return nil, ErrDenied
			}
			v, err := e.expand(value)
			if err != nil {
				return nil, err
			}
			form.Set(key, v)
		}
		body = []byte(form.Encode())
		contentType = "application/x-www-form-urlencoded"
	}
	if len(body) > maxExpandedBytes {
		return nil, ErrInput
	}
	req, err := http.NewRequestWithContext(e.ctx, policy.Method, u.String(), strings.NewReader(string(body)))
	if err != nil {
		return nil, ErrInput
	}
	seen := map[string]bool{}
	for key, value := range t.Headers {
		canonical := http.CanonicalHeaderKey(key)
		if !validHeaderName(key) || forbiddenHeader(key) || seen[canonical] || !contains(policy.Headers, key, true) {
			return nil, ErrDenied
		}
		seen[canonical] = true
		v, err := e.expand(value)
		if err != nil {
			return nil, err
		}
		for _, c := range []byte(v) {
			if c < 32 && c != '\t' || c == 127 {
				return nil, ErrInput
			}
		}
		req.Header.Set(canonical, v)
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "veilsplice/0.1")
	req.Close = true
	return req, nil
}
