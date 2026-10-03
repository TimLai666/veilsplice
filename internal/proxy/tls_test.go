package proxy

import (
	"bufio"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"math/big"
	"net"
	"net/http"
	"net/netip"
	"testing"
	"time"
)

// Full TLS + HTTP round trip over an in-memory pipe; no listening socket or
// external service is started. Test credentials/certificate exist in memory only.
func TestTransportTLSWithPinnedIP(t *testing.T) {
	for _, trusted := range []bool{true, false} {
		t.Run(map[bool]string{true: "trusted", false: "untrusted"}[trusted], func(t *testing.T) {
			key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
			if err != nil {
				t.Fatal(err)
			}
			tmpl := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "api.example.com"}, DNSNames: []string{"api.example.com"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
			der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
			if err != nil {
				t.Fatal(err)
			}
			cert, err := x509.ParseCertificate(der)
			if err != nil {
				t.Fatal(err)
			}
			tr := secureTransport("api.example.com", []netip.Addr{netip.MustParseAddr("8.8.8.8")})
			if tr.Proxy != nil || tr.TLSClientConfig.InsecureSkipVerify || tr.TLSClientConfig.MinVersion < tls.VersionTLS12 {
				t.Fatal("unsafe transport defaults")
			}
			tr.TLSClientConfig.RootCAs = x509.NewCertPool()
			if trusted {
				tr.TLSClientConfig.RootCAs.AddCert(cert)
			}
			done := make(chan error, 1)
			tr.DialContext = pinnedDial("api.example.com", []netip.Addr{netip.MustParseAddr("8.8.8.8")}, func(_ context.Context, network, address string) (net.Conn, error) {
				if network != "tcp" || address != "8.8.8.8:443" {
					t.Error("not pinned")
				}
				client, server := net.Pipe()
				go func() {
					s := tls.Server(server, &tls.Config{Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: key}}, MinVersion: tls.VersionTLS12})
					defer s.Close()
					_ = s.SetDeadline(time.Now().Add(5 * time.Second))
					if err := s.Handshake(); err != nil {
						done <- err
						return
					}
					req, err := http.ReadRequest(bufio.NewReader(s))
					if err != nil {
						done <- err
						return
					}
					req.Body.Close()
					_, err = s.Write([]byte("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{}"))
					done <- err
				}()
				return client, nil
			})
			defer tr.CloseIdleConnections()
			client := http.Client{Transport: tr, Timeout: 6 * time.Second}
			resp, err := client.Get("https://api.example.com/v1/quotes")
			if trusted {
				if err != nil {
					t.Fatal(err)
				}
				resp.Body.Close()
				if resp.StatusCode != 200 {
					t.Fatal("wrong status")
				}
			} else if err == nil {
				resp.Body.Close()
				t.Fatal("untrusted cert accepted")
			}
			<-done
		})
	}
}
