package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/auth"
	"github.com/thiagodefreitas/faztudo/internal/config"
	"github.com/thiagodefreitas/faztudo/internal/domain"
)

// activeRunStates are the states a stop cancels.
var activeRunStates = []domain.RunState{domain.RunQueued, domain.RunRunning, domain.RunWaitingApproval, domain.RunVerifying}

// stopResult is what `faztudo stop --json` prints. Daemon is "stopped" when
// the systemd user unit was stopped, "not_running" when nothing answered, and
// "left_running" when faztudo runs outside the unit and the caller must stop
// it, as the desktop app does with a daemon it started itself.
type stopResult struct {
	Cancelled int    `json:"cancelled"`
	Daemon    string `json:"daemon"`
}

// runStop cancels every active run with the local token, waits for them to
// end, then stops the faztudo systemd user unit if it is active. The token
// stays in this process, as with connect.
func runStop(listen, tokenPath string, args []string, out io.Writer, stopUnit func(listen string) (bool, error)) error {
	asJSON := false
	switch {
	case len(args) == 0:
	case len(args) == 1 && args[0] == "--json":
		asJSON = true
	default:
		return fmt.Errorf("usage: faztudo stop [--json]")
	}
	if !config.IsLoopbackListen(listen) {
		return fmt.Errorf("server.listen %q is not a loopback address; faztudo only stops locally", listen)
	}
	res := stopResult{Daemon: "not_running"}
	base := "http://" + listen
	if healthAnswers(base) {
		token, err := auth.ReadLocalToken(tokenPath)
		if err != nil {
			return fmt.Errorf("read local token: %w", err)
		}
		ids, err := activeRuns(base, token)
		if err != nil {
			return err
		}
		for _, id := range ids {
			if err := localCall("POST", base+"/api/v1/runs/"+id+"/cancel", token, nil); err == nil {
				res.Cancelled++
			}
		}
		deadline := time.Now().Add(15 * time.Second)
		for len(ids) > 0 && time.Now().Before(deadline) {
			time.Sleep(300 * time.Millisecond)
			if ids, err = activeRuns(base, token); err != nil {
				break
			}
		}
		res.Daemon = "left_running"
	}
	stopped, err := stopUnit(listen)
	if err != nil {
		return err
	}
	if stopped {
		res.Daemon = "stopped"
	}
	if asJSON {
		return json.NewEncoder(out).Encode(res)
	}
	switch res.Daemon {
	case "stopped":
		_, err = fmt.Fprintf(out, "Cancelled %d runs and stopped faztudo.\n", res.Cancelled)
	case "left_running":
		_, err = fmt.Fprintf(out, "Cancelled %d runs. faztudo is not running as the systemd user unit; stop it where you started it.\n", res.Cancelled)
	default:
		_, err = fmt.Fprintln(out, "faztudo is not running.")
	}
	return err
}

func healthAnswers(base string) bool {
	client := &http.Client{Timeout: 5 * time.Second}
	res, err := client.Get(base + "/api/v1/health")
	if err != nil {
		return false
	}
	res.Body.Close()
	return true
}

func activeRuns(base, token string) ([]string, error) {
	var ids []string
	for _, state := range activeRunStates {
		var runs []domain.Run
		if err := localCall("GET", base+"/api/v1/runs?state="+string(state), token, &runs); err != nil {
			return nil, err
		}
		for _, r := range runs {
			if !r.State.Terminal() {
				ids = append(ids, r.ID)
			}
		}
	}
	return ids, nil
}

func localCall(method, url, token string, into any) error {
	req, err := http.NewRequest(method, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	client := &http.Client{Timeout: 10 * time.Second}
	res, err := client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode/100 != 2 {
		return fmt.Errorf("%s %s: status %d", method, url, res.StatusCode)
	}
	if into == nil {
		return nil
	}
	return json.NewDecoder(io.LimitReader(res.Body, 64<<20)).Decode(into)
}

// stopSystemdUnit stops the faztudo user unit when it is active and its main
// process is the daemon listening on this address. A unit running another
// faztudo, or none at all, is left alone and reported as false.
func stopSystemdUnit(listen string) (bool, error) {
	if _, err := exec.LookPath("systemctl"); err != nil {
		return false, nil
	}
	out, err := exec.Command("systemctl", "--user", "show", "-p", "MainPID", "--value", "faztudo").Output()
	if err != nil {
		return false, nil
	}
	pid, _ := strconv.Atoi(strings.TrimSpace(string(out)))
	_, port, err := net.SplitHostPort(listen)
	if err != nil || pid <= 0 || !listensOn("/proc", pid, port) {
		return false, nil
	}
	if out, err := exec.Command("systemctl", "--user", "stop", "faztudo").CombinedOutput(); err != nil {
		return false, fmt.Errorf("systemctl --user stop faztudo: %v: %s", err, out)
	}
	return true, nil
}

// listensOn reports whether process pid holds a TCP socket listening on
// port, read from proc's net/tcp tables and the process's open files.
func listensOn(proc string, pid int, port string) bool {
	p, err := strconv.Atoi(port)
	if err != nil {
		return false
	}
	want := fmt.Sprintf(":%04X", p)
	inodes := map[string]bool{}
	for _, table := range []string{"net/tcp", "net/tcp6"} {
		data, err := os.ReadFile(filepath.Join(proc, table))
		if err != nil {
			continue
		}
		for _, line := range strings.Split(string(data), "\n")[1:] {
			f := strings.Fields(line)
			// local_address is f[1], st is f[3] (0A is LISTEN), inode is f[9].
			if len(f) > 9 && strings.HasSuffix(f[1], want) && f[3] == "0A" {
				inodes["socket:["+f[9]+"]"] = true
			}
		}
	}
	if len(inodes) == 0 {
		return false
	}
	fdDir := filepath.Join(proc, strconv.Itoa(pid), "fd")
	fds, err := os.ReadDir(fdDir)
	if err != nil {
		return false
	}
	for _, fd := range fds {
		if target, err := os.Readlink(filepath.Join(fdDir, fd.Name())); err == nil && inodes[target] {
			return true
		}
	}
	return false
}
