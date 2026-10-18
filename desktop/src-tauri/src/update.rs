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

/// A release version: three numbers and an optional prerelease tag, as in
/// "v1.2.3" or "1.2.3-rc.1". Build metadata after '+' is ignored.
#[derive(Debug, PartialEq, Eq)]
pub struct Version {
    pub core: (u64, u64, u64),
    pub pre: Option<String>,
}

pub fn parse(v: &str) -> Option<Version> {
    let v = v.trim().trim_start_matches('v');
    let v = v.split('+').next()?;
    let (core, pre) = match v.split_once('-') {
        Some((c, p)) if !p.is_empty() => (c, Some(p.to_string())),
        Some(_) => return None,
        None => (v, None),
    };
    let parts: Vec<u64> = core.split('.').map(|p| p.parse().ok()).collect::<Option<_>>()?;
    let [a, b, c] = parts[..] else { return None };
    Some(Version { core: (a, b, c), pre })
}

/// Orders prerelease tags as semantic versioning does: dot-separated parts
/// left to right, numbers by value and below words, and a shorter tag first
/// when it is a prefix of the other. So rc.2 comes before rc.10.
fn pre_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    let mut left = a.split('.');
    let mut right = b.split('.');
    loop {
        let order = match (left.next(), right.next()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(x), Some(y)) => match (x.parse::<u64>(), y.parse::<u64>()) {
                (Ok(m), Ok(n)) => m.cmp(&n),
                (Ok(_), Err(_)) => Ordering::Less,
                (Err(_), Ok(_)) => Ordering::Greater,
                (Err(_), Err(_)) => x.cmp(y),
            },
        };
        if order != Ordering::Equal {
            return order;
        }
    }
}

/// True when latest is a newer release than current. A final release is
/// newer than its own prereleases.
pub fn newer(latest: &str, current: &str) -> bool {
    let (Some(l), Some(c)) = (parse(latest), parse(current)) else {
        return false;
    };
    match l.core.cmp(&c.core) {
        std::cmp::Ordering::Equal => match (&l.pre, &c.pre) {
            (None, Some(_)) => true,
            (Some(lp), Some(cp)) => pre_cmp(lp, cp).is_gt(),
            _ => false,
        },
        order => order.is_gt(),
    }
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
        assert!(newer("v1.2.3", "1.2.3-rc1"));
        assert!(!newer("v1.2.3-rc1", "1.2.3"));
        assert!(newer("v1.2.3-rc.2", "1.2.3-rc.1"));
        assert!(newer("v1.2.3-rc.10", "1.2.3-rc.2"));
        assert!(newer("v1.2.3-rc", "1.2.3-beta.9"));
        assert!(newer("v1.2.3-rc.1", "1.2.3-rc"));
        assert!(parse("1.2.3.4").is_none());
        assert!(parse("1.2").is_none());
        assert_eq!(parse("v1.2.3+build5").unwrap().core, (1, 2, 3));
    }
}
