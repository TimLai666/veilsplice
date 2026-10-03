package proxy

import (
	"context"
	"crypto/tls"
	"net"
	"net/http"
	"net/netip"
	"time"
)

type resolver interface {
	LookupNetIP(context.Context, string, string) ([]netip.Addr, error)
}
type dialFunc func(context.Context, string, string) (net.Conn, error)

// Conservative denylist includes non-public ranges, transition networks and
// known public-address cloud platform endpoints. Public != safe: policy owners
// must still trust the named service, its DNS, routing and TLS trust roots.
var blockedPrefixes = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"), netip.MustParsePrefix("10.0.0.0/8"),
	netip.MustParsePrefix("100.64.0.0/10"), netip.MustParsePrefix("127.0.0.0/8"),
	netip.MustParsePrefix("169.254.0.0/16"), netip.MustParsePrefix("172.16.0.0/12"),
	netip.MustParsePrefix("192.0.0.0/24"), netip.MustParsePrefix("192.0.2.0/24"),
	netip.MustParsePrefix("192.88.99.0/24"), netip.MustParsePrefix("192.168.0.0/16"),
	netip.MustParsePrefix("198.18.0.0/15"), netip.MustParsePrefix("198.51.100.0/24"),
	netip.MustParsePrefix("203.0.113.0/24"), netip.MustParsePrefix("224.0.0.0/4"),
	netip.MustParsePrefix("240.0.0.0/4"), netip.MustParsePrefix("168.63.129.16/32"),
	netip.MustParsePrefix("2001::/23"), netip.MustParsePrefix("2001:db8::/32"),
	netip.MustParsePrefix("2002::/16"), netip.MustParsePrefix("3fff::/20"),
}

func publicIP(ip netip.Addr) bool {
	if !ip.IsValid() || ip.Zone() != "" {
		return false
	}
	ip = ip.Unmap()
	if !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
		return false
	}
	if ip.Is6() && !netip.MustParsePrefix("2000::/3").Contains(ip) {
		return false
	}
	for _, p := range blockedPrefixes {
		if p.Contains(ip) {
			return false
		}
	}
	return true
}

func resolvePublic(ctx context.Context, r resolver, host string) ([]netip.Addr, error) {
	ips, err := r.LookupNetIP(ctx, "ip", host)
	if err != nil || len(ips) == 0 || len(ips) > 32 {
		return nil, ErrDestination
	}
	for _, ip := range ips {
		if !publicIP(ip) {
			return nil, ErrDestination
		}
	}
	return ips, nil
}

// Addresses are resolved exactly once, all checked, then dialed as literal IPs.
// There is no second DNS lookup between validation and connecting.
func pinnedDial(host string, ips []netip.Addr, dial dialFunc) dialFunc {
	return func(ctx context.Context, network, address string) (net.Conn, error) {
		if network != "tcp" || address != net.JoinHostPort(host, "443") {
			return nil, ErrDestination
		}
		for _, ip := range ips {
			if !publicIP(ip) {
				return nil, ErrDestination
			}
			conn, err := dial(ctx, "tcp", net.JoinHostPort(ip.String(), "443"))
			if err == nil {
				return conn, nil
			}
		}
		return nil, ErrUpstream
	}
}

func secureTransport(host string, ips []netip.Addr) *http.Transport {
	dialer := &net.Dialer{Timeout: 5 * time.Second}
	return &http.Transport{
		Proxy:                  nil, // Never honor HTTP_PROXY / HTTPS_PROXY / ALL_PROXY.
		DialContext:            pinnedDial(host, ips, dialer.DialContext),
		TLSClientConfig:        &tls.Config{MinVersion: tls.VersionTLS12, ServerName: host},
		TLSHandshakeTimeout:    5 * time.Second,
		ResponseHeaderTimeout:  10 * time.Second,
		MaxResponseHeaderBytes: 64 << 10,
		DisableKeepAlives:      true,
		DisableCompression:     true,
		ForceAttemptHTTP2:      false,
	}
}
