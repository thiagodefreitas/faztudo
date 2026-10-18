package auth

import (
	"crypto/tls"
	"net"
	"sync"
)

// CertManager serves the LAN server certificate and reissues it, signed by
// the same local CA, when a client connects to an address the current
// certificate does not cover. faztudo often starts before the network is up
// (at boot, as a user service), so the addresses known at startup can miss
// the Wi-Fi address entirely. Phones trust the CA, not the server
// certificate, so a reissue needs nothing from them.
type CertManager struct {
	dir   string
	addrs func() (string, []net.IP, error)

	mu     sync.Mutex
	bundle *TLSBundle
}

// NewCertManager loads or creates the CA and server certificate in dir.
// addrs reports the machine's current hostname and addresses; pass
// DefaultHostAndIPs outside tests.
func NewCertManager(dir string, addrs func() (string, []net.IP, error)) (*CertManager, error) {
	host, ips, err := addrs()
	if err != nil {
		return nil, err
	}
	bundle, err := EnsureTLS(dir, host, ips)
	if err != nil {
		return nil, err
	}
	return &CertManager{dir: dir, addrs: addrs, bundle: bundle}, nil
}

// Bundle returns the current certificates.
func (m *CertManager) Bundle() *TLSBundle {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.bundle
}

// GetCertificate is a tls.Config.GetCertificate callback. It reissues only for
// an address this machine really has, so a client cannot make faztudo sign
// arbitrary addresses.
func (m *CertManager) GetCertificate(hello *tls.ClientHelloInfo) (*tls.Certificate, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	local := localIP(hello)
	if local == nil || containsIP(m.bundle.ServerX509.IPAddresses, local) {
		return &m.bundle.ServerCert, nil
	}
	host, ips, err := m.addrs()
	if err != nil || !containsIP(ips, local) {
		return &m.bundle.ServerCert, nil
	}
	bundle, err := EnsureTLS(m.dir, host, ips)
	if err != nil {
		return &m.bundle.ServerCert, nil
	}
	m.bundle = bundle
	return &bundle.ServerCert, nil
}

func localIP(hello *tls.ClientHelloInfo) net.IP {
	if hello == nil || hello.Conn == nil {
		return nil
	}
	addr, ok := hello.Conn.LocalAddr().(*net.TCPAddr)
	if !ok || addr.IP.IsLoopback() || addr.IP.IsUnspecified() {
		return nil
	}
	return addr.IP
}

// containsIP compares with net.IP.Equal, so an IPv4 address matches its
// IPv4-in-IPv6 form (what a dual-stack [::] listener reports).
func containsIP(list []net.IP, ip net.IP) bool {
	for _, item := range list {
		if item.Equal(ip) {
			return true
		}
	}
	return false
}
