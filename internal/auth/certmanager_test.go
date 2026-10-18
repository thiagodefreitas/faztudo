package auth

import (
	"crypto/tls"
	"net"
	"testing"
)

type localAddrConn struct {
	net.Conn
	local net.Addr
}

func (c localAddrConn) LocalAddr() net.Addr { return c.local }

func helloTo(ip string) *tls.ClientHelloInfo {
	return &tls.ClientHelloInfo{Conn: localAddrConn{local: &net.TCPAddr{IP: net.ParseIP(ip), Port: 7458}}}
}

func coversIP(cert *tls.Certificate, ip string) bool {
	return containsIP(cert.Leaf.IPAddresses, net.ParseIP(ip))
}

func TestCertManagerReissuesForAddressGainedAfterStart(t *testing.T) {
	// At boot only a link-local address exists; Wi-Fi comes up later.
	current := []net.IP{net.ParseIP("fe80::1")}
	m, err := NewCertManager(t.TempDir(), func() (string, []net.IP, error) { return "pc", current, nil })
	if err != nil {
		t.Fatal(err)
	}
	current = append(current, net.ParseIP("192.168.50.7"))

	// A dual-stack listener reports the IPv4-in-IPv6 form.
	cert, err := m.GetCertificate(helloTo("::ffff:192.168.50.7"))
	if err != nil {
		t.Fatal(err)
	}
	if !coversIP(cert, "192.168.50.7") {
		t.Fatalf("certificate does not cover the new address: %v", cert.Leaf.IPAddresses)
	}
	if !m.Bundle().ServerX509.Equal(cert.Leaf) {
		t.Fatal("bundle not updated to the reissued certificate")
	}
}

func TestCertManagerDoesNotSignAddressesItDoesNotHave(t *testing.T) {
	m, err := NewCertManager(t.TempDir(), func() (string, []net.IP, error) {
		return "pc", []net.IP{net.ParseIP("192.168.50.7")}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	before := m.Bundle().ServerX509
	cert, err := m.GetCertificate(helloTo("203.0.113.9"))
	if err != nil {
		t.Fatal(err)
	}
	if coversIP(cert, "203.0.113.9") || !m.Bundle().ServerX509.Equal(before) {
		t.Fatal("reissued for an address the machine does not have")
	}
}

func TestInterfaceRankPutsVirtualLast(t *testing.T) {
	for name, want := range map[string]int{
		"wlp4s0": 0, "enp3s0": 0, "eth0": 0,
		"docker0": 1, "br-0a1b2c3d4e5f": 1, "vmnet8": 1, "tailscale0": 1, "wg0": 1, "veth12ab": 1,
	} {
		if got := interfaceRank(name); got != want {
			t.Errorf("interfaceRank(%q) = %d, want %d", name, got, want)
		}
	}
}
