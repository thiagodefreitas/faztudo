package signalbridge

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"strings"
	"syscall"

	"rsc.io/qr"
)

// Link runs signal-cli as an unlinked device. Its URI goes only to this
// terminal; the pairing secret is not logged or stored by faztudo.
func Link(ctx context.Context, cli, dir string, out, errOut io.Writer) error {
	if cli == "" {
		return errors.New("signal-cli command is required")
	}
	if err := EnsureDataDir(dir); err != nil {
		return err
	}
	cmd := exec.CommandContext(ctx, cli, "--config", dir, "link", "-n", "faztudo")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Stderr = errOut
	pipe, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	defer func() {
		if cmd.ProcessState == nil {
			_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
			_ = cmd.Wait()
		}
	}()
	s := bufio.NewScanner(pipe)
	s.Buffer(make([]byte, 64*1024), 1<<20)
	shown := false
	for s.Scan() {
		line := strings.TrimSpace(s.Text())
		if i := strings.Index(line, "sgnl://linkdevice?"); i >= 0 && !shown {
			uri := strings.Fields(line[i:])[0]
			fmt.Fprintln(out, uri)
			if err := renderQR(out, uri); err != nil {
				return err
			}
			shown = true
		}
	}
	if err := s.Err(); err != nil {
		return err
	}
	if err := cmd.Wait(); err != nil {
		return fmt.Errorf("signal-cli link: %w", err)
	}
	if !shown {
		return errors.New("signal-cli link did not print a pairing URI")
	}
	account, err := linkedAccount(dir)
	if err != nil {
		return err
	}
	fmt.Fprintln(out, "Linked Signal account:", account)
	return nil
}

func linkedAccount(dir string) (string, error) {
	accounts, err := accountMetadata(dir)
	if err != nil {
		return "", fmt.Errorf("read linked account metadata: %w", err)
	}
	if len(accounts) != 1 {
		return "", fmt.Errorf("expected one linked Signal account, found %d", len(accounts))
	}
	if accounts[0].Number != "" {
		return accounts[0].Number, nil
	}
	if accounts[0].ACI != "" {
		return accounts[0].ACI, nil
	}
	if accounts[0].UUID != "" {
		return accounts[0].UUID, nil
	}
	return "", errors.New("linked account has no identifier")
}

func renderQR(out io.Writer, uri string) error {
	code, err := qr.Encode(uri, qr.M)
	if err != nil {
		return err
	}
	// Two QR rows per terminal row. The Unicode block characters are output
	// only; source and documentation remain ASCII.
	for y := -2; y < code.Size+2; y += 2 {
		for x := -2; x < code.Size+2; x++ {
			top := x >= 0 && y >= 0 && x < code.Size && y < code.Size && code.Black(x, y)
			bottom := x >= 0 && y+1 >= 0 && x < code.Size && y+1 < code.Size && code.Black(x, y+1)
			switch {
			case top && bottom:
				fmt.Fprint(out, "\u2588")
			case top:
				fmt.Fprint(out, "\u2580")
			case bottom:
				fmt.Fprint(out, "\u2584")
			default:
				fmt.Fprint(out, " ")
			}
		}
		fmt.Fprintln(out)
	}
	return nil
}
