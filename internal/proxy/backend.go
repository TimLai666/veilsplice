package proxy

import (
	"context"
	"os"
	"unicode/utf8"
)

// SecretBackend is a boundary for a future managed-secret-store adapter.
// It is not a promise that every backend is safe: a backend must never log values.
type SecretBackend interface {
	Resolve(context.Context, string) (string, error)
}

type EnvBackend struct{ bindings map[string]string }

func NewEnvBackend(p Policy) *EnvBackend {
	bindings := make(map[string]string, len(p.Secrets))
	for k, v := range p.Secrets {
		bindings[k] = v
	}
	return &EnvBackend{bindings: bindings}
}

func (b *EnvBackend) Resolve(ctx context.Context, alias string) (string, error) {
	if ctx.Err() != nil {
		return "", ErrSecret
	}
	name, ok := b.bindings[alias]
	if !ok {
		return "", ErrSecret
	}
	value, ok := os.LookupEnv(name)
	if !ok || !validSecret(value) {
		return "", ErrSecret
	}
	return value, nil
}

func validSecret(value string) bool {
	return len(value) > 0 && len(value) <= maxSecretBytes && utf8.ValidString(value)
}
