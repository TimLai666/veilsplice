package proxy

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"reflect"
	"strings"
	"testing"
)

const fakeSecret = "FAKE-only-+&/\"-not-a-real-key"

type fakeBackend struct {
	values map[string]string
	err    error
	calls  int
}

func (b *fakeBackend) Resolve(_ context.Context, name string) (string, error) {
	b.calls++
	return b.values[name], b.err
}

type fakeResolver struct {
	ips   []netip.Addr
	err   error
	calls int
}

func (r *fakeResolver) LookupNetIP(context.Context, string, string) ([]netip.Addr, error) {
	r.calls++
	return r.ips, r.err
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func policyFixture() Policy {
	return Policy{
		Secrets: map[string]string{"demo": "VEILSPLICE_TEST_DEMO_ONLY"},
		Targets: map[string]Target{"demo": {
			URL: "https://api.example.com/v1/quotes", Method: "POST", Body: "json",
			Secrets: []string{"demo"}, Headers: []string{"Authorization", "X-API-Key"}, Query: []string{"api_key", "symbol"},
		}},
	}
}
func expFixture(secret string) *expansion {
	return &expansion{ctx: context.Background(), backend: &fakeBackend{values: map[string]string{"demo": secret}}, allowed: map[string]bool{"demo": true}, values: map[string]string{}}
}
func responseFixture() *ResponsePolicy {
	return &ResponsePolicy{JSONPointer: "/data", Fields: map[string]string{"date": "date", "open": "number", "close": "number"}, MaxBytes: 4096, MaxItems: 5}
}
func testClient(t *testing.T, p Policy, rt roundTripFunc) (*Client, *fakeBackend, *fakeResolver) {
	t.Helper()
	b := &fakeBackend{values: map[string]string{"demo": fakeSecret}}
	c, err := New(p, b)
	if err != nil {
		t.Fatal(err)
	}
	r := &fakeResolver{ips: []netip.Addr{netip.MustParseAddr("8.8.8.8")}}
	c.resolver = r
	c.transport = func(string, []netip.Addr) http.RoundTripper { return rt }
	return c, b, r
}
func rawTemplate(t *testing.T, tmpl Template) []byte {
	t.Helper()
	b, err := json.Marshal(tmpl)
	if err != nil {
		t.Fatal(err)
	}
	return b
}
func goodTemplate() Template {
	return Template{Target: "demo", Headers: map[string]string{"Authorization": "Bearer ${secret:demo}"}, JSON: json.RawMessage(`{"symbol":"2330"}`)}
}
func reply(code int, body string) *http.Response {
	return &http.Response{StatusCode: code, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(body))}
}

func TestExpansionPositionsAndNoRecursion(t *testing.T) {
	for _, tc := range []struct{ in, out string }{{"${secret:demo}", "TOKEN"}, {"prefix${secret:demo}suffix", "prefixTOKENsuffix"}, {"${secret:demo}:${secret:demo}", "TOKEN:TOKEN"}, {"literal", "literal"}} {
		e := expFixture("TOKEN")
		v, err := e.expand(tc.in)
		if err != nil || v != tc.out {
			t.Fatalf("bad expansion: %v", err)
		}
	}
	e := expFixture("${secret:other}")
	v, err := e.expand("${secret:demo}")
	if err != nil || v != "${secret:other}" {
		t.Fatal("secret was recursively expanded")
	}
}
func TestExpansionRejectsUnknownAndMalformed(t *testing.T) {
	for _, input := range []string{"${secret:other}", "${secret:demo", "${secret:}", "${env:HOME}", "${secret:../demo}", "${secret:demo }"} {
		if _, err := expFixture("TOKEN").expand(input); err == nil {
			t.Fatalf("accepted malformed token: %q", input)
		}
	}
	e := expFixture(strings.Repeat("x", maxSecretBytes))
	if _, err := e.expand(strings.Repeat("${secret:demo}", 65)); err == nil {
		t.Fatal("expansion limit not enforced")
	}
	e = expFixture(strings.Repeat("x", maxSecretBytes))
	for i := 0; i < 64; i++ {
		if _, err := e.expand("${secret:demo}"); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := e.expand("x"); err == nil {
		t.Fatal("aggregate limit not enforced")
	}
}
func TestRequestSerializationAllSurfaces(t *testing.T) {
	p := policyFixture().Targets["demo"]
	e := expFixture(fakeSecret)
	tmpl := Template{Target: "demo", Headers: map[string]string{"Authorization": "prefix ${secret:demo} suffix"}, Query: map[string]string{"api_key": "a${secret:demo}z"}, JSON: json.RawMessage(`{"nested":["x${secret:demo}y",9007199254740993,true]}`)}
	req, err := e.build(tmpl, p)
	if err != nil {
		t.Fatal(err)
	}
	if req.Header.Get("Authorization") != "prefix "+fakeSecret+" suffix" {
		t.Fatal("header mismatch")
	}
	if req.URL.Query().Get("api_key") != "a"+fakeSecret+"z" {
		t.Fatal("query encoding mismatch")
	}
	body, _ := io.ReadAll(req.Body)
	var got map[string]any
	if decodeStrict(body, &got) != nil {
		t.Fatal("invalid JSON")
	}
	items := got["nested"].([]any)
	if items[0] != "x"+fakeSecret+"y" || items[1].(json.Number).String() != "9007199254740993" {
		t.Fatal("JSON interpolation corrupted values")
	}
	p.Body = "form"
	p.Form = []string{"credential"}
	tmpl.JSON = nil
	tmpl.Form = map[string]string{"credential": "x${secret:demo}y"}
	req, err = expFixture(fakeSecret).build(tmpl, p)
	if err != nil {
		t.Fatal(err)
	}
	body, _ = io.ReadAll(req.Body)
	form, _ := url.ParseQuery(string(body))
	if form.Get("credential") != "x"+fakeSecret+"y" {
		t.Fatal("form encoding mismatch")
	}
	if req.Header.Get("Content-Type") != "application/x-www-form-urlencoded" {
		t.Fatal("wrong content type")
	}
}
func TestHeaderBodyAndKeyDenials(t *testing.T) {
	p := policyFixture().Targets["demo"]
	for _, headers := range []map[string]string{{"Host": "attacker.example"}, {"Connection": "upgrade"}, {"X-Unlisted": "x"}, {"Authorization": "x\r\nX-Evil: yes"}, {"Authorization": "x", "authorization": "y"}} {
		tmpl := goodTemplate()
		tmpl.Headers = headers
		if _, err := expFixture(fakeSecret).build(tmpl, p); err == nil {
			t.Fatal("unsafe header accepted")
		}
	}
	tmpl := goodTemplate()
	tmpl.JSON = json.RawMessage(`{"${secret:demo}":"x"}`)
	if _, err := expFixture(fakeSecret).build(tmpl, p); err == nil {
		t.Fatal("secret in JSON key")
	}
	tmpl = goodTemplate()
	tmpl.Form = map[string]string{}
	if _, err := expFixture(fakeSecret).build(tmpl, p); err == nil {
		t.Fatal("mixed body accepted")
	}
	tmpl = goodTemplate()
	tmpl.Query = map[string]string{"url": "https://attacker.example"}
	if _, err := expFixture(fakeSecret).build(tmpl, p); err == nil {
		t.Fatal("unknown query accepted")
	}
	if _, err := expFixture("line1\nline2").build(goodTemplate(), p); err == nil {
		t.Fatal("secret newline allowed in header")
	}
}
func TestPolicyDestinationsDenied(t *testing.T) {
	for _, raw := range []string{"http://api.example.com/x", "https://127.0.0.1/x", "https://[::1]/x", "https://user:pass@api.example.com/x", "https://api.example.com:8443/x", "https://api.example.com./x", "https://API.example.com/x", "https://api.example.com/x?q=1", "https://api.example.com/x?", "https://api.example.com/x#fragment", "https://api.example.com/${secret:demo}", "https://internal.local/x", "https://metadata.google.internal/"} {
		if _, err := targetURL(raw); err == nil {
			t.Fatalf("unsafe URL accepted: %s", raw)
		}
	}
	for _, raw := range []string{"https://api.example.com/v1/a", "https://api.example.com:443/v1/a"} {
		if _, err := targetURL(raw); err != nil {
			t.Fatal(err)
		}
	}
}
func TestStrictInputAndPolicy(t *testing.T) {
	for _, input := range []string{`{"target":"demo","target":"other"}`, `{"target":"demo","url":"https://evil.example"}`, `{"target":"demo"} {}`, `{"target":"demo","json":{"a":1,"a":2}}`, "\xff"} {
		if _, err := ParseTemplate([]byte(input)); err == nil {
			t.Fatal("invalid template accepted")
		}
	}
	p := policyFixture()
	p.Targets["demo"] = Target{URL: "https://api.example.com", Method: "CONNECT", Body: "none"}
	data, _ := json.Marshal(p)
	if _, err := ParsePolicy(data); err == nil {
		t.Fatal("CONNECT allowed")
	}
	p = policyFixture()
	v := p.Targets["demo"]
	v.Secrets = []string{"unknown"}
	p.Targets["demo"] = v
	data, _ = json.Marshal(p)
	if _, err := ParsePolicy(data); err == nil {
		t.Fatal("unknown secret allowed")
	}
}
func TestPublicIPPolicy(t *testing.T) {
	for _, s := range []string{"0.0.0.0", "10.0.0.1", "100.64.0.1", "127.0.0.1", "169.254.169.254", "172.16.4.3", "192.168.1.1", "192.0.0.1", "192.0.2.1", "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "240.0.0.1", "168.63.129.16", "::", "::1", "::ffff:127.0.0.1", "fc00::1", "fe80::1", "ff02::1", "64:ff9b::a9fe:a9fe", "2001::1", "2001:db8::1", "2002:a9fe:a9fe::1", "3fff::1"} {
		if publicIP(netip.MustParseAddr(s)) {
			t.Fatalf("non-public accepted: %s", s)
		}
	}
	for _, s := range []string{"8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"} {
		if !publicIP(netip.MustParseAddr(s)) {
			t.Fatalf("public rejected: %s", s)
		}
	}
}
func TestDNSMixedAnswersRejectedBeforeSecretAccess(t *testing.T) {
	c, b, r := testClient(t, policyFixture(), func(*http.Request) (*http.Response, error) { t.Fatal("sent blocked request"); return nil, nil })
	r.ips = append(r.ips, netip.MustParseAddr("169.254.169.254"))
	_, err := c.Execute(context.Background(), rawTemplate(t, goodTemplate()))
	if err != ErrDestination || b.calls != 0 || r.calls != 1 {
		t.Fatal("DNS filtering or ordering failed")
	}
	r.ips = nil
	if _, err := c.Execute(context.Background(), rawTemplate(t, goodTemplate())); err != ErrDestination {
		t.Fatal("empty DNS accepted")
	}
}
func TestPinnedDialUsesOnlyValidatedLiteralIPs(t *testing.T) {
	var addresses []string
	dial := pinnedDial("api.example.com", []netip.Addr{netip.MustParseAddr("8.8.8.8"), netip.MustParseAddr("1.1.1.1")}, func(_ context.Context, _, addr string) (net.Conn, error) {
		addresses = append(addresses, addr)
		return nil, errors.New(fakeSecret)
	})
	if _, err := dial(context.Background(), "tcp", "evil.example:443"); err != ErrDestination {
		t.Fatal("host mismatch allowed")
	}
	if len(addresses) != 0 {
		t.Fatal("dialed unapproved host")
	}
	if _, err := dial(context.Background(), "tcp", "api.example.com:443"); err != ErrUpstream {
		t.Fatal("error was not sanitized")
	}
	if !reflect.DeepEqual(addresses, []string{"8.8.8.8:443", "1.1.1.1:443"}) {
		t.Fatal("DNS was not pinned")
	}
}
func TestExecuteDiscardsResponsesAndSuppressesErrors(t *testing.T) {
	c, _, r := testClient(t, policyFixture(), func(req *http.Request) (*http.Response, error) {
		if req.Header.Get("Authorization") != "Bearer "+fakeSecret {
			t.Fatal("secret missing")
		}
		resp := reply(200, fakeSecret)
		resp.Header.Set("X-Secret", fakeSecret)
		return resp, nil
	})
	result, err := c.Execute(context.Background(), rawTemplate(t, goodTemplate()))
	if err != nil || result.StatusCode != 200 || !result.BodyDiscarded || result.Data != nil || r.calls != 1 {
		t.Fatal("default response not discarded")
	}
	out, _ := json.Marshal(result)
	if strings.Contains(string(out), fakeSecret) {
		t.Fatal("secret in result")
	}
	c.transport = func(string, []netip.Addr) http.RoundTripper {
		return roundTripFunc(func(*http.Request) (*http.Response, error) { return nil, errors.New(fakeSecret) })
	}
	if _, err := c.Execute(context.Background(), rawTemplate(t, goodTemplate())); err != ErrUpstream || strings.Contains(err.Error(), fakeSecret) {
		t.Fatal("upstream error leaked")
	}
	c.backend = &fakeBackend{err: errors.New(fakeSecret)}
	if _, err := c.Execute(context.Background(), rawTemplate(t, goodTemplate())); err != ErrSecret {
		t.Fatal("backend error leaked")
	}
}
func TestRedirectsNeverFollowed(t *testing.T) {
	for _, status := range []int{301, 302, 303, 307, 308} {
		calls := 0
		c, _, _ := testClient(t, policyFixture(), func(*http.Request) (*http.Response, error) {
			calls++
			r := reply(status, "")
			r.Header.Set("Location", "https://attacker.example/?key="+url.QueryEscape(fakeSecret))
			return r, nil
		})
		if _, err := c.Execute(context.Background(), rawTemplate(t, goodTemplate())); err != ErrRedirect || calls != 1 {
			t.Fatal("redirect followed")
		}
	}
}
func TestProjectionReturnsOnlyMarketFields(t *testing.T) {
	p := policyFixture()
	v := p.Targets["demo"]
	v.Response = responseFixture()
	p.Targets["demo"] = v
	c, _, _ := testClient(t, p, func(*http.Request) (*http.Response, error) {
		b, _ := json.Marshal(map[string]any{"data": []any{map[string]any{"date": "2026-10-03", "open": 100.25, "close": 101.5, "api_key": fakeSecret}}, "token": fakeSecret})
		return reply(200, string(b)), nil
	})
	result, err := c.Execute(context.Background(), rawTemplate(t, goodTemplate()))
	if err != nil || result.BodyDiscarded {
		t.Fatal(err)
	}
	out, _ := json.Marshal(result)
	text := string(out)
	if strings.Contains(text, "api_key") || strings.Contains(text, "token") || strings.Contains(text, fakeSecret) || !strings.Contains(text, `"close":101.5`) {
		t.Fatal("incorrect projection")
	}
}
func TestProjectionRejectsEchoesMalformedAndLargeData(t *testing.T) {
	p := ResponsePolicy{Fields: map[string]string{"value": "string"}, MaxBytes: 1024, MaxItems: 2}
	for _, value := range []string{fakeSecret, base64.StdEncoding.EncodeToString([]byte(fakeSecret)), url.QueryEscape(fakeSecret)} {
		data, _ := json.Marshal(map[string]string{"value": value})
		if _, err := projectResponse(reply(200, string(data)), p, map[string]string{"demo": fakeSecret}); err != ErrResponse {
			t.Fatal("secret echo accepted")
		}
	}
	for _, body := range []string{`{"value":12}`, `{"value":"a","value":"b"}`, `{"other":"x"}`, strings.Repeat("x", 1025), `[{"value":"a"},{"value":"b"},{"value":"c"}]`} {
		if _, err := projectResponse(reply(200, body), p, nil); err != ErrResponse {
			t.Fatal("malformed response accepted")
		}
	}
	r := reply(200, `{"value":"safe"}`)
	r.Header.Set("Content-Encoding", "gzip")
	if _, err := projectResponse(r, p, nil); err != ErrResponse {
		t.Fatal("compressed response accepted")
	}
}
func TestProjectionRejectsNonSuccessPayload(t *testing.T) {
	p := policyFixture()
	v := p.Targets["demo"]
	v.Response = responseFixture()
	p.Targets["demo"] = v
	c, _, _ := testClient(t, p, func(*http.Request) (*http.Response, error) { return reply(401, fakeSecret), nil })
	r, err := c.Execute(context.Background(), rawTemplate(t, goodTemplate()))
	if err != nil || !r.BodyDiscarded || r.Data != nil {
		t.Fatal("error response not discarded")
	}
}
func TestEnvBackendUsesOnlyBoundedBinding(t *testing.T) {
	t.Setenv("VEILSPLICE_TEST_DEMO_ONLY", "FAKE_TEST_VALUE")
	b := NewEnvBackend(policyFixture())
	v, err := b.Resolve(context.Background(), "demo")
	if err != nil || v != "FAKE_TEST_VALUE" {
		t.Fatal("bound env not read")
	}
	if _, err := b.Resolve(context.Background(), "PATH"); err != ErrSecret {
		t.Fatal("arbitrary env allowed")
	}
}
func FuzzTemplateParser(f *testing.F) {
	f.Add([]byte(`{"target":"demo","json":{"x":"${secret:demo}"}}`))
	f.Add([]byte(`{"target":"demo","target":"other"}`))
	f.Fuzz(func(t *testing.T, b []byte) { _, _ = ParseTemplate(b) })
}
func FuzzExpansion(f *testing.F) {
	f.Add("prefix${secret:demo}suffix")
	f.Add("${secret:")
	f.Fuzz(func(t *testing.T, s string) {
		if len(s) > MaxInputBytes {
			return
		}
		v, err := expFixture("FAKE_TOKEN").expand(s)
		if err == nil && len(v) > maxExpandedBytes {
			t.Fatal("size limit failed")
		}
	})
}
