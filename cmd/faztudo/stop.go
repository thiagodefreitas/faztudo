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

// stopWait is how long stop waits for cancelled runs to end.
var stopWait = 15 * time.Second

// activeRunStates are the states a stop cancels. A run waiting for approval
// has no process left; its approval survives the restart, so stop keeps it.
var activeRunStates = []domain.RunState{domain.RunQueued, domain.RunRunning, domain.RunVerifying}

// stopResult is what `faztudo stop --json` prints. Daemon is "stopped" when
// the systemd user unit was stopped, "not_running" when nothing answered, and
// "left_running" when faztudo runs outside the unit and the caller must stop
// it, as the desktop app does with a daemon it started itself.
type stopResult struct {
	Cancelled int    `json:"cancelled"`
	Daemon    string `json:"daemon"`
	// Remaining lists runs still active after the wait: a cancel failed or
	// a run did not end. faztudo is then left running and stop fails.
	Remaining []string `json:"remaining,omitempty"`
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
		deadline := time.Now().Add(stopWait)
		for len(ids) > 0 && time.Now().Before(deadline) {
			time.Sleep(300 * time.Millisecond)
			if ids, err = activeRuns(base, token); err != nil {
				return fmt.Errorf("list runs after cancelling: %w", err)
			}
		}
		res.Daemon = "left_running"
		if len(ids) > 0 {
			// Never stop the daemon under runs that are still working.
			res.Remaining = ids
			if asJSON {
				if err := json.NewEncoder(out).Encode(res); err != nil {
					return err
				}
			}
			return fmt.Errorf("%d runs are still active (%s); faztudo was left running", len(ids), strings.Join(ids, ", "))
		}
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

// procAddresses gives the local_address forms in /proc/net/tcp{,6} that
// serve listen: the address itself and the wildcard of its family, with the
// port. The kernel prints each 32-bit word of the address in host order,
// which is little endian on every platform faztudo ships for.
func procAddresses(listen string) map[string]bool {
	host, portText, err := net.SplitHostPort(listen)
	if err != nil {
		return nil
	}
	port, err := strconv.Atoi(portText)
	if err != nil || port <= 0 || port > 65535 {
		return nil
	}
	var ips []net.IP
	if host == "localhost" {
		ips = []net.IP{net.ParseIP("127.0.0.1"), net.ParseIP("::1")}
	} else if ip := net.ParseIP(host); ip != nil {
		ips = []net.IP{ip}
	}
	out := map[string]bool{}
	for _, ip := range ips {
		if v4 := ip.To4(); v4 != nil {
			out[procHex(v4)+fmt.Sprintf(":%04X", port)] = true
			out[procHex(net.IPv4zero.To4())+fmt.Sprintf(":%04X", port)] = true
			// An IPv6 wildcard socket may or may not serve IPv4 (IPV6_V6ONLY);
			// proc does not say, so it never counts for an IPv4 address.
		} else {
			out[procHex(ip.To16())+fmt.Sprintf(":%04X", port)] = true
			out[procHex(net.IPv6zero)+fmt.Sprintf(":%04X", port)] = true
		}
	}
	return out
}

func procHex(ip []byte) string {
	var b strings.Builder
	for i := 0; i+4 <= len(ip); i += 4 {
		fmt.Fprintf(&b, "%02X%02X%02X%02X", ip[i+3], ip[i+2], ip[i+1], ip[i])
	}
	return b.String()
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
	if pid <= 0 || !listensOn("/proc", pid, listen) {
		return false, nil
	}
	// The unit could restart between this check and the stop; it would then
	// be the same unit faztudo, so stopping it is still what was asked.
	if out, err := exec.Command("systemctl", "--user", "stop", "faztudo").CombinedOutput(); err != nil {
		return false, fmt.Errorf("systemctl --user stop faztudo: %v: %s", err, out)
	}
	return true, nil
}

// listensOn reports whether process pid holds a TCP socket listening on the
// listen address, or on the wildcard address with the same port, read from
// proc's net/tcp tables and the process's open files.
func listensOn(proc string, pid int, listen string) bool {
	want := procAddresses(listen)
	if len(want) == 0 {
		return false
	}
	inodes := map[string]bool{}
	for _, table := range []string{"net/tcp", "net/tcp6"} {
		data, err := os.ReadFile(filepath.Join(proc, table))
		if err != nil {
			continue
		}
		for _, line := range strings.Split(string(data), "\n")[1:] {
			f := strings.Fields(line)
			// local_address is f[1], st is f[3] (0A is LISTEN), inode is f[9].
			if len(f) > 9 && want[strings.ToUpper(f[1])] && f[3] == "0A" {
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
