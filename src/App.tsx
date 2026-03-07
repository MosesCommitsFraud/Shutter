import {
  startTransition,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useMemo,
  useState,
} from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./styles.css";

type CaptureKind = "display" | "region";

type AppConfig = {
  saveDir: string;
  captureHotkey: string;
  regionHotkey: string;
  flashOpacity: number;
  onboardingComplete: boolean;
};

type DisplayContext = {
  id: number;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  scaleFactor: number;
  isPrimary: boolean;
};

type WindowContext = {
  id: number;
  appName: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
  isMaximized: boolean;
  isFocused: boolean;
  isFullscreen: boolean;
};

type ScreenshotRecord = {
  id: string;
  fileName: string;
  filePath: string;
  createdAt: string;
  captureKind: CaptureKind;
  width: number;
  height: number;
  primaryApp: string;
  tags: string[];
  display: DisplayContext;
  activeWindow: WindowContext | null;
  visibleWindows: WindowContext[];
};

type BootstrapPayload = {
  config: AppConfig;
  screenshots: ScreenshotRecord[];
};

type PendingSelection = {
  display: DisplayContext;
  activeWindow: WindowContext | null;
  visibleWindows: WindowContext[];
};

type FlashPreviewPayload = {
  filePath: string;
  seq: number;
  flashOpacity: number;
  primaryApp: string;
  captureKind: CaptureKind;
};

type Rect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

const currentWebview = getCurrentWebviewWindow();
const currentWindow = getCurrentWindow();
const viewLabel = currentWebview.label;

function normalizeRect(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
): Rect {
  return {
    left: Math.min(startX, endX),
    top: Math.min(startY, endY),
    width: Math.abs(endX - startX),
    height: Math.abs(endY - startY),
  };
}

function formatTimestamp(timestamp: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestamp));
}

function screenshotSrc(path: string): string {
  return convertFileSrc(path);
}

function FlashOverlay() {
  const [payload, setPayload] = useState<FlashPreviewPayload | null>(null);

  useEffect(() => {
    document.body.dataset.view = "flash";
  }, []);

  const handlePreview = useEffectEvent((eventPayload: FlashPreviewPayload) => {
    setPayload(eventPayload);
  });

  useEffect(() => {
    let mounted = true;

    const setup = async () => {
      const unlisten = await listen<FlashPreviewPayload>(
        "flashbang://flash-preview",
        (event) => {
          if (mounted) {
            handlePreview(event.payload);
          }
        },
      );

      return unlisten;
    };

    let unlisten: (() => void) | undefined;
    void setup().then((callback) => {
      unlisten = callback;
    });

    return () => {
      mounted = false;
      unlisten?.();
    };
  }, [handlePreview]);

  if (!payload) {
    return <div className="flash-root" />;
  }

  return (
    <div className="flash-root" key={payload.seq}>
      <div
        className="flash-bloom"
        style={{ ["--flash-opacity" as string]: String(payload.flashOpacity) }}
      />
      <div className="flash-card">
        <img
          className="flash-card__image"
          src={screenshotSrc(payload.filePath)}
          alt=""
        />
        <div className="flash-card__meta">
          <span>{payload.primaryApp}</span>
          <span>{payload.captureKind === "region" ? "Area" : "Display"}</span>
        </div>
      </div>
    </div>
  );
}

function SelectionOverlay() {
  const [pending, setPending] = useState<PendingSelection | null>(null);
  const [origin, setOrigin] = useState<{ x: number; y: number } | null>(null);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const selection =
    origin && cursor
      ? normalizeRect(origin.x, origin.y, cursor.x, cursor.y)
      : null;

  useEffect(() => {
    document.body.dataset.view = "selection";
  }, []);

  useEffect(() => {
    void invoke<PendingSelection | null>("get_pending_selection").then(
      (value) => {
        if (!value) {
          void invoke("cancel_region_capture").catch(() => undefined);
        }
        setPending(value);
      },
    );
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        void invoke("cancel_region_capture");
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  if (!pending) {
    return <div className="selection-root" />;
  }

  const finishSelection = async (rect: Rect) => {
    if (rect.width < 8 || rect.height < 8 || submitting) {
      setOrigin(null);
      setCursor(null);
      return;
    }

    setSubmitting(true);

    try {
      await invoke("capture_region", {
        request: {
          x: rect.left,
          y: rect.top,
          width: rect.width,
          height: rect.height,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
        },
      });
    } finally {
      setSubmitting(false);
      setOrigin(null);
      setCursor(null);
    }
  };

  return (
    <div
      className="selection-root"
      onMouseDown={(event) => {
        setOrigin({ x: event.clientX, y: event.clientY });
        setCursor({ x: event.clientX, y: event.clientY });
      }}
      onMouseMove={(event) => {
        if (origin) {
          setCursor({ x: event.clientX, y: event.clientY });
        }
      }}
      onMouseUp={() => {
        if (selection) {
          void finishSelection(selection);
        }
      }}
    >
      <div className="selection-hud">
        <span className="selection-pill">Flashbang Area Capture</span>
        <span className="selection-copy">
          Drag over the target area. Press Esc to cancel.
        </span>
      </div>

      {selection ? (
        <div
          className="selection-box"
          style={{
            left: `${selection.left}px`,
            top: `${selection.top}px`,
            width: `${selection.width}px`,
            height: `${selection.height}px`,
          }}
        >
          <span className="selection-size">
            {Math.round(selection.width)} x {Math.round(selection.height)}
          </span>
        </div>
      ) : null}
    </div>
  );
}

function ManagerApp() {
  const [data, setData] = useState<BootstrapPayload | null>(null);
  const [search, setSearch] = useState("");
  const [activeProgram, setActiveProgram] = useState<string>("All");
  const [selectedId, setSelectedId] = useState<string>("");
  const [tagsDraft, setTagsDraft] = useState("");
  const [captureHotkeyDraft, setCaptureHotkeyDraft] = useState("");
  const [regionHotkeyDraft, setRegionHotkeyDraft] = useState("");
  const [busyLabel, setBusyLabel] = useState<string>("");
  const [error, setError] = useState<string>("");
  const deferredSearch = useDeferredValue(search);

  useEffect(() => {
    document.body.dataset.view = "manager";
  }, []);

  const reloadState = useEffectEvent(async () => {
    setError("");

    try {
      const payload = await invoke<BootstrapPayload>("bootstrap_state");
      startTransition(() => {
        setData(payload);
        setCaptureHotkeyDraft(payload.config.captureHotkey);
        setRegionHotkeyDraft(payload.config.regionHotkey);
      });
    } catch (reloadError) {
      setError(
        reloadError instanceof Error
          ? reloadError.message
          : String(reloadError),
      );
    }
  });

  useEffect(() => {
    void reloadState();
  }, [reloadState]);

  useEffect(() => {
    let unlistenLibrary: (() => void) | undefined;
    let unlistenClose: (() => void) | undefined;

    const setup = async () => {
      unlistenLibrary = await listen("flashbang://library-updated", () => {
        void reloadState();
      });

      unlistenClose = await currentWindow.onCloseRequested((event) => {
        event.preventDefault();
        void invoke("hide_manager");
      });
    };

    void setup();

    return () => {
      unlistenLibrary?.();
      unlistenClose?.();
    };
  }, [reloadState]);

  const screenshots = data?.screenshots ?? [];

  const programs = useMemo(() => {
    const values = new Set<string>();
    for (const record of screenshots) {
      if (record.primaryApp.trim()) {
        values.add(record.primaryApp);
      }
      for (const window of record.visibleWindows) {
        if (window.appName.trim()) {
          values.add(window.appName);
        }
      }
    }
    return [
      "All",
      ...Array.from(values).sort((left, right) => left.localeCompare(right)),
    ];
  }, [screenshots]);

  const filteredScreenshots = useMemo(() => {
    const query = deferredSearch.trim().toLowerCase();
    return screenshots.filter((record) => {
      const matchesProgram =
        activeProgram === "All" ||
        record.primaryApp === activeProgram ||
        record.visibleWindows.some(
          (window) => window.appName === activeProgram,
        );
      if (!matchesProgram) {
        return false;
      }

      if (!query) {
        return true;
      }

      const haystack = [
        record.fileName,
        record.primaryApp,
        record.activeWindow?.title ?? "",
        record.activeWindow?.appName ?? "",
        record.tags.join(" "),
        record.visibleWindows
          .map((window) => `${window.appName} ${window.title}`)
          .join(" "),
      ]
        .join(" ")
        .toLowerCase();

      return haystack.includes(query);
    });
  }, [activeProgram, deferredSearch, screenshots]);

  const selectedRecord =
    filteredScreenshots.find((record) => record.id === selectedId) ??
    filteredScreenshots[0] ??
    null;

  useEffect(() => {
    if (!selectedRecord) {
      setSelectedId("");
      setTagsDraft("");
      return;
    }

    setSelectedId(selectedRecord.id);
    setTagsDraft(selectedRecord.tags.join(", "));
  }, [selectedRecord?.id]);

  const saveHotkeys = async () => {
    setBusyLabel("Saving hotkeys");
    setError("");

    try {
      const payload = await invoke<BootstrapPayload>("set_hotkeys", {
        hotkeys: {
          captureHotkey: captureHotkeyDraft,
          regionHotkey: regionHotkeyDraft,
        },
      });
      setData(payload);
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : String(saveError),
      );
    } finally {
      setBusyLabel("");
    }
  };

  const chooseFolder = async () => {
    setBusyLabel("Choosing folder");
    setError("");

    try {
      const selected = await invoke<string | null>("pick_save_directory");
      if (selected) {
        const payload = await invoke<BootstrapPayload>("set_save_directory", {
          path: selected,
        });
        setData(payload);
      }
    } catch (pickError) {
      setError(
        pickError instanceof Error ? pickError.message : String(pickError),
      );
    } finally {
      setBusyLabel("");
    }
  };

  const saveTags = async () => {
    if (!selectedRecord) {
      return;
    }

    setBusyLabel("Updating tags");
    setError("");

    try {
      const payload = await invoke<BootstrapPayload>("update_tags", {
        id: selectedRecord.id,
        tags: tagsDraft
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean),
      });
      setData(payload);
    } catch (tagError) {
      setError(tagError instanceof Error ? tagError.message : String(tagError));
    } finally {
      setBusyLabel("");
    }
  };

  return (
    <div className="manager-shell">
      <header className="hero">
        <div>
          <span className="hero-kicker">Background Capture Utility</span>
          <h1>Flashbang</h1>
          <p>
            Resident screenshots with instant feedback, fullscreen-aware display
            capture, region selection, and a searchable visual library.
          </p>
        </div>

        <div className="hero-actions">
          <button
            className="button button--solid"
            onClick={() => void invoke("capture_now")}
          >
            Capture Display
          </button>
          <button
            className="button button--ghost"
            onClick={() => void invoke("begin_region_capture")}
          >
            Capture Area
          </button>
        </div>
      </header>

      <section className="control-grid">
        <article className="panel">
          <div className="panel__header">
            <h2>Destination</h2>
            <button className="button button--ghost" onClick={chooseFolder}>
              Choose Folder
            </button>
          </div>
          <p className="muted">
            Screenshots land in the configured folder immediately after capture.
          </p>
          <code className="path-pill">
            {data?.config.saveDir || "No save directory configured yet"}
          </code>
        </article>

        <article className="panel">
          <div className="panel__header">
            <h2>Hotkeys</h2>
            <button className="button button--ghost" onClick={saveHotkeys}>
              Apply
            </button>
          </div>

          <label className="field">
            <span>Display capture</span>
            <input
              value={captureHotkeyDraft}
              onChange={(event) => setCaptureHotkeyDraft(event.target.value)}
            />
          </label>

          <label className="field">
            <span>Area capture</span>
            <input
              value={regionHotkeyDraft}
              onChange={(event) => setRegionHotkeyDraft(event.target.value)}
            />
          </label>
        </article>

        <article className="panel panel--status">
          <h2>Library</h2>
          <div className="metric-row">
            <strong>{screenshots.length}</strong>
            <span>Total captures</span>
          </div>
          <div className="metric-row">
            <strong>{programs.length - 1}</strong>
            <span>Programs indexed</span>
          </div>
          <div className="metric-row">
            <strong>
              {data?.config.onboardingComplete ? "Ready" : "Setup"}
            </strong>
            <span>Manager state</span>
          </div>
        </article>
      </section>

      <section className="browser-shell">
        <div className="browser-toolbar">
          <input
            className="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search tags, files, apps, or window titles"
          />

          <div className="program-strip">
            {programs.map((program) => (
              <button
                key={program}
                className={`chip ${activeProgram === program ? "chip--active" : ""}`}
                onClick={() => setActiveProgram(program)}
              >
                {program}
              </button>
            ))}
          </div>
        </div>

        <div className="browser-grid">
          <section className="library-grid">
            {filteredScreenshots.map((record) => (
              <button
                key={record.id}
                className={`capture-card ${
                  selectedRecord?.id === record.id ? "capture-card--active" : ""
                }`}
                onClick={() => setSelectedId(record.id)}
              >
                <img
                  src={screenshotSrc(record.filePath)}
                  alt={record.fileName}
                />
                <div className="capture-card__body">
                  <div>
                    <strong>{record.primaryApp}</strong>
                    <span>{formatTimestamp(record.createdAt)}</span>
                  </div>
                  <span>
                    {record.captureKind === "region" ? "Area" : "Display"}
                  </span>
                </div>
              </button>
            ))}

            {filteredScreenshots.length === 0 ? (
              <div className="empty-state">
                <strong>No captures matched.</strong>
                <span>Adjust the filters or trigger a new screenshot.</span>
              </div>
            ) : null}
          </section>

          <aside className="detail-panel">
            {selectedRecord ? (
              <>
                <img
                  className="detail-panel__hero"
                  src={screenshotSrc(selectedRecord.filePath)}
                  alt={selectedRecord.fileName}
                />

                <div className="detail-panel__section">
                  <div className="detail-row">
                    <strong>{selectedRecord.primaryApp}</strong>
                    <span>{formatTimestamp(selectedRecord.createdAt)}</span>
                  </div>
                  <div className="detail-row detail-row--muted">
                    <span>{selectedRecord.fileName}</span>
                    <span>
                      {selectedRecord.width} x {selectedRecord.height}
                    </span>
                  </div>
                </div>

                <div className="detail-panel__section">
                  <label className="field">
                    <span>Tags</span>
                    <input
                      value={tagsDraft}
                      onChange={(event) => setTagsDraft(event.target.value)}
                      onBlur={saveTags}
                      placeholder="boss-fight, mood-shot, ui-bug"
                    />
                  </label>

                  <div className="button-row">
                    <button
                      className="button button--ghost"
                      onClick={() =>
                        void invoke("open_screenshot", {
                          path: selectedRecord.filePath,
                        })
                      }
                    >
                      Open File
                    </button>
                    <button
                      className="button button--ghost"
                      onClick={() =>
                        void invoke("reveal_screenshot", {
                          path: selectedRecord.filePath,
                        })
                      }
                    >
                      Reveal in Folder
                    </button>
                  </div>
                </div>

                <div className="detail-panel__section">
                  <h3>Window Context</h3>
                  <ul className="context-list">
                    {(selectedRecord.visibleWindows.length
                      ? selectedRecord.visibleWindows
                      : selectedRecord.activeWindow
                        ? [selectedRecord.activeWindow]
                        : []
                    ).map((window) => (
                      <li key={`${selectedRecord.id}-${window.id}`}>
                        <strong>{window.appName || "Unknown app"}</strong>
                        <span>{window.title || "Untitled window"}</span>
                        <span>
                          {window.isFocused
                            ? "Focused"
                            : window.isFullscreen
                              ? "Fullscreen"
                              : window.isMaximized
                                ? "Maximized"
                                : "Visible"}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              </>
            ) : (
              <div className="empty-state empty-state--detail">
                <strong>Select a capture</strong>
                <span>
                  Its metadata, tags, and window context show up here.
                </span>
              </div>
            )}
          </aside>
        </div>
      </section>

      {busyLabel ? <div className="status-bar">{busyLabel}</div> : null}
      {error ? <div className="error-bar">{error}</div> : null}
    </div>
  );
}

export default function App() {
  if (viewLabel === "selection_overlay") {
    return <SelectionOverlay />;
  }

  if (viewLabel === "flash_overlay") {
    return <FlashOverlay />;
  }

  return <ManagerApp />;
}
