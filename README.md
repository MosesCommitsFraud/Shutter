# Flashbang

Flashbang is a Tauri desktop utility for background screenshots and lightweight screenshot management.

## Current scope

- Resident-style desktop app with tray controls
- Global hotkeys for display capture and area capture
- Screen flash feedback with a thumbnail slide animation
- Save folder selection and persistent app settings
- Screenshot manager with search, tags, and window-context metadata
- Display-aware window indexing based on the monitor that was captured

## Default hotkeys

- `CmdOrControl+Alt+5`: capture the current display
- `CmdOrControl+Alt+6`: capture a dragged area on the current display

You can change both in the manager UI.

## Run in development

```bash
npm install
npm run tauri dev
```

## Build installers

```bash
npm run tauri build
```

Windows bundles are emitted under:

- `src-tauri/target/release/bundle/msi/`
- `src-tauri/target/release/bundle/nsis/`

## Notes

- The codebase is structured for Windows and macOS, but only Windows was built and verified in this workspace.
- Global hotkeys and non-focus flash overlays are native. Area selection still requires an interactive overlay window.
- Truly reliable capture over exclusive fullscreen games may still require deeper platform-specific native work beyond Tauri window overlays.
