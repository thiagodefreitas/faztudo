package auth

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/x509"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/bcrypt"
)

func TestTLSCreatesCAAndServerCertWithExpectedSANsAndModes(t *testing.T) {
	tlsDir := filepath.Join(t.TempDir(), "tls")
	ips := []net.IP{net.ParseIP("192.168.1.25"), net.ParseIP("10.0.0.8")}

	bundle, err := EnsureTLS(tlsDir, "workbox", ips)
	if err != nil {
		t.Fatal(err)
	}
	if !bundle.Regenerated {
		t.Fatal("expected initial generation")
	}

	dirInfo, err := os.Stat(tlsDir)
	if err != nil {
		t.Fatal(err)
	}
	if dirInfo.Mode().Perm() != 0700 {
		t.Fatalf("tls dir mode %04o, want 0700", dirInfo.Mode().Perm())
	}

	for _, name := range []string{"ca.key", "server.key"} {
		fi, err := os.Stat(filepath.Join(tlsDir, name))
		if err != nil {
			t.Fatalf("stat %s: %v", name, err)
		}
		if fi.Mode().Perm() != 0600 {
			t.Fatalf("%s mode %04o, want 0600", name, fi.Mode().Perm())
		}
	}

	// Verify CA properties: ECDSA P-256, ~10 years.
	caPub, ok := bundle.CACert.PublicKey.(*ecdsa.PublicKey)
	if !ok || caPub.Curve != elliptic.P256() {
		t.Fatalf("CA public key is not ECDSA P-256: %T", bundle.CACert.PublicKey)
	}
	if !bundle.CACert.IsCA {
		t.Fatal("CA cert IsCA is false")
	}
	caDuration := bundle.CACert.NotAfter.Sub(bundle.CACert.NotBefore)
	if caDuration < 9*365*24*time.Hour || caDuration > 11*365*24*time.Hour {
		t.Fatalf("CA validity duration %v, want ~10 years", caDuration)
	}

	// Verify Server cert properties: ECDSA P-256, ~1 year, signed by CA.
	srvCert := bundle.ServerX509
	srvPub, ok := srvCert.PublicKey.(*ecdsa.PublicKey)
	if !ok || srvPub.Curve != elliptic.P256() {
		t.Fatalf("server public key is not ECDSA P-256: %T", srvCert.PublicKey)
	}
	if err := srvCert.CheckSignatureFrom(bundle.CACert); err != nil {
		t.Fatalf("server cert not signed by CA: %v", err)
	}
	srvDuration := srvCert.NotAfter.Sub(srvCert.NotBefore)
	if srvDuration < 360*24*time.Hour || srvDuration > 370*24*time.Hour {
		t.Fatalf("server cert validity duration %v, want ~1 year", srvDuration)
	}

	// Verify SANs: hostname, hostname.local, localhost, and every non-loopback interface address.
	for _, wantDNS := range []string{"workbox", "workbox.local", "localhost"} {
		if !slices.Contains(srvCert.DNSNames, wantDNS) {
			t.Fatalf("server cert DNSNames %v missing %q", srvCert.DNSNames, wantDNS)
		}
	}
	gotIPs := make([]string, 0, len(srvCert.IPAddresses))
	for _, ip := range srvCert.IPAddresses {
		gotIPs = append(gotIPs, ip.String())
	}
	for _, wantIP := range []string{"192.168.1.25", "10.0.0.8"} {
		if !slices.Contains(gotIPs, wantIP) {
			t.Fatalf("server cert IPAddresses %v missing %q", gotIPs, wantIP)
		}
	}

	// Second call with the same address set reuses the server cert.
	second, err := EnsureTLS(tlsDir, "workbox", ips)
	if err != nil {
		t.Fatal(err)
	}
	if second.Regenerated {
		t.Fatal("expected server cert reuse when address set is unchanged")
	}
	if second.ServerX509.SerialNumber.Cmp(srvCert.SerialNumber) != 0 {
		t.Fatal("server cert serial changed without address change")
	}

	// When the address set changes, regenerate the server cert while keeping the CA.
	changedIPs := []net.IP{net.ParseIP("192.168.1.25"), net.ParseIP("172.16.0.4")}
	third, err := EnsureTLS(tlsDir, "workbox", changedIPs)
	if err != nil {
		t.Fatal(err)
	}
	if !third.Regenerated {
		t.Fatal("expected server cert regeneration when address set changes")
	}
	if third.Fingerprint != bundle.Fingerprint {
		t.Fatalf("CA fingerprint changed on server cert regen: %s vs %s", third.Fingerprint, bundle.Fingerprint)
	}
	thirdIPs := make([]string, 0, len(third.ServerX509.IPAddresses))
	for _, ip := range third.ServerX509.IPAddresses {
		thirdIPs = append(thirdIPs, ip.String())
	}
	if !slices.Contains(thirdIPs, "172.16.0.4") || slices.Contains(thirdIPs, "10.0.0.8") {
		t.Fatalf("regenerated server cert IPs %v", thirdIPs)
	}

	// Verify x509 verification works against the CA pool for both hostname and IP.
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(third.CACertPEM) {
		t.Fatal("failed to append CA PEM")
	}
	for _, name := range []string{"workbox", "workbox.local", "localhost", "192.168.1.25", "172.16.0.4"} {
		if _, err := third.ServerX509.Verify(x509.VerifyOptions{DNSName: name, Roots: pool}); err != nil {
			t.Fatalf("verify %s failed: %v", name, err)
		}
	}
}

func TestCAHelperServesOnlyPageAndCert(t *testing.T) {
	tlsDir := filepath.Join(t.TempDir(), "tls")
	bundle, err := EnsureTLS(tlsDir, "workbox", []net.IP{net.ParseIP("192.168.1.25")})
	if err != nil {
		t.Fatal(err)
	}
	h := CAHelperHandler(bundle.CACertPEM, bundle.Fingerprint)

	// GET / serves page with link to /ca.crt and the SHA-256 fingerprint.
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /: status %d", rec.Code)
	}
	body := rec.Body.String()
	if !strings.Contains(body, "/ca.crt") || !strings.Contains(body, bundle.Fingerprint) {
		t.Fatalf("GET / missing ca.crt link or fingerprint: %s", body)
	}

	// GET /ca.crt serves the CA PEM.
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/ca.crt", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /ca.crt: status %d", rec.Code)
	}
	gotPEM, _ := io.ReadAll(rec.Body)
	if string(gotPEM) != string(bundle.CACertPEM) {
		t.Fatal("GET /ca.crt body mismatch")
	}

	// Everything else is refused with 404.
	for _, tc := range []struct{ method, path string }{
		{"GET", "/api/v1/me"},
		{"GET", "/api/v1/health"},
		{"POST", "/"},
		{"POST", "/ca.crt"},
		{"GET", "/other"},
	} {
		rec = httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(tc.method, tc.path, nil))
		if rec.Code != http.StatusNotFound {
			t.Fatalf("%s %s: status %d, want 404", tc.method, tc.path, rec.Code)
		}
	}
}

func TestPasswordHashAndTokensAndRateLimit(t *testing.T) {
	hash, err := HashPassword("correct-horse-battery-staple")
	if err != nil {
		t.Fatal(err)
	}
	cost, err := bcrypt.Cost(hash)
	if err != nil || cost != 12 {
		t.Fatalf("bcrypt cost %d (%v), want 12", cost, err)
	}
	if !CheckPassword(hash, "correct-horse-battery-staple") {
		t.Fatal("CheckPassword failed for matching password")
	}
	if CheckPassword(hash, "wrong-password") {
		t.Fatal("CheckPassword succeeded for wrong password")
	}

	sessTok, err := NewSessionToken()
	if err != nil || len(sessTok) != 64 {
		t.Fatalf("session token len %d err %v", len(sessTok), err)
	}
	pairTok, err := NewPairingToken()
	if err != nil || len(pairTok) != 32 {
		t.Fatalf("pairing token len %d err %v", len(pairTok), err)
	}

	svg, err := RenderQRSVG("https://192.168.1.25:7458/pair#" + pairTok)
	if err != nil || !strings.HasPrefix(svg, "<svg ") || !strings.HasSuffix(svg, "</svg>") {
		t.Fatalf("invalid QR SVG: %v %q", err, svg)
	}

	now := time.Date(2026, 10, 18, 12, 0, 0, 0, time.UTC)
	limiter := NewLoginRateLimiter()
	limiter.Now = func() time.Time { return now }
	for i := range 5 {
		if !limiter.Attempt("192.168.1.50:54321") {
			t.Fatalf("attempt %d should be allowed", i+1)
		}
	}
	if limiter.Attempt("192.168.1.50:11111") {
		t.Fatal("6th attempt from same IP should be rate limited")
	}
	if !limiter.Attempt("192.168.1.51:54321") {
		t.Fatal("another IP should not be rate limited")
	}
	now = now.Add(15*time.Minute + time.Second)
	if !limiter.Attempt("192.168.1.50:54321") {
		t.Fatal("rate limit should expire after 15 minutes")
	}
	limiter.Forget("192.168.1.50:1")
	for i := range 5 {
		if !limiter.Attempt("192.168.1.50:2") {
			t.Fatalf("attempt %d after Forget should be allowed", i+1)
		}
	}
}

// Finding 5: every check runs a bcrypt comparison, so an unset or empty
// password cannot be told apart by timing.
func TestCheckPasswordAlwaysRunsComparison(t *testing.T) {
	calls := 0
	orig := compareHash
	compareHash = func(h, p []byte) error { calls++; return orig(h, p) }
	t.Cleanup(func() { compareHash = orig })

	hash, err := HashPassword("correct-horse")
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name string
		hash []byte
		pw   string
		want bool
	}{
		{"no hash", nil, "anything", false},
		{"no hash empty pw", nil, "", false},
		{"empty pw", hash, "", false},
		{"wrong pw", hash, "wrong", false},
		{"right pw", hash, "correct-horse", true},
	}
	for _, tc := range cases {
		calls = 0
		if got := CheckPassword(tc.hash, tc.pw); got != tc.want {
			t.Fatalf("%s: got %t, want %t", tc.name, got, tc.want)
		}
		if calls != 1 {
			t.Fatalf("%s: bcrypt comparison ran %d times, want 1", tc.name, calls)
		}
	}
	if cost, err := bcrypt.Cost([]byte(dummyHash)); err != nil || cost != BcryptCost {
		t.Fatalf("dummy hash cost %d (%v), want %d", cost, err, BcryptCost)
	}
}
