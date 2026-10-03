// Package proxy implements a small, policy-bound secret-injecting HTTP client.
// It is intentionally internal: do not expose it as an unauthenticated service.
package proxy

import "errors"

// Errors are constant and never wrap upstream, parser, DNS, backend or OS errors.
var (
	ErrInput       = errors.New("invalid_input")
	ErrPolicy      = errors.New("invalid_policy")
	ErrDenied      = errors.New("request_denied")
	ErrSecret      = errors.New("secret_unavailable")
	ErrDestination = errors.New("destination_denied")
	ErrUpstream    = errors.New("upstream_failed")
	ErrRedirect    = errors.New("redirect_denied")
	ErrResponse    = errors.New("response_rejected")
)
