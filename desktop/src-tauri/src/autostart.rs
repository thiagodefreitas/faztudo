//! "Start at login": an XDG autostart entry that opens the app in the tray.

use std::path::{Path, PathBuf};

fn entry_path() -> Option<PathBuf> {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))?;
    Some(base.join("autostart/faztudo-desktop.desktop"))
}

pub fn enabled() -> bool {
    entry_path().is_some_and(|p| p.exists())
}

/// The program to start at login. An AppImage must start the AppImage file,
/// not the binary inside its temporary mount.
fn program() -> Option<PathBuf> {
    std::env::var_os("APPIMAGE")
        .map(PathBuf::from)
        .or_else(|| std::env::current_exe().ok())
}

pub fn entry(program: &Path) -> String {
    let quoted = program.display().to_string().replace('\\', "\\\\").replace('"', "\\\"");
    format!(
        "[Desktop Entry]\nType=Application\nName=faztudo\nComment=Open faztudo in the tray\nExec=\"{quoted}\" --hidden\nIcon=faztudo-desktop\nTerminal=false\nX-GNOME-Autostart-enabled=true\n"
    )
}

pub fn set(on: bool) -> Result<(), String> {
    let path = entry_path().ok_or("HOME is not set")?;
    if !on {
        return match std::fs::remove_file(&path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
            _ => Ok(()),
        };
    }
    let program = program().ok_or("cannot find this program's path")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, entry(&program)).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entry_quotes_the_path_and_starts_hidden() {
        let e = entry(Path::new("/opt/my apps/faztudo.AppImage"));
        assert!(e.contains("Exec=\"/opt/my apps/faztudo.AppImage\" --hidden\n"));
    }
}
