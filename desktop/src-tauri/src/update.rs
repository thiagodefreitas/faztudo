//! The update notice. The app never updates itself; once a day at most it
//! asks GitHub for the latest release and, when it is newer, offers a link.
//! FAZTUDO_NO_UPDATE_CHECK=1 turns the check off.

use std::path::PathBuf;
use std::time::{Duration, SystemTime};

pub const RELEASES: &str = "https://github.com/thiagodefreitas/faztudo/releases/latest";
const API: &str = "https://api.github.com/repos/thiagodefreitas/faztudo/releases/latest";
const EVERY: Duration = Duration::from_secs(24 * 60 * 60);

pub fn disabled() -> bool {
    std::env::var("FAZTUDO_NO_UPDATE_CHECK").is_ok_and(|v| v == "1")
}

fn stamp_path() -> Option<PathBuf> {
    let base = std::env::var_os("XDG_CACHE_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".cache")))?;
    Some(base.join("faztudo/desktop-update-check"))
}

/// True when no check ran in the last day. Records this check.
pub fn due() -> bool {
    let Some(path) = stamp_path() else { return true };
    let recent = std::fs::metadata(&path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| SystemTime::now().duration_since(t).ok())
        .is_some_and(|age| age < EVERY);
    if recent {
        return false;
    }
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(&path, b"");
    true
}

/// The latest release tag, or None when GitHub could not be reached.
pub fn latest() -> Option<String> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(10)))
        .build()
        .into();
    let mut res = agent
        .get(API)
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", concat!("faztudo-desktop/", env!("CARGO_PKG_VERSION")))
        .call()
        .ok()?;
    let body: serde_json::Value = res.body_mut().read_json().ok()?;
    body.get("tag_name")?.as_str().map(str::to_string)
}

/// Parses "v1.2.3" or "1.2.3"; anything after a '-' or '+' is ignored.
pub fn parse(v: &str) -> Option<(u64, u64, u64)> {
    let v = v.trim().trim_start_matches('v');
    let v = v.split(['-', '+']).next()?;
    let mut parts = v.split('.').map(|p| p.parse::<u64>().ok());
    Some((parts.next()??, parts.next()??, parts.next()??))
}

pub fn newer(latest: &str, current: &str) -> bool {
    matches!((parse(latest), parse(current)), (Some(l), Some(c)) if l > c)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_compare() {
        assert!(newer("v0.1.4", "0.1.3"));
        assert!(newer("v0.2.0", "0.1.9"));
        assert!(!newer("v0.1.3", "0.1.3"));
        assert!(!newer("v0.1.2", "0.1.3"));
        assert!(!newer("nonsense", "0.1.3"));
        assert_eq!(parse("v1.2.3-rc1"), Some((1, 2, 3)));
    }
}
