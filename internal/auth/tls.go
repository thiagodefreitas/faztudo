// Package auth implements LAN TLS certificates, password hashing, session
// tokens, QR pairing rendering, and login rate limiting.
package auth

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"fmt"
	"html"
	"math/big"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

type TLSBundle struct {
	CACert      *x509.Certificate
	CACertPEM   []byte
	ServerX509  *x509.Certificate
	ServerCert  tls.Certificate
	Fingerprint string
	Regenerated bool
}

// DefaultHostAndIPs returns the machine hostname and all non-loopback
// interface IP addresses, physical interfaces first. Container bridges, VM
// networks and VPN tunnels come last, so the first LAN URL (the one the
// pairing QR code uses) is the address a phone on the same Wi-Fi can reach.
func DefaultHostAndIPs() (string, []net.IP, error) {
	hostname, _ := os.Hostname()
	ifaces, err := net.Interfaces()
	if err != nil {
		return hostname, nil, err
	}
	type ranked struct {
		ip   net.IP
		rank int
	}
	var found []ranked
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, a := range addrs {
			var ip net.IP
			switch v := a.(type) {
			case *net.IPNet:
				ip = v.IP
			case *net.IPAddr:
				ip = v.IP
			}
			if ip == nil || ip.IsLoopback() || ip.IsUnspecified() || ip.IsMulticast() {
				continue
			}
			found = append(found, ranked{ip, addressRank(iface.Name, ip)})
		}
	}
	slices.SortStableFunc(found, func(a, b ranked) int { return a.rank - b.rank })
	ips := make([]net.IP, 0, len(found))
	for _, f := range found {
		ips = append(ips, f.ip)
	}
	return hostname, ips, nil
}

// virtualInterfacePrefixes name interfaces a phone on the home network cannot
// reach directly: container bridges, VM networks and VPN tunnels.
var virtualInterfacePrefixes = []string{
	"docker", "br-", "veth", "virbr", "vmnet", "vboxnet", "lxc", "lxd", "cni", "flannel", "podman",
	"tailscale", "wg", "tun", "tap", "zt", "utun",
}

// addressRank orders reachable addresses first: physical IPv4, physical
// global IPv6, then the same on virtual interfaces, and link-local last
// (a link-local address is all Wi-Fi has before DHCP answers).
func addressRank(iface string, ip net.IP) int {
	rank := interfaceRank(iface) * 10
	switch {
	case ip.IsLinkLocalUnicast():
		rank += 100
	case ip.To4() == nil:
		rank += 1
	}
	return rank
}

// interfaceRank orders physical interfaces (0) before virtual ones (1).
func interfaceRank(name string) int {
	for _, prefix := range virtualInterfacePrefixes {
		if strings.HasPrefix(name, prefix) {
			return 1
		}
	}
	return 0
}

// SANs returns the deduplicated DNS names and IP addresses for the LAN server certificate.
func SANs(hostname string, ips []net.IP) ([]string, []net.IP) {
	hostname = strings.TrimSuffix(strings.TrimSpace(hostname), ".")
	dnsSet := map[string]bool{"localhost": true}
	if hostname != "" && !strings.EqualFold(hostname, "localhost") {
		bare := strings.TrimSuffix(hostname, ".local")
		if bare != "" {
			dnsSet[bare] = true
			dnsSet[bare+".local"] = true
		}
		dnsSet[hostname] = true
	}
	dnsNames := make([]string, 0, len(dnsSet))
	for name := range dnsSet {
		dnsNames = append(dnsNames, name)
	}
	slices.Sort(dnsNames)

	ipMap := map[string]net.IP{}
	for _, ip := range ips {
		if ip == nil || ip.IsLoopback() || ip.IsUnspecified() || ip.IsMulticast() {
			continue
		}
		if v4 := ip.To4(); v4 != nil {
			ip = v4
		}
		ipMap[ip.String()] = ip
	}
	keys := make([]string, 0, len(ipMap))
	for k := range ipMap {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	outIPs := make([]net.IP, 0, len(keys))
	for _, k := range keys {
		outIPs = append(outIPs, ipMap[k])
	}
	return dnsNames, outIPs
}

// EnsureTLS creates or loads the local CA (ECDSA P-256, 10 years) and server
// certificate (ECDSA P-256, 1 year) in tlsDir (mode 0700, keys 0600),
// regenerating the server certificate when the SAN set changes.
func EnsureTLS(tlsDir string, hostname string, ips []net.IP) (*TLSBundle, error) {
	if err := os.MkdirAll(tlsDir, 0700); err != nil {
		return nil, err
	}
	if err := os.Chmod(tlsDir, 0700); err != nil {
		return nil, err
	}

	caCertPath := filepath.Join(tlsDir, "ca.crt")
	caKeyPath := filepath.Join(tlsDir, "ca.key")
	caCert, caKey, caPEM, err := loadOrCreateCA(caCertPath, caKeyPath)
	if err != nil {
		return nil, err
	}

	wantDNS, wantIPs := SANs(hostname, ips)
	srvCertPath := filepath.Join(tlsDir, "server.crt")
	srvKeyPath := filepath.Join(tlsDir, "server.key")

	srvX509, srvTLSCert, regen, err := loadOrCreateServerCert(srvCertPath, srvKeyPath, caCert, caKey, hostname, wantDNS, wantIPs)
	if err != nil {
		return nil, err
	}

	return &TLSBundle{
		CACert:      caCert,
		CACertPEM:   caPEM,
		ServerX509:  srvX509,
		ServerCert:  srvTLSCert,
		Fingerprint: Fingerprint(caCert),
		Regenerated: regen,
	}, nil
}

// Fingerprint returns the colon-separated uppercase SHA-256 fingerprint of a certificate.
func Fingerprint(cert *x509.Certificate) string {
	sum := sha256.Sum256(cert.Raw)
	parts := make([]string, len(sum))
	for i, b := range sum {
		parts[i] = fmt.Sprintf("%02X", b)
	}
	return strings.Join(parts, ":")
}

func loadOrCreateCA(certPath, keyPath string) (*x509.Certificate, *ecdsa.PrivateKey, []byte, error) {
	certPEM, certErr := os.ReadFile(certPath)
	keyPEM, keyErr := os.ReadFile(keyPath)
	if certErr == nil && keyErr == nil {
		cert, key, err := parseCertAndKey(certPEM, keyPEM)
		if err == nil && time.Now().Add(24*time.Hour).Before(cert.NotAfter) && cert.IsCA {
			if err := os.Chmod(keyPath, 0600); err != nil {
				return nil, nil, nil, err
			}
			return cert, key, certPEM, nil
		}
	}

	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, nil, nil, err
	}
	serial, err := randomSerial()
	if err != nil {
		return nil, nil, nil, err
	}
	now := time.Now().UTC()
	tmpl := &x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{Organization: []string{"faztudo"}, CommonName: "faztudo Local CA"},
		NotBefore:             now.Add(-5 * time.Minute),
		NotAfter:              now.AddDate(10, 0, 0),
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
		BasicConstraintsValid: true,
		IsCA:                  true,
		MaxPathLen:            0,
		MaxPathLenZero:        true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &priv.PublicKey, priv)
	if err != nil {
		return nil, nil, nil, err
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		return nil, nil, nil, err
	}
	certPEM = pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyDER, err := x509.MarshalECPrivateKey(priv)
	if err != nil {
		return nil, nil, nil, err
	}
	keyPEM = pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})

	if err := writePrivateFile(certPath, certPEM, 0644); err != nil {
		return nil, nil, nil, err
	}
	if err := writePrivateFile(keyPath, keyPEM, 0600); err != nil {
		return nil, nil, nil, err
	}
	return cert, priv, certPEM, nil
}

func loadOrCreateServerCert(certPath, keyPath string, caCert *x509.Certificate, caKey *ecdsa.PrivateKey, hostname string, wantDNS []string, wantIPs []net.IP) (*x509.Certificate, tls.Certificate, bool, error) {
	certPEM, certErr := os.ReadFile(certPath)
	keyPEM, keyErr := os.ReadFile(keyPath)
	if certErr == nil && keyErr == nil {
		cert, _, err := parseCertAndKey(certPEM, keyPEM)
		if err == nil &&
			cert.CheckSignatureFrom(caCert) == nil &&
			time.Now().Add(24*time.Hour).Before(cert.NotAfter) &&
			sameSANs(cert, wantDNS, wantIPs) {
			if err := os.Chmod(keyPath, 0600); err != nil {
				return nil, tls.Certificate{}, false, err
			}
			tlsCert, err := tls.X509KeyPair(certPEM, keyPEM)
			if err == nil {
				return cert, tlsCert, false, nil
			}
		}
	}

	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, tls.Certificate{}, false, err
	}
	serial, err := randomSerial()
	if err != nil {
		return nil, tls.Certificate{}, false, err
	}
	cn := strings.TrimSpace(hostname)
	if cn == "" {
		cn = "faztudo"
	}
	now := time.Now().UTC()
	tmpl := &x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{Organization: []string{"faztudo"}, CommonName: cn},
		NotBefore:    now.Add(-5 * time.Minute),
		NotAfter:     now.AddDate(1, 0, 0),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames:     wantDNS,
		IPAddresses:  wantIPs,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, caCert, &priv.PublicKey, caKey)
	if err != nil {
		return nil, tls.Certificate{}, false, err
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		return nil, tls.Certificate{}, false, err
	}
	certPEM = pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyDER, err := x509.MarshalECPrivateKey(priv)
	if err != nil {
		return nil, tls.Certificate{}, false, err
	}
	keyPEM = pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})

	if err := writePrivateFile(certPath, certPEM, 0644); err != nil {
		return nil, tls.Certificate{}, false, err
	}
	if err := writePrivateFile(keyPath, keyPEM, 0600); err != nil {
		return nil, tls.Certificate{}, false, err
	}
	tlsCert, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		return nil, tls.Certificate{}, false, err
	}
	return cert, tlsCert, true, nil
}

func sameSANs(cert *x509.Certificate, wantDNS []string, wantIPs []net.IP) bool {
	gotDNS := slices.Clone(cert.DNSNames)
	slices.Sort(gotDNS)
	if !slices.Equal(gotDNS, wantDNS) {
		return false
	}
	gotIPStr := make([]string, 0, len(cert.IPAddresses))
	for _, ip := range cert.IPAddresses {
		if v4 := ip.To4(); v4 != nil {
			ip = v4
		}
		gotIPStr = append(gotIPStr, ip.String())
	}
	slices.Sort(gotIPStr)
	wantIPStr := make([]string, 0, len(wantIPs))
	for _, ip := range wantIPs {
		if v4 := ip.To4(); v4 != nil {
			ip = v4
		}
		wantIPStr = append(wantIPStr, ip.String())
	}
	slices.Sort(wantIPStr)
	return slices.Equal(gotIPStr, wantIPStr)
}

func parseCertAndKey(certPEM, keyPEM []byte) (*x509.Certificate, *ecdsa.PrivateKey, error) {
	cBlock, _ := pem.Decode(certPEM)
	if cBlock == nil {
		return nil, nil, errors.New("invalid cert pem")
	}
	cert, err := x509.ParseCertificate(cBlock.Bytes)
	if err != nil {
		return nil, nil, err
	}
	kBlock, _ := pem.Decode(keyPEM)
	if kBlock == nil {
		return nil, nil, errors.New("invalid key pem")
	}
	key, err := x509.ParseECPrivateKey(kBlock.Bytes)
	if err != nil {
		return nil, nil, err
	}
	return cert, key, nil
}

func randomSerial() (*big.Int, error) {
	limit := new(big.Int).Lsh(big.NewInt(1), 128)
	return rand.Int(rand.Reader, limit)
}

func writePrivateFile(path string, data []byte, mode os.FileMode) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Chmod(path, mode)
}

// LANURLs returns the https://<ip>:<port> URLs for the given addresses in
// their order (DefaultHostAndIPs puts the reachable ones first), after the
// listen address itself when that is a specific IP. Loopback and link-local
// addresses are dropped: a phone cannot use them in a URL.
func LANURLs(ips []net.IP, listenAddr string) []string {
	host, port, err := net.SplitHostPort(listenAddr)
	if err != nil || port == "" {
		port = "7458"
	}
	var urls []string
	seen := map[string]bool{}
	add := func(ip net.IP) {
		if ip == nil || ip.IsLoopback() || ip.IsUnspecified() || ip.IsMulticast() || ip.IsLinkLocalMulticast() || ip.IsLinkLocalUnicast() {
			return
		}
		if ip4 := ip.To4(); ip4 != nil {
			ip = ip4
		}
		u := "https://" + net.JoinHostPort(ip.String(), port)
		if !seen[u] {
			seen[u] = true
			urls = append(urls, u)
		}
	}
	if parsed := net.ParseIP(strings.Trim(host, "[]")); parsed != nil {
		add(parsed)
	}
	for _, ip := range ips {
		add(ip)
	}
	return urls
}

// CAHelperHandler returns an HTTP handler for port 7459 that serves ONLY a page
// with the CA download link and its SHA-256 fingerprint, plus GET /ca.crt.
func CAHelperHandler(caPEM []byte, fingerprint string) http.Handler {
	escapedFP := html.EscapeString(fingerprint)
	page := `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>faztudo Local CA</title>
<style>
body { font-family: system-ui, -apple-system, sans-serif; max-width: 36rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; color: #1c1b17; background: #f3f1eb; }
a.button { display: inline-block; margin: 1rem 0; padding: 0.75rem 1.25rem; background: #0e7c74; color: #fffcf7; text-decoration: none; border-radius: 0.375rem; font-weight: 600; }
pre { background: #efece4; padding: 0.75rem; border-radius: 0.375rem; overflow-x: auto; font-size: 0.85rem; word-break: break-all; white-space: pre-wrap; }
</style>
</head>
<body>
<h1>faztudo Local CA</h1>
<p>Install this certificate authority on your phone so it trusts your machine's HTTPS connection on the local network.</p>
<p><a class="button" href="/ca.crt">Download CA certificate (ca.crt)</a></p>
<h2>SHA-256 fingerprint</h2>
<p>Compare this fingerprint with the one shown in faztudo on your desktop before trusting the certificate:</p>
<pre><code>` + escapedFP + `</code></pre>
</body>
</html>`

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.NotFound(w, r)
			return
		}
		switch r.URL.Path {
		case "/", "/index.html":
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.WriteHeader(http.StatusOK)
			if r.Method == http.MethodGet {
				_, _ = w.Write([]byte(page))
			}
		case "/ca.crt":
			w.Header().Set("Content-Type", "application/x-x509-ca-cert")
			w.Header().Set("Content-Disposition", `attachment; filename="faztudo-ca.crt"`)
			w.WriteHeader(http.StatusOK)
			if r.Method == http.MethodGet {
				_, _ = w.Write(caPEM)
			}
		default:
			http.NotFound(w, r)
		}
	})
}
