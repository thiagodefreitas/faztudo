package store

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"
)

func TestPasswordHashAndSessionsAndPairings(t *testing.T) {
	ctx := context.Background()
	s, err := Open(filepath.Join(t.TempDir(), "db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	has, err := s.HasPassword(ctx)
	if err != nil || has {
		t.Fatalf("initial HasPassword: %t %v", has, err)
	}
	if _, err := s.PasswordHash(ctx); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}

	if err := s.SetPasswordHash(ctx, []byte("synthetic-hash-1")); err != nil {
		t.Fatal(err)
	}
	has, err = s.HasPassword(ctx)
	if err != nil || !has {
		t.Fatalf("HasPassword after set: %t %v", has, err)
	}
	gotHash, err := s.PasswordHash(ctx)
	if err != nil || string(gotHash) != "synthetic-hash-1" {
		t.Fatalf("PasswordHash: %q %v", gotHash, err)
	}

	now := time.Date(2026, 10, 18, 12, 0, 0, 0, time.UTC)
	expires := now.Add(30 * 24 * time.Hour)
	dev, err := s.CreateSession(ctx, "hash-tok-1", "human-1", "Phone", "TestAgent/1.0", now, expires)
	if err != nil {
		t.Fatal(err)
	}
	if dev.ID == "" || dev.DeviceName != "Phone" || dev.MemberID != "human-1" {
		t.Fatalf("unexpected device: %+v", dev)
	}

	later := now.Add(time.Hour)
	slidExpires := later.Add(30 * 24 * time.Hour)
	lookedUp, err := s.SessionByTokenHash(ctx, "hash-tok-1", later, slidExpires)
	if err != nil {
		t.Fatal(err)
	}
	if !lookedUp.LastSeenAt.Equal(later) || !lookedUp.ExpiresAt.Equal(slidExpires) {
		t.Fatalf("session did not slide: %+v", lookedUp)
	}

	devices, err := s.Devices(ctx, later)
	if err != nil || len(devices) != 1 || devices[0].ID != dev.ID {
		t.Fatalf("devices: %+v %v", devices, err)
	}

	// Expired session lookup returns ErrNotFound and removes it.
	if _, err := s.SessionByTokenHash(ctx, "hash-tok-1", slidExpires.Add(time.Second), slidExpires.Add(time.Hour)); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected expired session ErrNotFound, got %v", err)
	}

	// Revoke device by ID.
	dev2, err := s.CreateSession(ctx, "hash-tok-2", "human-1", "Tablet", "TestAgent/2.0", now, expires)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteDevice(ctx, dev2.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SessionByTokenHash(ctx, "hash-tok-2", now, expires); !errors.Is(err, ErrNotFound) {
		t.Fatalf("revoked session still valid: %v", err)
	}
	if err := s.DeleteDevice(ctx, dev2.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("second delete should be ErrNotFound: %v", err)
	}

	// Pairing tokens: single use and expire.
	pairExpires := now.Add(5 * time.Minute)
	if _, err := s.CreatePairing(ctx, "pair-hash-1", now, pairExpires); err != nil {
		t.Fatal(err)
	}
	if err := s.ConsumePairing(ctx, "pair-hash-1", now.Add(time.Minute)); err != nil {
		t.Fatalf("first consume failed: %v", err)
	}
	if err := s.ConsumePairing(ctx, "pair-hash-1", now.Add(time.Minute)); !errors.Is(err, ErrNotFound) {
		t.Fatalf("second consume should fail: %v", err)
	}

	if _, err := s.CreatePairing(ctx, "pair-hash-expired", now, pairExpires); err != nil {
		t.Fatal(err)
	}
	if err := s.ConsumePairing(ctx, "pair-hash-expired", pairExpires.Add(time.Second)); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expired pairing should fail: %v", err)
	}
}
