package auth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const LocalTokenFile = "local-token"

func LocalTokenPath(dataDir string) string { return filepath.Join(dataDir, LocalTokenFile) }

// ReadLocalToken refuses a missing, malformed, or group-readable token file.
func ReadLocalToken(path string) (string, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() || info.Mode().Perm() != 0600 {
		return "", errors.New("local token must be a regular file with mode 0600")
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	token := strings.TrimSpace(string(b))
	decoded, err := hex.DecodeString(token)
	if err != nil || len(decoded) != 32 || len(token) != 64 {
		return "", errors.New("invalid local token")
	}
	return token, nil
}

func randomLocalToken() (string, error) {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}

// EnsureLocalToken creates the token only when absent. Concurrent starts keep
// the first complete file; no caller observes a partially written token.
func EnsureLocalToken(path string) (string, error) {
	if token, err := ReadLocalToken(path); err == nil {
		return token, nil
	} else if !os.IsNotExist(err) {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return "", err
	}
	token, err := randomLocalToken()
	if err != nil {
		return "", err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".local-token-*")
	if err != nil {
		return "", err
	}
	defer os.Remove(f.Name())
	if err = f.Chmod(0600); err != nil {
		f.Close()
		return "", err
	}
	if _, err = f.WriteString(token + "\n"); err != nil {
		f.Close()
		return "", err
	}
	if err = f.Sync(); err != nil {
		f.Close()
		return "", err
	}
	if err = f.Close(); err != nil {
		return "", err
	}
	if err = os.Link(f.Name(), path); os.IsExist(err) {
		return ReadLocalToken(path)
	} else if err != nil {
		return "", err
	}
	return token, nil
}

// RotateLocalToken atomically replaces the file. Readers either see the old
// complete token or the new one.
func RotateLocalToken(path string) (string, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return "", err
	}
	token, err := randomLocalToken()
	if err != nil {
		return "", err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".local-token-*")
	if err != nil {
		return "", err
	}
	defer os.Remove(f.Name())
	if err = f.Chmod(0600); err != nil {
		f.Close()
		return "", err
	}
	if _, err = f.WriteString(token + "\n"); err != nil {
		f.Close()
		return "", err
	}
	if err = f.Sync(); err != nil {
		f.Close()
		return "", err
	}
	if err = f.Close(); err != nil {
		return "", err
	}
	if err = os.Rename(f.Name(), path); err != nil {
		return "", fmt.Errorf("rotate local token: %w", err)
	}
	return token, nil
}

func LocalCookieValue(token string) string {
	mac := hmac.New(sha256.New, []byte(token))
	mac.Write([]byte("faztudo local cookie v1"))
	return hex.EncodeToString(mac.Sum(nil))
}

func EqualSecret(got, want string) bool {
	// Hash both values so comparison time does not depend on their lengths.
	a, b := sha256.Sum256([]byte(got)), sha256.Sum256([]byte(want))
	return hmac.Equal(a[:], b[:]) && len(got) == len(want)
}

// RandomHex returns n random bytes from crypto/rand, hex encoded.
func RandomHex(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}
