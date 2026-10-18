package main

import (
	"os"
	"path/filepath"
	"strings"
)

// packagedBinary is the path the AppArmor profile from the .deb names.
const packagedBinary = "/usr/bin/faztudo"

// apparmorStatus explains, for doctor, why user namespaces may be refused.
// It returns "" unless the kernel restricts unprivileged user namespaces
// (Ubuntu 24.04 and later). root is "/" outside tests; exe is the running
// binary with symlinks resolved.
func apparmorStatus(root, exe string) string {
	restrict, err := os.ReadFile(filepath.Join(root, "proc/sys/kernel/apparmor_restrict_unprivileged_userns"))
	if err != nil || strings.TrimSpace(string(restrict)) != "1" {
		return ""
	}
	_, err = os.Stat(filepath.Join(root, "etc/apparmor.d/faztudo"))
	profile := err == nil
	switch {
	case !profile:
		return "AppArmor: user namespaces are restricted and /etc/apparmor.d/faztudo is missing; install the faztudo .deb so write runs can use bubblewrap"
	case exe != packagedBinary:
		return "AppArmor: user namespaces are restricted; the profile covers " + packagedBinary + " but this faztudo runs from " + exe + ", so its write runs cannot use bubblewrap"
	default:
		return "AppArmor: user namespaces are restricted; profile /etc/apparmor.d/faztudo installed and faztudo runs from " + packagedBinary
	}
}

func runningBinary() string {
	exe, err := os.Executable()
	if err != nil {
		return "an unknown path"
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		return resolved
	}
	return exe
}
