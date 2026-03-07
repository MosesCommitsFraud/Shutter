use std::{
    fs,
    path::{Path, PathBuf},
};

use directories::{ProjectDirs, UserDirs};

use crate::models::{PersistedState, ScreenshotRecord};

const ORG_QUALIFIER: &str = "com";
const ORG_NAME: &str = "Flashbang";
const APP_NAME: &str = "Flashbang";
const STATE_FILE: &str = "state.json";

fn project_dirs() -> Result<ProjectDirs, String> {
    ProjectDirs::from(ORG_QUALIFIER, ORG_NAME, APP_NAME)
        .ok_or_else(|| String::from("Unable to resolve application directories"))
}

pub fn default_save_dir() -> Result<PathBuf, String> {
    let user_dirs =
        UserDirs::new().ok_or_else(|| String::from("Unable to resolve user directories"))?;
    if let Some(pictures_dir) = user_dirs.picture_dir() {
        Ok(pictures_dir.join("Flashbang"))
    } else {
        Ok(user_dirs.home_dir().join("Pictures").join("Flashbang"))
    }
}

pub fn ensure_save_dir(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|error| error.to_string())
}

fn state_path() -> Result<PathBuf, String> {
    let dirs = project_dirs()?;
    let data_dir = dirs.data_dir();
    fs::create_dir_all(data_dir).map_err(|error| error.to_string())?;
    Ok(data_dir.join(STATE_FILE))
}

pub fn load_state() -> Result<PersistedState, String> {
    let path = state_path()?;
    if !path.exists() {
        let mut state = PersistedState::default();
        state.config.save_dir = default_save_dir()?.to_string_lossy().to_string();
        return Ok(state);
    }

    let raw = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    let mut state: PersistedState =
        serde_json::from_str(&raw).map_err(|error| error.to_string())?;
    if state.config.save_dir.trim().is_empty() {
        state.config.save_dir = default_save_dir()?.to_string_lossy().to_string();
    }
    Ok(state)
}

pub fn save_state(state: &PersistedState) -> Result<(), String> {
    let path = state_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let serialized = serde_json::to_string_pretty(state).map_err(|error| error.to_string())?;
    fs::write(path, serialized).map_err(|error| error.to_string())
}

pub fn prune_missing_files(screenshots: &mut Vec<ScreenshotRecord>) {
    screenshots.retain(|record| Path::new(&record.file_path).exists());
    screenshots.sort_by(|left, right| right.created_at.cmp(&left.created_at));
}
