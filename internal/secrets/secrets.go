package secrets

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"

	"github.com/zalando/go-keyring"
)

var keyringGet = keyring.Get
var keyringSet = keyring.Set

type Store struct{ service, path string }

func New(service, path string) *Store { return &Store{service, path} }
func (s *Store) Get(key string) (string, error) {
	if v, err := keyringGet(s.service, key); err == nil {
		return v, nil
	}
	m, err := s.read()
	if err != nil {
		return "", err
	}
	v, ok := m[key]
	if !ok {
		return "", os.ErrNotExist
	}
	return v, nil
}
func (s *Store) Set(key, value string) error {
	if err := keyringSet(s.service, key, value); err == nil {
		return nil
	}
	m, err := s.read()
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if m == nil {
		m = map[string]string{}
	}
	m[key] = value
	b, err := json.Marshal(m)
	if err != nil {
		return err
	}
	if err = os.MkdirAll(filepath.Dir(s.path), 0700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(s.path), ".secrets-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if err = tmp.Chmod(0600); err != nil {
		tmp.Close()
		return err
	}
	if _, err = tmp.Write(b); err != nil {
		tmp.Close()
		return err
	}
	if err = tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), s.path)
}
func (s *Store) read() (map[string]string, error) {
	fi, err := os.Lstat(s.path)
	if err != nil {
		return nil, err
	}
	if !fi.Mode().IsRegular() || fi.Mode().Perm()&0077 != 0 {
		return nil, errors.New("secrets file must be regular and mode 0600")
	}
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok || st.Uid != uint32(os.Getuid()) {
		return nil, errors.New("secrets file has wrong owner")
	}
	b, err := os.ReadFile(s.path)
	if err != nil {
		return nil, err
	}
	var m map[string]string
	if err = json.Unmarshal(b, &m); err != nil {
		return nil, fmt.Errorf("secrets file: %w", err)
	}
	return m, nil
}
