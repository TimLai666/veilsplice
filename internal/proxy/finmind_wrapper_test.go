package proxy

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/netip"
	"reflect"
	"strings"
	"testing"
)

const finmindWrapperFakeToken = "FAKE_WRAPPER_TOKEN_NEVER_SEND"
const validFinMindPrices = `{"operation":"prices_authenticated","stock_id":"2330","start_date":"2026-09-01","end_date":"2026-09-30"}`

type recordingFinMindBackend struct {
	values map[string]string
	names  []string
	err    error
}

func (b *recordingFinMindBackend) Resolve(_ context.Context, name string) (string, error) {
	b.names = append(b.names, name)
	return b.values[name], b.err
}

func fakeFinMindRunner(t *testing.T, backend SecretBackend, rt roundTripFunc) (*FinMindRunner, *fakeResolver) {
	t.Helper()
	r, err := NewFinMindRunner(backend)
	if err != nil {
		t.Fatal(err)
	}
	resolver := &fakeResolver{ips: []netip.Addr{netip.MustParseAddr("8.8.8.8")}}
	r.client.resolver = resolver
	r.client.transport = func(string, []netip.Addr) http.RoundTripper { return rt }
	return r, resolver
}

func TestFinMindWrapperPinsRequestAndProjection(t *testing.T) {
	for _, operation := range []string{"prices_authenticated", "prices_anonymous", "usage_authenticated"} {
		t.Run(operation, func(t *testing.T) {
			b := &recordingFinMindBackend{values: map[string]string{"finmind_token": finmindWrapperFakeToken, "unrelated": "OTHER_SECRET"}}
			input := strings.Replace(validFinMindPrices, "prices_authenticated", operation, 1)
			if operation == "usage_authenticated" {
				input = `{"operation":"usage_authenticated"}`
			}
			calls := 0
			r, _ := fakeFinMindRunner(t, b, func(req *http.Request) (*http.Response, error) {
				calls++
				if req.Method != "GET" || req.URL.Scheme != "https" {
					t.Fatal("method/scheme not pinned")
				}
				if operation == "prices_anonymous" {
					if req.Header.Get("Authorization") != "" {
						t.Fatal("anonymous mode sent authentication")
					}
				} else if req.Header.Get("Authorization") != "Bearer "+finmindWrapperFakeToken {
					t.Fatal("authenticated mode omitted fixed Bearer")
				}
				if strings.Contains(req.URL.String(), finmindWrapperFakeToken) || req.URL.Query().Get("token") != "" {
					t.Fatal("secret in URL")
				}
				if operation == "usage_authenticated" {
					if req.URL.String() != "https://api.web.finmindtrade.com/v2/user_info" {
						t.Fatal("usage target changed")
					}
					return reply(200, `{"user_count":7,"api_request_limit":600,"name":"PRIVATE_FIXTURE","token":"`+finmindWrapperFakeToken+`"}`), nil
				}
				if req.URL.Host != "api.finmindtrade.com" || req.URL.Path != "/api/v4/data" || req.URL.Query().Get("dataset") != "TaiwanStockPrice" || req.URL.Query().Get("data_id") != "2330" || len(req.URL.Query()) != 4 {
					t.Fatal("price target/query not pinned")
				}
				return reply(200, `{"data":[{"date":"2026-09-01","open":100.25,"close":101.5,"secret":"`+finmindWrapperFakeToken+`","extra":{"nested":"PRIVATE_FIXTURE"}}]}`), nil
			})
			result, err := r.Execute(context.Background(), []byte(input))
			if err != nil || calls != 1 {
				t.Fatal("wrapper execution failed", err)
			}
			out, _ := json.Marshal(result)
			if result.BodyDiscarded || strings.Contains(string(out), finmindWrapperFakeToken) || strings.Contains(string(out), "PRIVATE_FIXTURE") || strings.Contains(string(out), "extra") {
				t.Fatal("projection leaked unselected field")
			}
			if operation == "prices_anonymous" {
				if len(b.names) != 0 {
					t.Fatal("anonymous mode accessed backend")
				}
			} else if !reflect.DeepEqual(b.names, []string{"finmind_token"}) {
				t.Fatal("wrong backend alias")
			}
		})
	}
}

func TestFinMindWrapperRejectsUntrustedControlBeforeDNS(t *testing.T) {
	inputs := []string{
		`{"operation":"prices_authenticated","stock_id":"2330","start_date":"2026-09-01","end_date":"2026-09-30","policy":"attacker.json"}`,
		`{"operation":"prices_authenticated","stock_id":"2330","start_date":"2026-09-01","end_date":"2026-09-30","dataset":"OtherDataset"}`,
		`{"operation":"prices_authenticated","stock_id":"2330","start_date":"2026-09-01","end_date":"2026-09-30","url":"https://attacker.example"}`,
		`{"operation":"prices_authenticated","stock_id":"2330","start_date":"2026-09-01","end_date":"2026-09-30","headers":{"Authorization":"Bearer ${secret:other}"}}`,
		`{"operation":"prices_authenticated","stock_id":"${secret:other}","start_date":"2026-09-01","end_date":"2026-09-30"}`,
		`{"operation":"usage_authenticated","secret":"unrelated"}`,
		`{"operation":"usage_authenticated","finmind_token":"FAKE_PRIVATE_SENTINEL"}`,
		`{"operation":"usage_authenticated","stock_id":""}`,
		`{"operation":"usage_authenticated","stock_id":null}`,
		`{"operation":"usage_anonymous"}`,
		`{"Operation":"usage_authenticated"}`,
		`{"operation":"usage_authenticated","Operation":"prices_anonymous","stock_id":"2330","start_date":"2026-09-01","end_date":"2026-09-30"}`,
		`{"operation":"prices_anonymous","operation":"prices_authenticated","stock_id":"2330","start_date":"2026-09-01","end_date":"2026-09-30"}`,
	}
	for _, input := range inputs {
		b := &recordingFinMindBackend{}
		r, resolver := fakeFinMindRunner(t, b, func(*http.Request) (*http.Response, error) { t.Fatal("untrusted control sent"); return nil, nil })
		_, err := r.Execute(context.Background(), []byte(input))
		if err != ErrInput || len(b.names) != 0 || resolver.calls != 0 {
			t.Fatal("invalid control accepted or reached backend/DNS")
		}
		if strings.Contains(err.Error(), "FAKE_PRIVATE_SENTINEL") {
			t.Fatal("input leaked into error")
		}
	}
}

func TestFinMindWrapperBoundsDatesAndSingleStock(t *testing.T) {
	for _, tc := range []struct {
		stock, start, end string
		valid             bool
	}{
		{"2330", "2026-01-01", "2026-01-31", true},
		{"2330", "2026-01-01", "2026-02-01", false},
		{"2330", "2026-09-01", "2026-09-01", true},
		{"0050", "2024-02-29", "2024-03-01", true},
		{"006208", "2026-09-01", "2026-09-02", true},
		{"2330", "2026-02-29", "2026-03-01", false},
		{"2330", "2026-09-02", "2026-09-01", false},
		{"2330", "2026-9-01", "2026-09-30", false},
		{"2330", "", "2026-09-30", false},
		{"2330,0050", "2026-09-01", "2026-09-30", false},
		{"233", "2026-09-01", "2026-09-30", false},
		{"1234567", "2026-09-01", "2026-09-30", false},
		{"2330&token=x", "2026-09-01", "2026-09-30", false},
	} {
		b, _ := json.Marshal(finmindInput{Operation: "prices_authenticated", StockID: tc.stock, StartDate: tc.start, EndDate: tc.end})
		if (ValidateFinMindInput(b) == nil) != tc.valid {
			t.Fatalf("schema mismatch for %+v", tc)
		}
	}
	for _, input := range []string{
		`{"operation":"prices_authenticated","stock_id":["2330","0050"],"start_date":"2026-09-01","end_date":"2026-09-30"}`,
		`{"operation":"prices_authenticated","stock_id":2330,"start_date":"2026-09-01","end_date":"2026-09-30"}`,
		`{"operation":"prices_authenticated","stock_id":"2330","start_date":null,"end_date":"2026-09-30"}`,
		strings.Repeat(" ", FinMindInputLimit) + validFinMindPrices,
	} {
		if ValidateFinMindInput([]byte(input)) != ErrInput {
			t.Fatal("bad schema accepted")
		}
	}
}

func TestFinMindWrapperMissingAuthNeverDowngrades(t *testing.T) {
	for _, operation := range []string{"prices_authenticated", "usage_authenticated"} {
		for _, b := range []*recordingFinMindBackend{{values: map[string]string{}}, {values: map[string]string{"other": "NOT_THE_AUTHORIZED_ALIAS"}}, {err: errors.New(finmindWrapperFakeToken)}} {
			r, _ := fakeFinMindRunner(t, b, func(*http.Request) (*http.Response, error) { t.Fatal("unauthenticated fallback sent"); return nil, nil })
			input := validFinMindPrices
			if operation == "usage_authenticated" {
				input = `{"operation":"usage_authenticated"}`
			}
			_, err := r.Execute(context.Background(), []byte(input))
			if err != ErrSecret || strings.Contains(err.Error(), finmindWrapperFakeToken) || !reflect.DeepEqual(b.names, []string{"finmind_token"}) {
				t.Fatal("auth failure not enforced/sanitized")
			}
		}
	}
}

func TestFinMindWrapperResponseAndErrorRejection(t *testing.T) {
	for _, tc := range []struct {
		name, body  string
		upstreamErr bool
	}{
		{"non_numeric", `{"data":[{"date":"2026-09-01","open":"` + finmindWrapperFakeToken + `","close":1}]}`, false},
		{"invalid_date", `{"data":[{"date":"2026-02-30","open":1,"close":2}]}`, false},
		{"too_many_rows", `{"data":[` + strings.TrimSuffix(strings.Repeat(`{"date":"2026-09-01","open":1,"close":2},`, 32), ",") + `]}`, false},
		{"transport_error", "", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			b := &recordingFinMindBackend{values: map[string]string{"finmind_token": finmindWrapperFakeToken}}
			r, _ := fakeFinMindRunner(t, b, func(*http.Request) (*http.Response, error) {
				if tc.upstreamErr {
					return nil, errors.New(finmindWrapperFakeToken)
				}
				return reply(200, tc.body), nil
			})
			_, err := r.Execute(context.Background(), []byte(validFinMindPrices))
			want := ErrResponse
			if tc.upstreamErr {
				want = ErrUpstream
			}
			if err != want || strings.Contains(err.Error(), finmindWrapperFakeToken) {
				t.Fatal("response/transport failure leaked")
			}
		})
	}
}

func TestFinMindAnonymousDoesNotPermitSecretBinding(t *testing.T) {
	p, err := ParsePolicy([]byte(fixedFinMindPolicy))
	if err != nil {
		t.Fatal(err)
	}
	anon := p.Targets["prices_anonymous"]
	if len(anon.Secrets) != 0 || len(anon.Headers) != 0 {
		t.Fatal("anonymous policy authorizes secrets")
	}
	for _, name := range []string{"prices_authenticated", "usage_authenticated"} {
		target := p.Targets[name]
		if !reflect.DeepEqual(target.Secrets, []string{"finmind_token"}) || !reflect.DeepEqual(target.Headers, []string{"Authorization"}) {
			t.Fatal("authenticated policy binding changed")
		}
	}
}

func FuzzFinMindWrapperInput(f *testing.F) {
	f.Add([]byte(validFinMindPrices))
	f.Add([]byte(`{"operation":"usage_authenticated"}`))
	f.Fuzz(func(t *testing.T, input []byte) {
		request, err := prepareFinMind(input)
		if err != nil {
			return
		}
		tmpl, err := ParseTemplate(request)
		if err != nil {
			t.Fatal("prepared template invalid")
		}
		if tmpl.Target == "prices_anonymous" && len(tmpl.Headers) != 0 {
			t.Fatal("anonymous auth regression")
		}
	})
}

func TestFinMindWrapperRejectedTokenNeverRetriesAnonymously(t *testing.T) {
	b := &recordingFinMindBackend{values: map[string]string{"finmind_token": finmindWrapperFakeToken}}
	calls := 0
	r, _ := fakeFinMindRunner(t, b, func(req *http.Request) (*http.Response, error) {
		calls++
		if req.Header.Get("Authorization") != "Bearer "+finmindWrapperFakeToken {
			t.Fatal("authenticated request downgraded")
		}
		return reply(401, `{"token":"`+finmindWrapperFakeToken+`","error":"synthetic invalid token"}`), nil
	})
	result, err := r.Execute(context.Background(), []byte(validFinMindPrices))
	if err != nil || calls != 1 || result.StatusCode != 401 || !result.BodyDiscarded || result.Data != nil {
		t.Fatal("rejected token was retried or its response exposed")
	}
	if !reflect.DeepEqual(b.names, []string{"finmind_token"}) {
		t.Fatal("unexpected alias lookup")
	}
}
