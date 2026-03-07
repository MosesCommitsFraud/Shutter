mod models;
mod storage;

use std::{path::Path, process::Command, sync::Mutex, time::Duration};

use chrono::Local;
use image::{DynamicImage, RgbaImage};
use models::{
    AppConfig, BootstrapPayload, CaptureKind, DisplayContext, FlashPreviewPayload, HotkeyConfig,
    PendingSelection, PersistedState, RegionCaptureRequest, ScreenshotRecord, WindowContext,
};
use tauri::{
    menu::MenuBuilder,
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Position, Size, State, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder, Wry,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use uuid::Uuid;
use xcap::{Monitor, Window};

const MAIN_LABEL: &str = "main";
const SELECTION_LABEL: &str = "selection_overlay";
const FLASH_LABEL: &str = "flash_overlay";

const EVENT_LIBRARY_UPDATED: &str = "flashbang://library-updated";
const EVENT_FLASH_PREVIEW: &str = "flashbang://flash-preview";

const TRAY_OPEN_ID: &str = "open-manager";
const TRAY_CAPTURE_ID: &str = "capture-display";
const TRAY_REGION_ID: &str = "capture-region";
const TRAY_QUIT_ID: &str = "quit";

struct AppState {
    inner: Mutex<RuntimeState>,
}

struct RuntimeState {
    persisted: PersistedState,
    pending_selection: Option<PendingSelection>,
    flash_seq: u64,
}

struct CaptureTarget {
    monitor: Monitor,
    display: DisplayContext,
    active_window: Option<WindowContext>,
    visible_windows: Vec<WindowContext>,
    primary_app: String,
}

fn app_err<E: std::fmt::Display>(error: E) -> String {
    error.to_string()
}

fn state_snapshot(runtime: &RuntimeState) -> BootstrapPayload {
    BootstrapPayload {
        config: runtime.persisted.config.clone(),
        screenshots: runtime.persisted.library.screenshots.clone(),
    }
}

fn persist_runtime_state(state: &AppState) -> Result<(), String> {
    let persisted = {
        let runtime = state.inner.lock().map_err(app_err)?;
        runtime.persisted.clone()
    };
    storage::save_state(&persisted)
}

fn show_main_window(app: &AppHandle<Wry>) -> Result<(), String> {
    let window = app
        .get_webview_window(MAIN_LABEL)
        .ok_or_else(|| String::from("Main window is unavailable"))?;
    let _ = window.unminimize();
    window.show().map_err(app_err)?;
    window.set_focus().map_err(app_err)?;
    Ok(())
}

fn hide_main_window(app: &AppHandle<Wry>) -> Result<(), String> {
    let window = app
        .get_webview_window(MAIN_LABEL)
        .ok_or_else(|| String::from("Main window is unavailable"))?;
    window.hide().map_err(app_err)
}

fn slugify(input: &str) -> String {
    let mut output = String::new();
    let mut last_dash = false;

    for character in input.chars() {
        if character.is_ascii_alphanumeric() {
            output.push(character.to_ascii_lowercase());
            last_dash = false;
        } else if !last_dash {
            output.push('-');
            last_dash = true;
        }
    }

    output.trim_matches('-').chars().take(48).collect()
}

fn rects_intersect(
    left_x: i32,
    left_y: i32,
    left_width: u32,
    left_height: u32,
    right_x: i32,
    right_y: i32,
    right_width: u32,
    right_height: u32,
) -> bool {
    let left_right = left_x as i64 + left_width as i64;
    let left_bottom = left_y as i64 + left_height as i64;
    let right_right = right_x as i64 + right_width as i64;
    let right_bottom = right_y as i64 + right_height as i64;

    (left_x as i64) < right_right
        && left_right > right_x as i64
        && (left_y as i64) < right_bottom
        && left_bottom > right_y as i64
}

fn monitor_to_context(monitor: &Monitor) -> Result<DisplayContext, String> {
    Ok(DisplayContext {
        id: monitor.id().map_err(app_err)?,
        name: monitor.name().unwrap_or_else(|_| String::from("Display")),
        x: monitor.x().map_err(app_err)?,
        y: monitor.y().map_err(app_err)?,
        width: monitor.width().map_err(app_err)?,
        height: monitor.height().map_err(app_err)?,
        scale_factor: monitor.scale_factor().unwrap_or(1.0),
        is_primary: monitor.is_primary().unwrap_or(false),
    })
}

fn window_to_context(window: &Window, display: &DisplayContext) -> Result<WindowContext, String> {
    let x = window.x().map_err(app_err)?;
    let y = window.y().map_err(app_err)?;
    let width = window.width().map_err(app_err)?;
    let height = window.height().map_err(app_err)?;
    let title = window.title().unwrap_or_default();
    let app_name = window.app_name().unwrap_or_default();
    let epsilon = 12_i64;
    let is_fullscreen = (x - display.x).abs() as i64 <= epsilon
        && (y - display.y).abs() as i64 <= epsilon
        && (width as i64 - display.width as i64).abs() <= epsilon
        && (height as i64 - display.height as i64).abs() <= epsilon;

    Ok(WindowContext {
        id: window.id().map_err(app_err)?,
        app_name,
        title,
        x,
        y,
        width,
        height,
        z: window.z().unwrap_or_default(),
        is_maximized: window.is_maximized().unwrap_or(false),
        is_focused: window.is_focused().unwrap_or(false),
        is_fullscreen,
    })
}

fn normalize_windows(mut windows: Vec<WindowContext>) -> Vec<WindowContext> {
    windows.retain(|window| {
        (window.width > 60 && window.height > 60)
            && !(window.title.trim().is_empty() && window.app_name.trim().is_empty())
    });
    windows.sort_by(|left, right| {
        right
            .is_focused
            .cmp(&left.is_focused)
            .then_with(|| right.is_fullscreen.cmp(&left.is_fullscreen))
            .then_with(|| right.is_maximized.cmp(&left.is_maximized))
            .then_with(|| {
                (right.width as u64 * right.height as u64)
                    .cmp(&(left.width as u64 * left.height as u64))
            })
            .then_with(|| left.z.cmp(&right.z))
    });
    windows
}

fn resolve_capture_target() -> Result<CaptureTarget, String> {
    let windows = Window::all().map_err(app_err)?;
    let monitors = Monitor::all().map_err(app_err)?;

    let focused_window = windows.iter().find(|window| {
        window.is_focused().unwrap_or(false) && !window.is_minimized().unwrap_or(false)
    });

    let monitor = if let Some(window) = focused_window {
        window.current_monitor().map_err(app_err)?
    } else {
        monitors
            .into_iter()
            .find(|monitor| monitor.is_primary().unwrap_or(false))
            .ok_or_else(|| String::from("No monitors available"))?
    };

    let display = monitor_to_context(&monitor)?;
    let visible_windows = normalize_windows(
        windows
            .iter()
            .filter(|window| !window.is_minimized().unwrap_or(false))
            .filter_map(|window| window_to_context(window, &display).ok())
            .filter(|window| {
                rects_intersect(
                    display.x,
                    display.y,
                    display.width,
                    display.height,
                    window.x,
                    window.y,
                    window.width,
                    window.height,
                )
            })
            .collect(),
    );

    let active_window = visible_windows
        .iter()
        .find(|window| window.is_focused)
        .cloned();
    let primary_app = active_window
        .as_ref()
        .map(|window| window.app_name.clone())
        .filter(|app| !app.trim().is_empty())
        .or_else(|| {
            visible_windows
                .first()
                .map(|window| window.app_name.clone())
                .filter(|app| !app.trim().is_empty())
        })
        .unwrap_or_else(|| String::from("Desktop"));

    Ok(CaptureTarget {
        monitor,
        display,
        active_window,
        visible_windows,
        primary_app,
    })
}

fn find_monitor(display: &DisplayContext) -> Result<Monitor, String> {
    Monitor::all()
        .map_err(app_err)?
        .into_iter()
        .find(|monitor| monitor.id().ok() == Some(display.id))
        .ok_or_else(|| String::from("The target display is no longer available"))
}

fn save_capture(
    app_state: &AppState,
    image: RgbaImage,
    target: &CaptureTarget,
    capture_kind: CaptureKind,
) -> Result<ScreenshotRecord, String> {
    let mut runtime = app_state.inner.lock().map_err(app_err)?;
    let save_dir = Path::new(&runtime.persisted.config.save_dir);
    storage::ensure_save_dir(save_dir)?;

    let created_at = Local::now();
    let title_hint = target
        .active_window
        .as_ref()
        .map(|window| format!("{} {}", window.app_name, window.title))
        .unwrap_or_else(|| target.primary_app.clone());
    let slug = {
        let normalized = slugify(&title_hint);
        if normalized.is_empty() {
            String::from("capture")
        } else {
            normalized
        }
    };
    let suffix = match capture_kind {
        CaptureKind::Display => "display",
        CaptureKind::Region => "region",
    };
    let id = Uuid::new_v4().to_string();
    let file_name = format!(
        "{}-{}-{}-{}.png",
        created_at.format("%Y%m%d-%H%M%S"),
        suffix,
        slug,
        &id[..8]
    );
    let file_path = save_dir.join(&file_name);

    DynamicImage::ImageRgba8(image.clone())
        .save(&file_path)
        .map_err(app_err)?;

    let record = ScreenshotRecord {
        id,
        file_name,
        file_path: file_path.to_string_lossy().to_string(),
        created_at: created_at.to_rfc3339(),
        capture_kind,
        width: image.width(),
        height: image.height(),
        primary_app: target.primary_app.clone(),
        tags: Vec::new(),
        display: target.display.clone(),
        active_window: target.active_window.clone(),
        visible_windows: target.visible_windows.clone(),
    };

    runtime
        .persisted
        .library
        .screenshots
        .retain(|existing| existing.id != record.id);
    runtime
        .persisted
        .library
        .screenshots
        .insert(0, record.clone());
    storage::prune_missing_files(&mut runtime.persisted.library.screenshots);
    let persisted = runtime.persisted.clone();
    drop(runtime);
    storage::save_state(&persisted)?;

    Ok(record)
}

fn sync_window_to_display(
    window: &WebviewWindow<Wry>,
    display: &DisplayContext,
) -> Result<(), String> {
    window
        .set_position(Position::Physical(PhysicalPosition::new(
            display.x, display.y,
        )))
        .map_err(app_err)?;
    window
        .set_size(Size::Physical(PhysicalSize::new(
            display.width,
            display.height,
        )))
        .map_err(app_err)?;
    Ok(())
}

fn show_flash_preview(
    app: &AppHandle<Wry>,
    app_state: &AppState,
    record: &ScreenshotRecord,
) -> Result<(), String> {
    let payload = {
        let mut runtime = app_state.inner.lock().map_err(app_err)?;
        runtime.flash_seq += 1;
        FlashPreviewPayload {
            file_path: record.file_path.clone(),
            seq: runtime.flash_seq,
            flash_opacity: runtime.persisted.config.flash_opacity,
            primary_app: record.primary_app.clone(),
            capture_kind: record.capture_kind.clone(),
        }
    };

    let window = app
        .get_webview_window(FLASH_LABEL)
        .ok_or_else(|| String::from("Flash preview window is unavailable"))?;
    sync_window_to_display(&window, &record.display)?;
    window.show().map_err(app_err)?;
    app.emit_to(FLASH_LABEL, EVENT_FLASH_PREVIEW, payload)
        .map_err(app_err)?;

    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(900)).await;
        if let Some(window) = app_handle.get_webview_window(FLASH_LABEL) {
            let _ = window.hide();
        }
    });

    Ok(())
}

fn emit_library_updated(app: &AppHandle<Wry>) -> Result<(), String> {
    app.emit(EVENT_LIBRARY_UPDATED, ()).map_err(app_err)
}

fn capture_display(app: &AppHandle<Wry>, app_state: &AppState) -> Result<(), String> {
    let target = resolve_capture_target()?;
    let image = target.monitor.capture_image().map_err(app_err)?;
    let record = save_capture(app_state, image, &target, CaptureKind::Display)?;
    show_flash_preview(app, app_state, &record)?;
    emit_library_updated(app)
}

fn begin_region_capture_inner(app: &AppHandle<Wry>, app_state: &AppState) -> Result<(), String> {
    let target = resolve_capture_target()?;
    {
        let mut runtime = app_state.inner.lock().map_err(app_err)?;
        runtime.pending_selection = Some(PendingSelection {
            display: target.display.clone(),
            active_window: target.active_window.clone(),
            visible_windows: target.visible_windows.clone(),
        });
    }

    let overlay = app
        .get_webview_window(SELECTION_LABEL)
        .ok_or_else(|| String::from("Selection overlay is unavailable"))?;
    sync_window_to_display(&overlay, &target.display)?;
    overlay.show().map_err(app_err)?;
    overlay.set_focus().map_err(app_err)?;
    Ok(())
}

fn register_shortcuts(app: &AppHandle<Wry>, config: &AppConfig) -> Result<(), String> {
    let shortcut_manager = app.global_shortcut();
    let _ = shortcut_manager.unregister_all();

    let capture_shortcut = config.capture_hotkey.clone();
    shortcut_manager
        .on_shortcut(
            capture_shortcut.as_str(),
            move |app_handle, _shortcut, event| {
                if event.state == ShortcutState::Pressed {
                    let state = app_handle.state::<AppState>();
                    let _ = capture_display(app_handle, &state);
                }
            },
        )
        .map_err(app_err)?;

    let region_shortcut = config.region_hotkey.clone();
    shortcut_manager
        .on_shortcut(
            region_shortcut.as_str(),
            move |app_handle, _shortcut, event| {
                if event.state == ShortcutState::Pressed {
                    let state = app_handle.state::<AppState>();
                    let _ = begin_region_capture_inner(app_handle, &state);
                }
            },
        )
        .map_err(app_err)?;

    Ok(())
}

fn reveal_in_file_manager(path: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .args(["/select,", path])
            .spawn()
            .map_err(app_err)?;
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .args(["-R", path])
            .spawn()
            .map_err(app_err)?;
    }

    Ok(())
}

fn open_file(path: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        Command::new("cmd")
            .args(["/C", "start", "", path])
            .spawn()
            .map_err(app_err)?;
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open").arg(path).spawn().map_err(app_err)?;
    }

    Ok(())
}

fn setup_auxiliary_windows(app: &AppHandle<Wry>) -> Result<(), String> {
    if app.get_webview_window(SELECTION_LABEL).is_none() {
        WebviewWindowBuilder::new(app, SELECTION_LABEL, WebviewUrl::App("index.html".into()))
            .title("Flashbang Selection")
            .visible(false)
            .decorations(false)
            .transparent(true)
            .always_on_top(true)
            .skip_taskbar(true)
            .shadow(false)
            .resizable(false)
            .build()
            .map_err(app_err)?;
    }

    if app.get_webview_window(FLASH_LABEL).is_none() {
        WebviewWindowBuilder::new(app, FLASH_LABEL, WebviewUrl::App("index.html".into()))
            .title("Flashbang Preview")
            .visible(false)
            .decorations(false)
            .transparent(true)
            .always_on_top(true)
            .skip_taskbar(true)
            .shadow(false)
            .focused(false)
            .resizable(false)
            .build()
            .map_err(app_err)?;
    }

    Ok(())
}

fn setup_tray(app: &AppHandle<Wry>) -> Result<(), String> {
    let menu = MenuBuilder::new(app)
        .text(TRAY_OPEN_ID, "Open Manager")
        .text(TRAY_CAPTURE_ID, "Capture Display")
        .text(TRAY_REGION_ID, "Capture Area")
        .separator()
        .text(TRAY_QUIT_ID, "Quit")
        .build()
        .map_err(app_err)?;

    let mut tray = TrayIconBuilder::with_id("flashbang-tray")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            TRAY_OPEN_ID => {
                let _ = show_main_window(app);
            }
            TRAY_CAPTURE_ID => {
                let state = app.state::<AppState>();
                let _ = capture_display(app, &state);
            }
            TRAY_REGION_ID => {
                let state = app.state::<AppState>();
                let _ = begin_region_capture_inner(app, &state);
            }
            TRAY_QUIT_ID => {
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let _ = show_main_window(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        tray = tray.icon(icon);
    }

    tray.build(app).map_err(app_err)?;
    Ok(())
}

#[tauri::command]
fn bootstrap_state(state: State<'_, AppState>) -> Result<BootstrapPayload, String> {
    {
        let mut runtime = state.inner.lock().map_err(app_err)?;
        storage::prune_missing_files(&mut runtime.persisted.library.screenshots);
    }
    persist_runtime_state(&state)?;
    let runtime = state.inner.lock().map_err(app_err)?;
    Ok(state_snapshot(&runtime))
}

#[tauri::command]
async fn pick_save_directory() -> Result<Option<String>, String> {
    let suggested = storage::default_save_dir()?;
    tauri::async_runtime::spawn_blocking(move || {
        Ok(rfd::FileDialog::new()
            .set_directory(suggested)
            .pick_folder()
            .map(|path| path.to_string_lossy().to_string()))
    })
    .await
    .map_err(app_err)?
}

#[tauri::command]
fn set_save_directory(
    path: String,
    state: State<'_, AppState>,
) -> Result<BootstrapPayload, String> {
    storage::ensure_save_dir(Path::new(&path))?;
    {
        let mut runtime = state.inner.lock().map_err(app_err)?;
        runtime.persisted.config.save_dir = path;
        runtime.persisted.config.onboarding_complete = true;
    }
    persist_runtime_state(&state)?;
    let runtime = state.inner.lock().map_err(app_err)?;
    Ok(state_snapshot(&runtime))
}

#[tauri::command]
fn set_hotkeys(
    app: AppHandle<Wry>,
    state: State<'_, AppState>,
    hotkeys: HotkeyConfig,
) -> Result<BootstrapPayload, String> {
    {
        let mut runtime = state.inner.lock().map_err(app_err)?;
        runtime.persisted.config.capture_hotkey = hotkeys.capture_hotkey.trim().to_string();
        runtime.persisted.config.region_hotkey = hotkeys.region_hotkey.trim().to_string();
    }
    {
        let runtime = state.inner.lock().map_err(app_err)?;
        register_shortcuts(&app, &runtime.persisted.config)?;
    }
    persist_runtime_state(&state)?;
    let runtime = state.inner.lock().map_err(app_err)?;
    Ok(state_snapshot(&runtime))
}

#[tauri::command]
fn capture_now(app: AppHandle<Wry>, state: State<'_, AppState>) -> Result<(), String> {
    capture_display(&app, &state)
}

#[tauri::command]
fn begin_region_capture(app: AppHandle<Wry>, state: State<'_, AppState>) -> Result<(), String> {
    begin_region_capture_inner(&app, &state)
}

#[tauri::command]
fn get_pending_selection(state: State<'_, AppState>) -> Result<Option<PendingSelection>, String> {
    let runtime = state.inner.lock().map_err(app_err)?;
    Ok(runtime.pending_selection.clone())
}

#[tauri::command]
fn cancel_region_capture(app: AppHandle<Wry>, state: State<'_, AppState>) -> Result<(), String> {
    {
        let mut runtime = state.inner.lock().map_err(app_err)?;
        runtime.pending_selection = None;
    }
    if let Some(window) = app.get_webview_window(SELECTION_LABEL) {
        window.hide().map_err(app_err)?;
    }
    Ok(())
}

#[tauri::command]
fn capture_region(
    app: AppHandle<Wry>,
    state: State<'_, AppState>,
    request: RegionCaptureRequest,
) -> Result<(), String> {
    let pending = {
        let mut runtime = state.inner.lock().map_err(app_err)?;
        runtime.pending_selection.take()
    }
    .ok_or_else(|| String::from("No region capture is currently active"))?;

    if let Some(window) = app.get_webview_window(SELECTION_LABEL) {
        let _ = window.hide();
    }

    let monitor = find_monitor(&pending.display)?;
    let viewport_width = request.viewport_width.max(1.0);
    let viewport_height = request.viewport_height.max(1.0);

    let scale_x = pending.display.width as f64 / viewport_width;
    let scale_y = pending.display.height as f64 / viewport_height;

    let x = (request.x.max(0.0) * scale_x).round() as u32;
    let y = (request.y.max(0.0) * scale_y).round() as u32;
    let width = (request.width.max(1.0) * scale_x).round() as u32;
    let height = (request.height.max(1.0) * scale_y).round() as u32;

    let max_width = pending.display.width.saturating_sub(x);
    let max_height = pending.display.height.saturating_sub(y);
    let clamped_width = width.min(max_width).max(1);
    let clamped_height = height.min(max_height).max(1);

    let image = monitor
        .capture_region(x, y, clamped_width, clamped_height)
        .map_err(app_err)?;
    let target = CaptureTarget {
        monitor,
        display: pending.display.clone(),
        active_window: pending.active_window.clone(),
        visible_windows: pending.visible_windows.clone(),
        primary_app: pending
            .active_window
            .as_ref()
            .map(|window| window.app_name.clone())
            .filter(|name| !name.trim().is_empty())
            .or_else(|| {
                pending
                    .visible_windows
                    .first()
                    .map(|window| window.app_name.clone())
                    .filter(|name| !name.trim().is_empty())
            })
            .unwrap_or_else(|| String::from("Desktop")),
    };
    let record = save_capture(&state, image, &target, CaptureKind::Region)?;
    show_flash_preview(&app, &state, &record)?;
    emit_library_updated(&app)
}

#[tauri::command]
fn update_tags(
    id: String,
    tags: Vec<String>,
    state: State<'_, AppState>,
) -> Result<BootstrapPayload, String> {
    {
        let mut runtime = state.inner.lock().map_err(app_err)?;
        if let Some(record) = runtime
            .persisted
            .library
            .screenshots
            .iter_mut()
            .find(|record| record.id == id)
        {
            record.tags = tags
                .into_iter()
                .map(|tag| tag.trim().to_string())
                .filter(|tag| !tag.is_empty())
                .collect();
        }
    }
    persist_runtime_state(&state)?;
    let runtime = state.inner.lock().map_err(app_err)?;
    Ok(state_snapshot(&runtime))
}

#[tauri::command]
fn reveal_screenshot(path: String) -> Result<(), String> {
    reveal_in_file_manager(&path)
}

#[tauri::command]
fn open_screenshot(path: String) -> Result<(), String> {
    open_file(&path)
}

#[tauri::command]
fn show_manager(app: AppHandle<Wry>) -> Result<(), String> {
    show_main_window(&app)
}

#[tauri::command]
fn hide_manager(app: AppHandle<Wry>) -> Result<(), String> {
    hide_main_window(&app)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let persisted = storage::load_state().expect("failed to load state");

    let app_state = AppState {
        inner: Mutex::new(RuntimeState {
            persisted,
            pending_selection: None,
            flash_seq: 0,
        }),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            let _ = show_main_window(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .manage(app_state)
        .setup(|app| {
            setup_auxiliary_windows(app.handle())?;
            setup_tray(app.handle())?;

            let state = app.state::<AppState>();
            {
                let mut runtime = state.inner.lock().map_err(app_err)?;
                storage::prune_missing_files(&mut runtime.persisted.library.screenshots);
            }
            persist_runtime_state(&state)?;

            {
                let runtime = state.inner.lock().map_err(app_err)?;
                register_shortcuts(app.handle(), &runtime.persisted.config)?;
                if !runtime.persisted.config.onboarding_complete {
                    show_main_window(app.handle())?;
                }
            }

            if let Some(main_window) = app.get_webview_window(MAIN_LABEL) {
                let app_handle = app.handle().clone();
                main_window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = hide_main_window(&app_handle);
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            bootstrap_state,
            pick_save_directory,
            set_save_directory,
            set_hotkeys,
            capture_now,
            begin_region_capture,
            get_pending_selection,
            cancel_region_capture,
            capture_region,
            update_tags,
            reveal_screenshot,
            open_screenshot,
            show_manager,
            hide_manager
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
