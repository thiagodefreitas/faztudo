package store

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

type Device struct {
	ID         string    `json:"id"`
	MemberID   string    `json:"-"`
	DeviceName string    `json:"device_name"`
	UserAgent  string    `json:"user_agent"`
	CreatedAt  time.Time `json:"created_at"`
	LastSeenAt time.Time `json:"last_seen_at"`
	ExpiresAt  time.Time `json:"-"`
	Current    bool      `json:"current,omitempty"`
	OK         bool      `json:"ok,omitempty"`
}

func (s *Store) SetPasswordHash(ctx context.Context, hash []byte) error {
	if len(hash) == 0 {
		return errors.New("password hash required")
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	_, err := s.db.ExecContext(ctx, "INSERT INTO auth_password(id,password_hash,updated_at) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET password_hash=excluded.password_hash,updated_at=excluded.updated_at", hash, now)
	return err
}

func (s *Store) PasswordHash(ctx context.Context) ([]byte, error) {
	var hash []byte
	err := s.db.QueryRowContext(ctx, "SELECT password_hash FROM auth_password WHERE id=1").Scan(&hash)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return hash, err
}

func (s *Store) HasPassword(ctx context.Context) (bool, error) {
	var n int
	err := s.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM auth_password WHERE id=1").Scan(&n)
	return n > 0, err
}

func (s *Store) CreateSession(ctx context.Context, tokenHash, memberID, deviceName, userAgent string, now, expiresAt time.Time) (Device, error) {
	if tokenHash == "" || memberID == "" || deviceName == "" {
		return Device{}, errors.New("token hash, member id and device name required")
	}
	d := Device{
		ID:         NewID(),
		MemberID:   memberID,
		DeviceName: deviceName,
		UserAgent:  userAgent,
		CreatedAt:  now.UTC(),
		LastSeenAt: now.UTC(),
		ExpiresAt:  expiresAt.UTC(),
	}
	_, err := s.db.ExecContext(ctx, "INSERT INTO sessions(id,token_hash,member_id,device_name,user_agent,created_at,last_seen_at,expires_at) VALUES(?,?,?,?,?,?,?,?)",
		d.ID, tokenHash, d.MemberID, d.DeviceName, d.UserAgent,
		d.CreatedAt.Format(time.RFC3339Nano), d.LastSeenAt.Format(time.RFC3339Nano), d.ExpiresAt.Format(time.RFC3339Nano))
	return d, storeError(err)
}

func scanDevice(row interface{ Scan(...any) error }) (Device, error) {
	var d Device
	var created, lastSeen, expires string
	if err := row.Scan(&d.ID, &d.MemberID, &d.DeviceName, &d.UserAgent, &created, &lastSeen, &expires); err != nil {
		return d, err
	}
	var err error
	if d.CreatedAt, err = time.Parse(time.RFC3339Nano, created); err != nil {
		return d, err
	}
	if d.LastSeenAt, err = time.Parse(time.RFC3339Nano, lastSeen); err != nil {
		return d, err
	}
	d.ExpiresAt, err = time.Parse(time.RFC3339Nano, expires)
	return d, err
}

func (s *Store) SessionByTokenHash(ctx context.Context, tokenHash string, now, newExpiresAt time.Time) (Device, error) {
	d, err := scanDevice(s.db.QueryRowContext(ctx, "SELECT id,member_id,device_name,user_agent,created_at,last_seen_at,expires_at FROM sessions WHERE token_hash=?", tokenHash))
	if errors.Is(err, sql.ErrNoRows) {
		return Device{}, ErrNotFound
	}
	if err != nil {
		return Device{}, err
	}
	if !now.Before(d.ExpiresAt) {
		_, _ = s.db.ExecContext(ctx, "DELETE FROM sessions WHERE id=?", d.ID)
		return Device{}, ErrNotFound
	}
	d.LastSeenAt = now.UTC()
	d.ExpiresAt = newExpiresAt.UTC()
	_, err = s.db.ExecContext(ctx, "UPDATE sessions SET last_seen_at=?,expires_at=? WHERE id=?",
		d.LastSeenAt.Format(time.RFC3339Nano), d.ExpiresAt.Format(time.RFC3339Nano), d.ID)
	return d, err
}

func (s *Store) Devices(ctx context.Context, now time.Time) ([]Device, error) {
	if _, err := s.db.ExecContext(ctx, "DELETE FROM sessions WHERE expires_at<=?", now.UTC().Format(time.RFC3339Nano)); err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, "SELECT id,member_id,device_name,user_agent,created_at,last_seen_at,expires_at FROM sessions ORDER BY created_at DESC,id DESC")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Device{}
	for rows.Next() {
		d, err := scanDevice(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

func (s *Store) DeleteDevice(ctx context.Context, id string) error {
	res, err := s.db.ExecContext(ctx, "DELETE FROM sessions WHERE id=?", id)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) DeleteSessionByTokenHash(ctx context.Context, tokenHash string) (string, error) {
	var id string
	err := s.db.QueryRowContext(ctx, "SELECT id FROM sessions WHERE token_hash=?", tokenHash).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", err
	}
	if _, err := s.db.ExecContext(ctx, "DELETE FROM sessions WHERE id=?", id); err != nil {
		return "", err
	}
	return id, nil
}

func (s *Store) CreatePairing(ctx context.Context, tokenHash string, now, expiresAt time.Time) (string, error) {
	if tokenHash == "" {
		return "", errors.New("token hash required")
	}
	id := NewID()
	_, err := s.db.ExecContext(ctx, "INSERT INTO pairings(id,token_hash,created_at,expires_at) VALUES(?,?,?,?)",
		id, tokenHash, now.UTC().Format(time.RFC3339Nano), expiresAt.UTC().Format(time.RFC3339Nano))
	return id, storeError(err)
}

// ConsumePairing deletes the pairing row and returns ErrNotFound if it did
// not exist or had already expired. A single DELETE ... RETURNING decides the
// winner, so concurrent callers cannot both consume one token.
func (s *Store) ConsumePairing(ctx context.Context, tokenHash string, now time.Time) error {
	var expiresRaw string
	err := s.db.QueryRowContext(ctx, "DELETE FROM pairings WHERE token_hash=? RETURNING expires_at", tokenHash).Scan(&expiresRaw)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	expiresAt, err := time.Parse(time.RFC3339Nano, expiresRaw)
	if err != nil || !now.Before(expiresAt) {
		return ErrNotFound
	}
	return nil
}

// DeleteAllSessions revokes every signed-in device.
func (s *Store) DeleteAllSessions(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, "DELETE FROM sessions")
	return err
}

// SessionActive reports whether the session row still exists and has not expired.
func (s *Store) SessionActive(ctx context.Context, id string, now time.Time) (bool, error) {
	var expiresRaw string
	err := s.db.QueryRowContext(ctx, "SELECT expires_at FROM sessions WHERE id=?", id).Scan(&expiresRaw)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	expiresAt, err := time.Parse(time.RFC3339Nano, expiresRaw)
	if err != nil {
		return false, err
	}
	return now.Before(expiresAt), nil
}
