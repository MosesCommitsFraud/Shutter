use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    pub save_dir: String,
    pub capture_hotkey: String,
    pub region_hotkey: String,
    pub flash_opacity: f32,
    pub onboarding_complete: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotLibrary {
    pub screenshots: Vec<ScreenshotRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagDefinition {
    pub id: String,
    pub name: String,
    pub color: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedState {
    pub config: AppConfig,
    pub library: ScreenshotLibrary,
    #[serde(default)]
    pub tag_definitions: Vec<TagDefinition>,
}

impl Default for PersistedState {
    fn default() -> Self {
        Self {
            config: AppConfig::default(),
            library: ScreenshotLibrary::default(),
            tag_definitions: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapPayload {
    pub config: AppConfig,
    pub screenshots: Vec<ScreenshotRecord>,
    pub tag_definitions: Vec<TagDefinition>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotRecord {
    pub id: String,
    pub file_name: String,
    pub file_path: String,
    #[serde(default)]
    pub thumbnail_path: Option<String>,
    pub created_at: String,
    pub capture_kind: CaptureKind,
    pub width: u32,
    pub height: u32,
    pub primary_app: String,
    pub tags: Vec<String>,
    pub display: DisplayContext,
    pub active_window: Option<WindowContext>,
    pub visible_windows: Vec<WindowContext>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayContext {
    pub id: u32,
    pub name: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale_factor: f32,
    pub is_primary: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowContext {
    pub id: u32,
    pub app_name: String,
    pub title: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub z: i32,
    pub is_maximized: bool,
    pub is_focused: bool,
    pub is_fullscreen: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingSelection {
    pub display: DisplayContext,
    pub active_window: Option<WindowContext>,
    pub visible_windows: Vec<WindowContext>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegionCaptureRequest {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub viewport_width: f64,
    pub viewport_height: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HotkeyConfig {
    pub capture_hotkey: String,
    pub region_hotkey: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlashPreviewPayload {
    pub file_path: String,
    pub seq: u64,
    pub flash_opacity: f32,
    pub primary_app: String,
    pub capture_kind: CaptureKind,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewerPayload {
    pub files: Vec<String>,
    pub current_index: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CaptureKind {
    Display,
    Region,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            save_dir: String::new(),
            capture_hotkey: String::from("CmdOrControl+Alt+5"),
            region_hotkey: String::from("CmdOrControl+Alt+6"),
            flash_opacity: 0.32,
            onboarding_complete: false,
        }
    }
}
