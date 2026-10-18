//! faztudo desktop: a window and a tray icon around the local daemon.
//!
//! The window shows the daemon's own origin, the same page a browser shows,
//! signed in with a one-time code from `faztudo connect`. It gets no Tauri
//! commands and may only navigate inside that origin; other links open in
//! the system browser. See docs/adr/0005-desktop-shell.md.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod autostart;
mod daemon;
mod update;

use std::sync::{Arc, Mutex};
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent, Wry};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult};

const WINDOW: &str = "main";

#[derive(Default)]
struct Shared {
    /// The daemon origin, such as http://127.0.0.1:7457, once signed in.
    origin: Arc<Mutex<Option<String>>>,
    binary: Mutex<Option<daemon::Binary>>,
    started: Mutex<Option<daemon::Started>>,
    child: Mutex<Option<std::process::Child>>,
    update_item: Mutex<Option<MenuItem<Wry>>>,
    newer: Mutex<Option<String>>,
}

fn main() {
    let hidden = std::env::args().any(|a| a == "--hidden");
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show(app)))
        .plugin(tauri_plugin_dialog::init())
        .manage(Shared::default())
        .setup(move |app| {
            let handle = app.handle().clone();
            let win = build_window(&handle, !hidden)?;
            grant_notifications(&win);
            build_tray(&handle)?;
            start(handle.clone());
            check_updates(handle, false);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("faztudo desktop failed to start");
}

fn build_window(app: &AppHandle, visible: bool) -> tauri::Result<WebviewWindow> {
    let origin = app.state::<Shared>().origin.clone();
    let win = WebviewWindowBuilder::new(app, WINDOW, WebviewUrl::App("index.html".into()))
        .title("faztudo")
        .inner_size(1280.0, 800.0)
        .min_inner_size(720.0, 520.0)
        .visible(visible)
        .on_navigation(move |url| {
            if allowed(url, origin.lock().unwrap().as_deref()) {
                return true;
            }
            open_external(url);
            false
        })
        .on_new_window(|url, _features| {
            open_external(&url);
            NewWindowResponse::Deny
        })
        .build()?;
    let w = win.clone();
    win.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            // Closing hides to the tray; the daemon and its runs go on.
            api.prevent_close();
            let _ = w.hide();
        }
    });
    Ok(win)
}

/// The bundled start page and the signed-in daemon origin are the only
/// places the window may go.
fn allowed(url: &Url, origin: Option<&str>) -> bool {
    if url.scheme() == "tauri" || (url.scheme() == "http" && url.host_str() == Some("tauri.localhost")) {
        return true;
    }
    match origin {
        Some(o) => url.origin().ascii_serialization() == o,
        None => false,
    }
}

fn open_external(url: &Url) {
    if matches!(url.scheme(), "http" | "https" | "mailto") {
        let _ = std::process::Command::new("xdg-open").arg(url.as_str()).spawn();
    }
}

/// WebKitGTK asks before a page shows notifications. Allow that one
/// permission so the web app's mention and approval alerts reach the
/// desktop, and deny every other request explicitly: WebKit's own default
/// allows some, such as pointer lock.
fn grant_notifications(win: &WebviewWindow) {
    #[cfg(target_os = "linux")]
    let _ = win.with_webview(|wv| {
        use webkit2gtk::glib::prelude::*;
        use webkit2gtk::{NotificationPermissionRequest, PermissionRequestExt, WebViewExt};
        wv.inner().connect_permission_request(|_, req| {
            if req.is::<NotificationPermissionRequest>() {
                req.allow();
            } else {
                req.deny();
            }
            true
        });
    });
}

fn set_status(win: &WebviewWindow, status: &str, detail: &str) {
    let js = format!(
        "(function(){{var s=document.getElementById('status'),d=document.getElementById('detail');if(s)s.textContent={};if(d)d.textContent={};}})()",
        serde_json::to_string(status).unwrap_or_default(),
        serde_json::to_string(detail).unwrap_or_default()
    );
    let _ = win.eval(&js);
}

/// Finds the daemon, starts it if needed, signs in and loads the app.
fn start(app: AppHandle) {
    std::thread::spawn(move || {
        let Some(win) = app.get_webview_window(WINDOW) else {
            return;
        };
        let Some(bin) = daemon::find_binary() else {
            set_status(
                &win,
                "faztudo is not installed",
                "Install the faztudo package from the releases page, then open this app again.",
            );
            return;
        };
        let shared = app.state::<Shared>();
        *shared.binary.lock().unwrap() = Some(bin.clone());
        let status = |s: &str| set_status(&win, s, "");
        let (conn, started, child) = match daemon::ensure_running(&bin, &status) {
            Ok(v) => v,
            Err(e) => {
                set_status(&win, "faztudo did not start", &e);
                return;
            }
        };
        *shared.started.lock().unwrap() = Some(started);
        *shared.child.lock().unwrap() = child;
        let origin = conn.url.trim_end_matches('/').to_string();
        *shared.origin.lock().unwrap() = Some(origin.clone());
        // The code works once and expires within a minute; the page drops it
        // from the address as soon as it is used.
        if let Ok(target) = Url::parse(&format!("{origin}/auth/local#{}", conn.code)) {
            let _ = win.navigate(target);
        }
        warn_if_limited(&app, &bin, &conn.version);
    });
}

fn warn_if_limited(app: &AppHandle, bin: &daemon::Binary, daemon_version: &str) {
    let mine = env!("CARGO_PKG_VERSION");
    if bin.source == daemon::Source::Sidecar && daemon::userns_restricted() {
        app.dialog()
            .message(
                "This system only lets packaged programs create the sandbox that write runs need. \
                 Agents can read and answer, but write runs will not start until you install the \
                 faztudo .deb package.",
            )
            .title("Write runs need the faztudo package")
            .kind(MessageDialogKind::Warning)
            .show(|_| {});
    } else if !daemon_version.is_empty()
        && update::parse(daemon_version).is_some_and(|d| update::parse(mine) != Some(d))
    {
        app.dialog()
            .message(format!(
                "This window is faztudo desktop {mine} and the running faztudo is {daemon_version}. \
                 Most things work, but update both to the same version when you can."
            ))
            .title("Different versions")
            .kind(MessageDialogKind::Info)
            .show(|_| {});
    }
}

fn show(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(WINDOW) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open faztudo", true, None::<&str>)?;
    let login = CheckMenuItem::with_id(
        app,
        "autostart",
        "Start at login",
        true,
        autostart::enabled(),
        None::<&str>,
    )?;
    let updates = MenuItem::with_id(app, "update", "Check for updates", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit faztudo desktop...", true, None::<&str>)?;
    let sep = || PredefinedMenuItem::separator(app);
    let menu = Menu::with_items(app, &[&open, &sep()?, &login, &updates, &sep()?, &quit])?;
    *app.state::<Shared>().update_item.lock().unwrap() = Some(updates);
    let login_item = login.clone();
    TrayIconBuilder::with_id("main")
        .icon(Image::from_bytes(include_bytes!("../icons/tray.png"))?)
        .tooltip("faztudo")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "open" => show(app),
            "autostart" => {
                let want = login_item.is_checked().unwrap_or(false);
                if let Err(e) = autostart::set(want) {
                    let _ = login_item.set_checked(!want);
                    app.dialog()
                        .message(format!("Could not change the login item: {e}"))
                        .show(|_| {});
                }
            }
            "update" => {
                let newer = app.state::<Shared>().newer.lock().unwrap().clone();
                match newer {
                    Some(_) => open_external(&Url::parse(update::RELEASES).expect("valid url")),
                    None => check_updates(app.clone(), true),
                }
            }
            "quit" => ask_quit(app),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

/// Looks for a newer release. The automatic check runs at most once a day;
/// `asked` is a click on the tray item and always checks and answers.
fn check_updates(app: AppHandle, asked: bool) {
    if !asked && (update::disabled() || !update::due()) {
        return;
    }
    std::thread::spawn(move || {
        let latest = update::latest();
        let mine = env!("CARGO_PKG_VERSION");
        match latest {
            Some(tag) if update::newer(&tag, mine) => {
                let shared = app.state::<Shared>();
                if let Some(item) = shared.update_item.lock().unwrap().as_ref() {
                    let _ = item.set_text(format!("Download faztudo {tag}"));
                }
                *shared.newer.lock().unwrap() = Some(tag.clone());
                if asked {
                    open_external(&Url::parse(update::RELEASES).expect("valid url"));
                }
            }
            Some(_) if asked => {
                app.dialog()
                    .message(format!("faztudo desktop {mine} is the latest release."))
                    .show(|_| {});
            }
            None if asked => {
                app.dialog()
                    .message("Could not reach GitHub to check for a new release.")
                    .show(|_| {});
            }
            _ => {}
        }
    });
}

/// Quit asks whether faztudo and its agent runs keep working after the
/// window closes.
fn ask_quit(app: &AppHandle) {
    let handle = app.clone();
    app.dialog()
        .message(
            "faztudo and its agent runs can keep working without this window, and you can open it \
             again from the menu. Stop faztudo and cancel its running agents too?",
        )
        .title("Quit faztudo desktop")
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::YesNoCancelCustom(
            "Leave faztudo running".into(),
            "Stop faztudo".into(),
            "Cancel".into(),
        ))
        .show_with_result(move |result| match result {
            MessageDialogResult::Custom(choice) if choice == "Stop faztudo" => stop_and_exit(handle),
            MessageDialogResult::Custom(choice) if choice == "Leave faztudo running" => handle.exit(0),
            MessageDialogResult::Yes => handle.exit(0),
            MessageDialogResult::No => stop_and_exit(handle),
            _ => {}
        });
}

fn stop_and_exit(app: AppHandle) {
    std::thread::spawn(move || {
        let shared = app.state::<Shared>();
        let bin = shared.binary.lock().unwrap().clone();
        let started = *shared.started.lock().unwrap();
        let outcome = bin.as_ref().map(|b| daemon::stop(&b.path));
        let left = matches!(&outcome, Some(Ok(s)) if s.daemon == "left_running");
        if left {
            if let (Some(daemon::Started::Child), Some(child)) = (started, shared.child.lock().unwrap().as_mut()) {
                daemon::terminate(child);
            } else {
                let h = app.clone();
                app.dialog()
                    .message(
                        "faztudo was started outside this app, so it is still running. Its agent runs were cancelled.",
                    )
                    .show(move |_| h.exit(0));
                return;
            }
        }
        if let Some(Err(e)) = outcome {
            let h = app.clone();
            app.dialog()
                .message(format!("faztudo could not be stopped: {e}"))
                .kind(MessageDialogKind::Error)
                .show(move |_| h.exit(0));
            return;
        }
        app.exit(0);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn navigation_stays_on_the_start_page_and_the_daemon() {
        let origin = Some("http://127.0.0.1:7457");
        let ok = |u: &str| allowed(&Url::parse(u).unwrap(), origin);
        assert!(ok("tauri://localhost/index.html"));
        assert!(ok("http://127.0.0.1:7457/office"));
        assert!(ok("http://127.0.0.1:7457/auth/local#abc"));
        assert!(!ok("http://127.0.0.1:7458/"));
        assert!(!ok("https://127.0.0.1:7457/"));
        assert!(!ok("https://github.com/thiagodefreitas/faztudo"));
        assert!(!ok("http://localhost:7457/"));
        assert!(!allowed(&Url::parse("http://127.0.0.1:7457/").unwrap(), None));
    }
}
