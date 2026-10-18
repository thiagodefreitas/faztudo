//! Finding, starting, signing in to and stopping the local faztudo daemon.
//!
//! The shell never reads the local token. It runs `faztudo connect --json`,
//! which prints a one-time sign-in code, and `faztudo stop --json`, which
//! cancels runs with the token inside the Go process.

use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// What `faztudo connect --json` prints.
#[derive(Debug, Deserialize, PartialEq)]
pub struct Connect {
    pub url: String,
    pub code: String,
    #[serde(default)]
    pub version: String,
}

/// What `faztudo stop --json` prints.
#[derive(Debug, Deserialize, PartialEq)]
pub struct Stop {
    pub cancelled: u32,
    pub daemon: String,
}

/// Where the faztudo binary came from. Only a packaged binary at a fixed
/// path gets the AppArmor profile on Ubuntu 24.04 and later.
#[derive(Debug, Clone, PartialEq)]
pub enum Source {
    /// /usr/bin/faztudo, ~/.local/bin/faztudo or PATH.
    Installed,
    /// Named by FAZTUDO_BIN. Started directly, never through the systemd
    /// unit, which runs a different binary.
    Explicit,
    /// The copy carried inside the AppImage.
    Sidecar,
}

#[derive(Debug, Clone)]
pub struct Binary {
    pub path: PathBuf,
    pub source: Source,
}

pub fn parse_connect(out: &[u8]) -> Result<Connect, String> {
    let c: Connect = serde_json::from_slice(out).map_err(|e| format!("unexpected output from faztudo connect: {e}"))?;
    if !is_loopback_http(&c.url) {
        return Err(format!("faztudo connect gave a non-local address: {}", c.url));
    }
    if c.code.is_empty()
        || !c
            .code
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
    {
        return Err("faztudo connect gave no usable sign-in code".into());
    }
    Ok(c)
}

pub fn parse_stop(out: &[u8]) -> Result<Stop, String> {
    serde_json::from_slice(out).map_err(|e| format!("unexpected output from faztudo stop: {e}"))
}

/// The daemon only signs in over loopback; refuse anything else so a bad
/// config can never point the signed-in window at another host.
pub fn is_loopback_http(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("http://") else {
        return false;
    };
    let host = rest.split('/').next().unwrap_or("");
    let host = match host.rsplit_once(':') {
        Some((h, port)) if !port.is_empty() && port.chars().all(|c| c.is_ascii_digit()) => h,
        _ => host,
    };
    host == "127.0.0.1" || host == "localhost" || host == "[::1]"
}

/// Finds the faztudo binary. An installed one wins over the AppImage copy,
/// because the packaged path is the one the AppArmor profile matches.
pub fn find_binary() -> Option<Binary> {
    if let Some(p) = std::env::var_os("FAZTUDO_BIN").map(PathBuf::from) {
        if is_executable(&p) {
            return Some(Binary {
                path: p,
                source: Source::Explicit,
            });
        }
    }
    let mut candidates = vec![PathBuf::from("/usr/bin/faztudo")];
    if let Some(home) = std::env::var_os("HOME") {
        candidates.push(Path::new(&home).join(".local/bin/faztudo"));
    }
    if let Some(path) = std::env::var_os("PATH") {
        candidates.extend(std::env::split_paths(&path).map(|d| d.join("faztudo")));
    }
    // The AppImage puts its own bin directory on PATH; the copy in there is
    // the sidecar, not an installed faztudo.
    let bundled: Vec<PathBuf> = [
        std::env::var_os("APPDIR").map(PathBuf::from),
        std::env::current_exe()
            .ok()
            .and_then(|e| e.parent().map(Path::to_path_buf)),
    ]
    .into_iter()
    .flatten()
    .collect();
    if let Some(p) = candidates
        .into_iter()
        .find(|p| is_executable(p) && !bundled.iter().any(|b| p.starts_with(b)))
    {
        return Some(Binary {
            path: p,
            source: Source::Installed,
        });
    }
    let sidecar = std::env::current_exe().ok()?.parent()?.join("faztudo");
    is_executable(&sidecar).then_some(Binary {
        path: sidecar,
        source: Source::Sidecar,
    })
}

fn is_executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p)
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

fn run_json(bin: &Path, args: &[&str]) -> Result<Vec<u8>, String> {
    let out = Command::new(bin)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("could not run {}: {e}", bin.display()))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(err.trim().trim_start_matches("faztudo: ").to_string());
    }
    Ok(out.stdout)
}

pub fn connect(bin: &Path) -> Result<Connect, String> {
    parse_connect(&run_json(bin, &["connect", "--json"])?)
}

pub fn stop(bin: &Path) -> Result<Stop, String> {
    parse_stop(&run_json(bin, &["stop", "--json"])?)
}

/// How the shell got the daemon running.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Started {
    /// It was already running.
    AlreadyRunning,
    /// Started through the systemd user unit from the package.
    Unit,
    /// Started by the shell itself; the shell stops it on "Stop faztudo".
    Child(u32),
}

fn has_user_unit() -> bool {
    Command::new("systemctl")
        .args(["--user", "cat", "faztudo"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// The AppImage is mounted only while the app runs, so a daemon started from
/// the mount would lose its binary when the window quits. Copy it out first.
fn stable_copy(bin: &Binary) -> Result<PathBuf, String> {
    if bin.source != Source::Sidecar {
        return Ok(bin.path.clone());
    }
    let data = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| Path::new(&h).join(".local/share")))
        .ok_or("HOME is not set")?;
    let dir = data.join("faztudo/bin");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let dest = dir.join(format!("faztudo-{}", env!("CARGO_PKG_VERSION")));
    if !is_executable(&dest) {
        let tmp = dir.join(format!(".faztudo-{}.tmp", std::process::id()));
        std::fs::copy(&bin.path, &tmp).map_err(|e| format!("copy faztudo: {e}"))?;
        std::fs::rename(&tmp, &dest).map_err(|e| format!("copy faztudo: {e}"))?;
    }
    Ok(dest)
}

/// Makes sure the daemon answers, starting it if needed, and signs in.
pub fn ensure_running(bin: &Binary, status: &dyn Fn(&str)) -> Result<(Connect, Started), String> {
    if let Ok(c) = connect(&bin.path) {
        return Ok((c, Started::AlreadyRunning));
    }
    let started = if bin.source == Source::Installed && has_user_unit() {
        status("Starting the faztudo service");
        let ok = Command::new("systemctl")
            .args(["--user", "start", "faztudo"])
            .stdin(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if !ok {
            return Err("systemctl --user start faztudo failed; see journalctl --user -u faztudo".into());
        }
        Started::Unit
    } else {
        status("Starting faztudo");
        let path = stable_copy(bin)?;
        Started::Child(spawn_detached(&path)?)
    };
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        match connect(&bin.path) {
            Ok(c) => return Ok((c, started)),
            Err(e) if Instant::now() >= deadline => return Err(e),
            Err(_) => std::thread::sleep(Duration::from_millis(300)),
        }
    }
}

/// Starts `faztudo serve --no-open` in its own session, so it outlives the
/// window when the person chooses to leave it running.
fn spawn_detached(bin: &Path) -> Result<u32, String> {
    use std::os::unix::process::CommandExt;
    let mut cmd = Command::new(bin);
    cmd.args(["serve", "--no-open"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // SAFETY: setsid is async-signal-safe and only detaches the child from
    // our session and terminal.
    unsafe {
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    let child = cmd.spawn().map_err(|e| format!("could not start faztudo: {e}"))?;
    Ok(child.id())
}

pub fn terminate(pid: u32) {
    // SAFETY: plain kill(2) on a pid this process started.
    unsafe {
        libc::kill(pid as libc::pid_t, libc::SIGTERM);
    }
}

/// On Ubuntu 24.04 and later the kernel lets only profiled programs create
/// user namespaces. Without the faztudo package, write runs cannot start.
pub fn userns_restricted() -> bool {
    std::fs::read_to_string("/proc/sys/kernel/apparmor_restrict_unprivileged_userns")
        .map(|s| s.trim() == "1")
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connect_output_parses() {
        let c = parse_connect(br#"{"url":"http://127.0.0.1:7457","code":"abcDEF123","version":"v0.1.3"}"#).unwrap();
        assert_eq!(c.url, "http://127.0.0.1:7457");
        assert_eq!(c.code, "abcDEF123");
        assert_eq!(c.version, "v0.1.3");
    }

    #[test]
    fn connect_refuses_other_hosts_and_odd_codes() {
        assert!(parse_connect(br#"{"url":"http://192.168.1.4:7457","code":"abc"}"#).is_err());
        assert!(parse_connect(br#"{"url":"https://127.0.0.1:7457","code":"abc"}"#).is_err());
        assert!(parse_connect(br#"{"url":"http://127.0.0.1:7457","code":""}"#).is_err());
        assert!(parse_connect(br#"{"url":"http://127.0.0.1:7457","code":"a#b"}"#).is_err());
        assert!(parse_connect(b"not json").is_err());
    }

    #[test]
    fn loopback_check() {
        assert!(is_loopback_http("http://127.0.0.1:7457"));
        assert!(is_loopback_http("http://localhost:7457/"));
        assert!(is_loopback_http("http://[::1]:7457"));
        assert!(!is_loopback_http("http://127.0.0.1.evil.test:7457"));
        assert!(!is_loopback_http("http://example.com"));
    }

    #[test]
    fn stop_output_parses() {
        let s = parse_stop(br#"{"cancelled":2,"daemon":"stopped"}"#).unwrap();
        assert_eq!(
            s,
            Stop {
                cancelled: 2,
                daemon: "stopped".into()
            }
        );
    }
}
