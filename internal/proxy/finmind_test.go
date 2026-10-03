package proxy

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func finmindFixture(t *testing.T, name string) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "..", "examples", "finmind", name))
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestFinMindReadOnlyFixtures(t *testing.T) {
	p, err := ParsePolicy(finmindFixture(t, "policy.json"))
	if err != nil {
		t.Fatal(err)
	}
	fakeToken := strings.TrimSpace(string(finmindFixture(t, "fixtures/fake-token.txt")))
	for _, tc := range []struct {
		name, request, response, result, endpoint string
		auth                                      bool
	}{
		{"prices", "request-prices.json", "response-prices.json", "result-prices.json", "https://api.finmindtrade.com/api/v4/data", true},
		{"anonymous", "request-anonymous.json", "response-prices.json", "result-prices.json", "https://api.finmindtrade.com/api/v4/data", false},
		{"usage", "request-usage.json", "response-usage.json", "result-usage.json", "https://api.web.finmindtrade.com/v2/user_info", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			b := &fakeBackend{values: map[string]string{"finmind_token": fakeToken}}
			c, err := New(p, b)
			if err != nil {
				t.Fatal(err)
			}
			c.resolver = &fakeResolver{ips: []netip.Addr{netip.MustParseAddr("8.8.8.8")}}
			calls := 0
			c.transport = func(host string, ips []netip.Addr) http.RoundTripper {
				return roundTripFunc(func(req *http.Request) (*http.Response, error) {
					calls++
					if req.Method != "GET" || req.URL.Scheme+"://"+req.URL.Host+req.URL.Path != tc.endpoint || req.URL.Hostname() != host {
						t.Fatal("FinMind destination or method mismatch")
					}
					body, _ := io.ReadAll(req.Body)
					if len(body) != 0 {
						t.Fatal("read-only request has a body")
					}
					if tc.auth {
						if req.Header.Get("Authorization") != "Bearer "+fakeToken {
							t.Fatal("missing fake backend Bearer value")
						}
					} else if req.Header.Get("Authorization") != "" {
						t.Fatal("anonymous request unexpectedly authenticated")
					}
					if strings.Contains(req.URL.String(), fakeToken) || req.URL.Query().Get("token") != "" {
						t.Fatal("credential in URL")
					}
					if tc.name == "usage" {
						if req.URL.RawQuery != "" {
							t.Fatal("usage query not empty")
						}
					} else if req.URL.Query().Get("dataset") != "TaiwanStockPrice" {
						t.Fatal("incorrect dataset fixture")
					}
					return reply(200, string(finmindFixture(t, "fixtures/"+tc.response))), nil
				})
			}
			result, err := c.Execute(context.Background(), finmindFixture(t, tc.request))
			if err != nil {
				t.Fatal(err)
			}
			if calls != 1 {
				t.Fatal("unexpected fake transport calls")
			}
			if tc.auth && b.calls != 1 || !tc.auth && b.calls != 0 {
				t.Fatal("unexpected backend access")
			}
			encoded, err := json.Marshal(result)
			if err != nil {
				t.Fatal(err)
			}
			var got, want any
			if decodeStrict(encoded, &got) != nil || decodeStrict(finmindFixture(t, "fixtures/"+tc.result), &want) != nil || !reflect.DeepEqual(got, want) {
				t.Fatal("projection differs from expected fixture")
			}
			if strings.Contains(string(encoded), fakeToken) || strings.Contains(string(encoded), "synthetic_private_field") || strings.Contains(string(encoded), "fixture_note") {
				t.Fatal("non-projected data escaped")
			}
		})
	}
}

func TestFinMindPolicyRejectsCredentialQueryAndBodies(t *testing.T) {
	p, err := ParsePolicy(finmindFixture(t, "policy.json"))
	if err != nil {
		t.Fatal(err)
	}
	for _, tmpl := range []Template{
		{Target: "finmind_prices", Query: map[string]string{"token": "${secret:finmind_token}"}},
		{Target: "finmind_prices", Query: map[string]string{"password": "not-a-password"}},
		{Target: "finmind_prices", JSON: json.RawMessage(`{"any":"body"}`)},
		{Target: "finmind_usage", Query: map[string]string{"token": "${secret:finmind_token}"}},
	} {
		c, _, _ := testClient(t, p, func(*http.Request) (*http.Response, error) { t.Fatal("denied FinMind request sent"); return nil, nil })
		if _, err := c.Execute(context.Background(), rawTemplate(t, tmpl)); err != ErrDenied {
			t.Fatal("unsafe provider request accepted")
		}
	}
}
