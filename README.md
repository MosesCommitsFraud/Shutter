# Shutter

Shutter is a Tauri desktop utility for background screenshots and lightweight screenshot management.

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
pnpm install
pnpm tauri dev
```

## Build installers

```bash
pnpm tauri build
```
