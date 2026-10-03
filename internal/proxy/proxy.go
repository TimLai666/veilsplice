package proxy

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/netip"
	"time"
)

type Result struct {
	StatusCode    int  `json:"status_code"`
	BodyDiscarded bool `json:"body_discarded"`
	Data          any  `json:"data,omitempty"`
}

type Client struct {
	policy    Policy
	backend   SecretBackend
	resolver  resolver
	transport func(string, []netip.Addr) http.RoundTripper
}

func New(p Policy, backend SecretBackend) (*Client, error) {
	// Copy and revalidate even if an internal caller did not use ParsePolicy.
	data, err := json.Marshal(p)
	if err != nil {
		return nil, ErrPolicy
	}
	p, err = ParsePolicy(data)
	if err != nil || backend == nil {
		return nil, ErrPolicy
	}
	return &Client{policy: p, backend: backend, resolver: net.DefaultResolver,
		transport: func(h string, ips []netip.Addr) http.RoundTripper { return secureTransport(h, ips) }}, nil
}

func (c *Client) Execute(ctx context.Context, input []byte) (Result, error) {
	var result Result
	t, err := ParseTemplate(input)
	if err != nil {
		return result, err
	}
	p, ok := c.policy.Targets[t.Target]
	if !ok {
		return result, ErrDenied
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	u, _ := targetURL(p.URL)
	ips, err := resolvePublic(ctx, c.resolver, u.Hostname())
	if err != nil {
		return result, err
	}
	e := &expansion{ctx: ctx, backend: c.backend, allowed: map[string]bool{}, values: map[string]string{}}
	for _, name := range p.Secrets {
		e.allowed[name] = true
	}
	req, err := e.build(t, p)
	if err != nil {
		return result, err
	}
	transport := c.transport(u.Hostname(), ips)
	if closer, ok := transport.(interface{ CloseIdleConnections() }); ok {
		defer closer.CloseIdleConnections()
	}
	client := http.Client{Transport: transport, Timeout: 30 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.Do(req)
	if err != nil {
		return result, ErrUpstream
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 && resp.StatusCode < 400 {
		return result, ErrRedirect
	}
	result = Result{StatusCode: resp.StatusCode, BodyDiscarded: true}
	// Non-success response payloads and all response headers are never returned.
	if p.Response != nil && resp.StatusCode >= 200 && resp.StatusCode < 300 {
		result.Data, err = projectResponse(resp, *p.Response, e.values)
		if err != nil {
			return Result{}, ErrResponse
		}
		result.BodyDiscarded = false
	}
	return result, nil
}
