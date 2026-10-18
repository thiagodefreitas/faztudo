package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/bcrypt"
)

const BcryptCost = 12

// compareHash is bcrypt's comparison; tests replace it to count calls.
var compareHash = bcrypt.CompareHashAndPassword

// HashPassword hashes a plaintext password with bcrypt at cost 12.
func HashPassword(password string) ([]byte, error) {
	if strings.TrimSpace(password) == "" {
		return nil, errors.New("password must not be empty")
	}
	return bcrypt.GenerateFromPassword([]byte(password), BcryptCost)
}

// dummyHash is a valid cost-12 bcrypt hash of a password nobody knows. It is
// compared against when no password is set so that an unset password costs
// the same time as a wrong one.
const dummyHash = "$2a$12$nSQUiT8ya5/PdRVWFkh3dOUN0M7Hm84..p3DX/81vPQBnSKqlgZUy"

// CheckPassword reports whether password matches the bcrypt hash. A bcrypt
// comparison always runs: against a fixed dummy hash when hash is empty, and
// for an empty password too, so timing does not reveal either condition.
func CheckPassword(hash []byte, password string) bool {
	unset := len(hash) == 0
	if unset {
		hash = []byte(dummyHash)
	}
	err := compareHash(hash, []byte(password))
	return err == nil && !unset && password != ""
}

// NewSessionToken returns a random 32-byte token encoded as 64 hex characters.
func NewSessionToken() (string, error) {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}

// NewPairingToken returns a random 128-bit (16-byte) token encoded as 32 hex characters.
func NewPairingToken() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}

// HashToken returns the lowercase hex SHA-256 digest of a token.
func HashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

const (
	rateLimitMaxFailures = 5
	rateLimitWindow      = 15 * time.Minute
)

// LoginRateLimiter enforces at most 5 login attempts that do not end in success per 15 minutes per remote IP.
type LoginRateLimiter struct {
	Now      func() time.Time
	mu       sync.Mutex
	failures map[string][]time.Time
}

func NewLoginRateLimiter() *LoginRateLimiter {
	return &LoginRateLimiter{
		Now:      time.Now,
		failures: map[string][]time.Time{},
	}
}

// remoteKey reduces a remote address to one canonical host string so that
// textual aliases (IPv6 spellings, IPv4-mapped IPv6, ports) share a bucket.
func remoteKey(remoteAddr string) string {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		host = strings.TrimSpace(remoteAddr)
	}
	host = strings.Trim(host, "[]")
	if i := strings.IndexByte(host, '%'); i >= 0 {
		host = host[:i]
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return host
	}
	if v4 := ip.To4(); v4 != nil {
		return v4.String()
	}
	return ip.String()
}

func (l *LoginRateLimiter) prune(key string, now time.Time) []time.Time {
	cutoff := now.Add(-rateLimitWindow)
	list := l.failures[key]
	kept := list[:0]
	for _, t := range list {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	if len(kept) == 0 {
		delete(l.failures, key)
		return nil
	}
	l.failures[key] = kept
	return kept
}

// Attempt records a login attempt for remoteAddr and reports whether it may
// proceed. Pruning, the limit check and the recording happen under one lock,
// and callers invoke it before the slow password check, so a burst of
// parallel requests cannot all observe an empty window.
func (l *LoginRateLimiter) Attempt(remoteAddr string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.Now()
	key := remoteKey(remoteAddr)
	kept := l.prune(key, now)
	if len(kept) >= rateLimitMaxFailures {
		return false
	}
	l.failures[key] = append(kept, now)
	return true
}

// Forget clears the recorded attempts for remoteAddr. Login calls it after a
// correct password so a legitimate user is not locked out by earlier typos.
func (l *LoginRateLimiter) Forget(remoteAddr string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.failures, remoteKey(remoteAddr))
}
