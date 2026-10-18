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

// HashPassword hashes a plaintext password with bcrypt at cost 12.
func HashPassword(password string) ([]byte, error) {
	if strings.TrimSpace(password) == "" {
		return nil, errors.New("password must not be empty")
	}
	return bcrypt.GenerateFromPassword([]byte(password), BcryptCost)
}

// CheckPassword reports whether password matches the bcrypt hash.
func CheckPassword(hash []byte, password string) bool {
	if len(hash) == 0 || password == "" {
		return false
	}
	return bcrypt.CompareHashAndPassword(hash, []byte(password)) == nil
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

// LoginRateLimiter enforces at most 5 failed login attempts per 15 minutes per remote IP.
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

func remoteKey(remoteAddr string) string {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		return strings.TrimSpace(remoteAddr)
	}
	return host
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

func (l *LoginRateLimiter) Allowed(remoteAddr string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.Now()
	key := remoteKey(remoteAddr)
	return len(l.prune(key, now)) < rateLimitMaxFailures
}

func (l *LoginRateLimiter) RecordFailure(remoteAddr string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.Now()
	key := remoteKey(remoteAddr)
	kept := l.prune(key, now)
	l.failures[key] = append(kept, now)
}
