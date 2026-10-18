package main

import (
	"bufio"
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/api"
	"github.com/thiagodefreitas/faztudo/internal/auth"
	"github.com/thiagodefreitas/faztudo/internal/config"
	"github.com/thiagodefreitas/faztudo/internal/store"
	"github.com/thiagodefreitas/faztudo/internal/webui"
	"golang.org/x/term"
)

func runPasswd(p config.Paths, in io.Reader, out io.Writer) error {
	pw, err := readPasswordInput(in, out)
	if err != nil {
		return err
	}
	hash, err := auth.HashPassword(pw)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(p.DataDir, 0700); err != nil {
		return err
	}
	s, err := store.Open(p.DBFile)
	if err != nil {
		return err
	}
	defer s.Close()
	if err := s.SetPasswordHash(context.Background(), hash); err != nil {
		return err
	}
	// A new password revokes every existing session. Open streams notice on their next recheck.
	if err := s.DeleteAllSessions(context.Background()); err != nil {
		return err
	}
	fmt.Fprintln(out, "password updated; all devices signed out")
	return nil
}

func readPasswordInput(in io.Reader, out io.Writer) (string, error) {
	if f, ok := in.(*os.File); ok && term.IsTerminal(int(f.Fd())) {
		fmt.Fprint(out, "New password: ")
		first, err := term.ReadPassword(int(f.Fd()))
		fmt.Fprintln(out)
		if err != nil {
			return "", err
		}
		fmt.Fprint(out, "Confirm password: ")
		second, err := term.ReadPassword(int(f.Fd()))
		fmt.Fprintln(out)
		if err != nil {
			return "", err
		}
		if string(first) != string(second) {
			return "", errors.New("passwords do not match")
		}
		return string(first), nil
	}
	scanner := bufio.NewScanner(in)
	if !scanner.Scan() {
		if err := scanner.Err(); err != nil {
			return "", err
		}
		return "", errors.New("password is required")
	}
	first := strings.TrimRight(scanner.Text(), "\r\n")
	if scanner.Scan() {
		second := strings.TrimRight(scanner.Text(), "\r\n")
		if second != "" && second != first {
			return "", errors.New("passwords do not match")
		}
	}
	if err := scanner.Err(); err != nil {
		return "", err
	}
	return first, nil
}

func checkLANAuthReady(ctx context.Context, s *store.Store, now time.Time) error {
	hasPw, err := s.HasPassword(ctx)
	if err != nil {
		return err
	}
	if hasPw {
		return nil
	}
	devs, err := s.Devices(ctx, now)
	if err != nil {
		return err
	}
	if len(devs) > 0 {
		return nil
	}
	return errors.New("lan mode requires a password or paired device; run 'faztudo passwd' first")
}

type lanServers struct {
	lanListener net.Listener
	caListener  net.Listener
	lanServer   *http.Server
	caServer    *http.Server
	lanAddr     string
	caAddr      string
	urls        []string
	fingerprint string
}

func (l *lanServers) Close() error {
	if l == nil {
		return nil
	}
	_ = l.lanServer.Close()
	_ = l.caServer.Close()
	return nil
}

func startLAN(ctx context.Context, s *store.Store, c config.Config, p config.Paths, handler *api.API, logger *slog.Logger, out io.Writer) (*lanServers, error) {
	now := time.Now().UTC()
	if err := checkLANAuthReady(ctx, s, now); err != nil {
		return nil, err
	}
	certs, err := auth.NewCertManager(p.TLSDir, auth.DefaultHostAndIPs)
	if err != nil {
		return nil, err
	}
	bundle := certs.Bundle()
	lanTCP, err := net.Listen("tcp", c.LAN.Listen)
	if err != nil {
		return nil, err
	}
	caListener, err := net.Listen("tcp", c.LAN.CAListen)
	if err != nil {
		_ = lanTCP.Close()
		return nil, err
	}
	lanAddr := lanTCP.Addr().String()
	currentURLs := func() []string {
		_, ips, _ := auth.DefaultHostAndIPs()
		return auth.LANURLs(ips, lanAddr)
	}
	_, caPort, _ := net.SplitHostPort(caListener.Addr().String())
	handler.LANEnabled = true
	handler.LANListen = lanAddr
	handler.CurrentLANURLs = currentURLs
	handler.CAPort = caPort
	handler.CAHTTPURL = "http://" + caListener.Addr().String()
	handler.CACertPEM = bundle.CACertPEM
	handler.CAFingerprint = bundle.Fingerprint

	tlsListener := tls.NewListener(lanTCP, &tls.Config{
		MinVersion:     tls.VersionTLS12,
		GetCertificate: certs.GetCertificate,
	})
	lanServer := &http.Server{
		Handler:           webui.Mount(handler.LANHandler()),
		ReadHeaderTimeout: 5 * time.Second,
	}
	caServer := &http.Server{
		Handler:           auth.CAHelperHandler(bundle.CACertPEM, bundle.Fingerprint),
		ReadHeaderTimeout: 5 * time.Second,
	}
	go func() { _ = lanServer.Serve(tlsListener) }()
	go func() { _ = caServer.Serve(caListener) }()

	urls := currentURLs()
	if len(urls) == 0 && out != nil {
		fmt.Fprintln(out, "LAN: listening on", lanAddr, "(no network address yet; Settings > Devices shows the URL once the network is up)")
	}
	for _, u := range urls {
		if out != nil {
			fmt.Fprintln(out, "LAN:", u)
		}
	}
	if logger != nil {
		logger.Info("serving lan", "listen", lanAddr, "urls", urls, "ca_fingerprint", bundle.Fingerprint)
		logger.Info("serving ca helper", "listen", caListener.Addr().String())
	}
	return &lanServers{
		lanListener: tlsListener,
		caListener:  caListener,
		lanServer:   lanServer,
		caServer:    caServer,
		lanAddr:     lanAddr,
		caAddr:      caListener.Addr().String(),
		urls:        urls,
		fingerprint: bundle.Fingerprint,
	}, nil
}
