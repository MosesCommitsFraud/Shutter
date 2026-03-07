import {
  startTransition,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useMemo,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./styles.css";

type CaptureKind = "display" | "region";
type ManagerTab = "shots" | "focus" | "settings";
type HotkeyTarget = "capture" | "region" | null;

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

const PAGE_SIZE = 6;
const previewCache = new Map<string, string>();
const currentWebview = getCurrentWebviewWindow();
const currentWindow = getCurrentWindow();
const viewLabel = currentWebview.label;

function WindowIcon(props: { kind: "minimize" | "maximize" | "close" }) {
  if (props.kind === "minimize") {
    return (
      <svg viewBox="0 0 12 12" aria-hidden="true">
        <path d="M2 6.5h8" />
      </svg>
    );
  }

  if (props.kind === "maximize") {
    return (
      <svg viewBox="0 0 12 12" aria-hidden="true">
        <rect x="2.25" y="2.25" width="7.5" height="7.5" rx="0.6" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 12 12" aria-hidden="true">
      <path d="M3 3l6 6" />
      <path d="M9 3L3 9" />
    </svg>
  );
}

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

function titleFromRecord(record: ScreenshotRecord | null): string {
  if (!record) {
    return "No capture selected";
  }

  return record.activeWindow?.title || record.fileName;
}

function acceleratorFromEvent(event: KeyboardEvent): string | null {
  const modifiers: string[] = [];

  if (event.ctrlKey || event.metaKey) {
    modifiers.push("CmdOrControl");
  }
  if (event.altKey) {
    modifiers.push("Alt");
  }
  if (event.shiftKey) {
    modifiers.push("Shift");
  }

  const code = event.code;
  let key: string | null = null;

  if (/^Key[A-Z]$/.test(code)) {
    key = code.slice(3);
  } else if (/^Digit[0-9]$/.test(code)) {
    key = code.slice(5);
  } else if (/^F[0-9]{1,2}$/.test(code)) {
    key = code;
  } else {
    const map: Record<string, string> = {
      Backspace: "Backspace",
      Delete: "Delete",
      End: "End",
      Enter: "Enter",
      Escape: "Escape",
      Home: "Home",
      Insert: "Insert",
      Minus: "-",
      Equal: "=",
      BracketLeft: "[",
      BracketRight: "]",
      Backslash: "\\",
      Semicolon: ";",
      Quote: "'",
      Comma: ",",
      Period: ".",
      Slash: "/",
      Space: "Space",
      Tab: "Tab",
      ArrowUp: "Up",
      ArrowDown: "Down",
      ArrowLeft: "Left",
      ArrowRight: "Right",
      PageUp: "PageUp",
      PageDown: "PageDown",
    };
    key = map[code] ?? null;
  }

  if (!key) {
    return null;
  }

  return [...modifiers, key].join("+");
}

function usePreviewImage(
  path: string | null,
  maxWidth: number,
  maxHeight: number,
) {
  const [src, setSrc] = useState("");

  useEffect(() => {
    let cancelled = false;

    if (!path) {
      setSrc("");
      return () => {
        cancelled = true;
      };
    }

    const cacheKey = `${path}::${maxWidth}x${maxHeight}`;
    const cached = previewCache.get(cacheKey);
    if (cached) {
      setSrc(cached);
      return () => {
        cancelled = true;
      };
    }

    setSrc("");

    void invoke<string>("load_preview_image", {
      path,
      maxWidth,
      maxHeight,
    })
      .then((dataUrl) => {
        if (!cancelled) {
          previewCache.set(cacheKey, dataUrl);
          setSrc(dataUrl);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSrc("");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [path, maxHeight, maxWidth]);

  return src;
}

function PreviewImage(props: {
  path: string | null;
  alt: string;
  className: string;
  maxWidth: number;
  maxHeight: number;
  placeholderLabel: string;
}) {
  const src = usePreviewImage(props.path, props.maxWidth, props.maxHeight);

  if (!src) {
    return (
      <div className={`${props.className} preview-placeholder`}>
        <span>{props.placeholderLabel}</span>
      </div>
    );
  }

  return <img className={props.className} src={src} alt={props.alt} />;
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
    let unlisten: (() => void) | undefined;

    void listen<FlashPreviewPayload>("flashbang://flash-preview", (event) => {
      if (mounted) {
        handlePreview(event.payload);
      }
    }).then((callback) => {
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
        style={{
          ["--flash-opacity" as string]: String(payload.flashOpacity * 0.65),
        }}
      />
      <div className="flash-card">
        <PreviewImage
          path={payload.filePath}
          alt=""
          className="flash-card__image"
          maxWidth={480}
          maxHeight={280}
          placeholderLabel="Preview"
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
      onPointerDown={(event) => {
        if (submitting) {
          return;
        }
        event.currentTarget.setPointerCapture(event.pointerId);
        setOrigin({ x: event.clientX, y: event.clientY });
        setCursor({ x: event.clientX, y: event.clientY });
      }}
      onPointerMove={(event) => {
        if (origin) {
          setCursor({ x: event.clientX, y: event.clientY });
        }
      }}
      onPointerUp={() => {
        if (selection) {
          void finishSelection(selection);
        }
      }}
      onPointerCancel={() => {
        setOrigin(null);
        setCursor(null);
      }}
    >
      <div className="selection-hud">
        <span className="selection-pill">Area Capture</span>
        <span className="selection-copy">
          Drag the box and release. Esc cancels.
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

      {pending ? (
        <div className="selection-corner selection-corner--tl" />
      ) : null}
    </div>
  );
}

function ManagerApp() {
  const [data, setData] = useState<BootstrapPayload | null>(null);
  const [activeTab, setActiveTab] = useState<ManagerTab>("shots");
  const [search, setSearch] = useState("");
  const [activeProgram, setActiveProgram] = useState("All");
  const [selectedId, setSelectedId] = useState("");
  const [pageIndex, setPageIndex] = useState(0);
  const [tagsDraft, setTagsDraft] = useState("");
  const [captureHotkeyDraft, setCaptureHotkeyDraft] = useState("");
  const [regionHotkeyDraft, setRegionHotkeyDraft] = useState("");
  const [recordingTarget, setRecordingTarget] = useState<HotkeyTarget>(null);
  const [busyLabel, setBusyLabel] = useState("");
  const [error, setError] = useState("");
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

  useEffect(() => {
    if (!recordingTarget) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();

      if (event.key === "Escape") {
        setRecordingTarget(null);
        return;
      }

      const accelerator = acceleratorFromEvent(event);
      if (!accelerator) {
        return;
      }

      if (recordingTarget === "capture") {
        setCaptureHotkeyDraft(accelerator);
      } else {
        setRegionHotkeyDraft(accelerator);
      }

      setRecordingTarget(null);
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [recordingTarget]);

  const screenshots = data?.screenshots ?? [];

  const programs = useMemo(() => {
    const values = new Set<string>();
    for (const record of screenshots) {
      if (record.primaryApp.trim()) {
        values.add(record.primaryApp);
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
        activeProgram === "All" || record.primaryApp === activeProgram;

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
        record.tags.join(" "),
      ]
        .join(" ")
        .toLowerCase();

      return haystack.includes(query);
    });
  }, [activeProgram, deferredSearch, screenshots]);

  const totalPages = Math.max(
    1,
    Math.ceil(filteredScreenshots.length / PAGE_SIZE),
  );
  const pageStart = pageIndex * PAGE_SIZE;
  const pageItems = filteredScreenshots.slice(pageStart, pageStart + PAGE_SIZE);

  useEffect(() => {
    setPageIndex(0);
  }, [activeProgram, deferredSearch]);

  useEffect(() => {
    setPageIndex((current) => Math.min(current, totalPages - 1));
  }, [totalPages]);

  useEffect(() => {
    if (!pageItems.length) {
      setSelectedId("");
      setTagsDraft("");
      return;
    }

    if (!pageItems.some((record) => record.id === selectedId)) {
      setSelectedId(pageItems[0].id);
      setTagsDraft(pageItems[0].tags.join(", "));
    }
  }, [pageItems, selectedId]);

  const selectedRecord =
    filteredScreenshots.find((record) => record.id === selectedId) ??
    pageItems[0] ??
    null;

  useEffect(() => {
    if (selectedRecord) {
      setTagsDraft(selectedRecord.tags.join(", "));
    }
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

  const pageLabel =
    filteredScreenshots.length === 0
      ? "0 / 0"
      : `${pageIndex + 1} / ${totalPages}`;

  return (
    <div className="window-shell">
      <header className="titlebar">
        <div className="titlebar__brand" data-tauri-drag-region>
          <span className="brand-mark" />
          <div>
            <strong>Flashbang</strong>
            <span>Resident capture manager</span>
          </div>
        </div>

        <nav className="titlebar__tabs">
          <button
            className={`tab-chip ${activeTab === "shots" ? "tab-chip--active" : ""}`}
            onClick={() => setActiveTab("shots")}
          >
            Shots
          </button>
          <button
            className={`tab-chip ${activeTab === "focus" ? "tab-chip--active" : ""}`}
            onClick={() => setActiveTab("focus")}
          >
            Focus
          </button>
          <button
            className={`tab-chip ${activeTab === "settings" ? "tab-chip--active" : ""}`}
            onClick={() => setActiveTab("settings")}
          >
            Settings
          </button>
        </nav>

        <div className="titlebar__actions">
          <button
            className="tool-button tool-button--solid"
            onClick={() => void invoke("capture_now")}
          >
            Capture
          </button>
          <button
            className="tool-button"
            onClick={() => void invoke("begin_region_capture")}
          >
            Area
          </button>
          <button
            className="window-button"
            onClick={() => void currentWindow.minimize()}
          >
            <WindowIcon kind="minimize" />
          </button>
          <button
            className="window-button"
            onClick={() => void currentWindow.toggleMaximize()}
          >
            <WindowIcon kind="maximize" />
          </button>
          <button
            className="window-button window-button--close"
            onClick={() => void currentWindow.close()}
          >
            <WindowIcon kind="close" />
          </button>
        </div>
      </header>

      <main className="workspace">
        {activeTab === "shots" ? (
          <section className="panel-grid">
            <section className="pane pane--gallery">
              <div className="toolbar-row">
                <input
                  className="compact-input compact-input--search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search files, apps, tags"
                />
                <select
                  className="compact-select"
                  value={activeProgram}
                  onChange={(event) => setActiveProgram(event.target.value)}
                >
                  {programs.map((program) => (
                    <option key={program} value={program}>
                      {program}
                    </option>
                  ))}
                </select>
              </div>

              <div className="thumb-grid">
                {pageItems.map((record) => (
                  <button
                    key={record.id}
                    className={`thumb-card ${selectedRecord?.id === record.id ? "thumb-card--active" : ""}`}
                    onClick={() => setSelectedId(record.id)}
                  >
                    <PreviewImage
                      path={record.filePath}
                      alt={record.fileName}
                      className="thumb-card__image"
                      maxWidth={360}
                      maxHeight={220}
                      placeholderLabel={record.primaryApp}
                    />
                    <div className="thumb-card__meta">
                      <strong>{record.primaryApp}</strong>
                      <span>
                        {record.captureKind === "region" ? "Area" : "Display"}
                      </span>
                    </div>
                  </button>
                ))}

                {!pageItems.length ? (
                  <div className="empty-panel">
                    <strong>No captures</strong>
                    <span>Take a screenshot or change the filters.</span>
                  </div>
                ) : null}
              </div>

              <div className="pager-row">
                <span>{filteredScreenshots.length} matches</span>
                <div className="pager-controls">
                  <button
                    className="tool-button"
                    disabled={pageIndex === 0}
                    onClick={() =>
                      setPageIndex((current) => Math.max(0, current - 1))
                    }
                  >
                    Prev
                  </button>
                  <span className="pager-label">{pageLabel}</span>
                  <button
                    className="tool-button"
                    disabled={pageIndex >= totalPages - 1}
                    onClick={() =>
                      setPageIndex((current) =>
                        Math.min(totalPages - 1, current + 1),
                      )
                    }
                  >
                    Next
                  </button>
                </div>
              </div>
            </section>

            <aside className="pane pane--preview">
              <PreviewImage
                path={selectedRecord?.filePath ?? null}
                alt={selectedRecord?.fileName ?? "No capture selected"}
                className="hero-preview"
                maxWidth={860}
                maxHeight={520}
                placeholderLabel="Preview"
              />

              <div className="info-strip">
                <div>
                  <strong>{selectedRecord?.primaryApp ?? "No app"}</strong>
                  <span>{titleFromRecord(selectedRecord)}</span>
                </div>
                <div>
                  <strong>
                    {selectedRecord
                      ? `${selectedRecord.width} x ${selectedRecord.height}`
                      : "--"}
                  </strong>
                  <span>
                    {selectedRecord
                      ? formatTimestamp(selectedRecord.createdAt)
                      : "Select a capture"}
                  </span>
                </div>
              </div>

              <div className="action-row">
                <button
                  className="tool-button"
                  disabled={!selectedRecord}
                  onClick={() =>
                    selectedRecord
                      ? void invoke("open_screenshot", {
                          path: selectedRecord.filePath,
                        })
                      : undefined
                  }
                >
                  Open
                </button>
                <button
                  className="tool-button"
                  disabled={!selectedRecord}
                  onClick={() =>
                    selectedRecord
                      ? void invoke("reveal_screenshot", {
                          path: selectedRecord.filePath,
                        })
                      : undefined
                  }
                >
                  Reveal
                </button>
                <button
                  className="tool-button"
                  onClick={() => setActiveTab("focus")}
                  disabled={!selectedRecord}
                >
                  Details
                </button>
              </div>
            </aside>
          </section>
        ) : null}

        {activeTab === "focus" ? (
          <section className="panel-grid panel-grid--focus">
            <section className="pane">
              <div className="section-head">
                <h2>Selected Capture</h2>
                <span>
                  {selectedRecord
                    ? formatTimestamp(selectedRecord.createdAt)
                    : "Nothing selected"}
                </span>
              </div>

              <PreviewImage
                path={selectedRecord?.filePath ?? null}
                alt={selectedRecord?.fileName ?? "No capture selected"}
                className="detail-preview"
                maxWidth={640}
                maxHeight={380}
                placeholderLabel="Preview"
              />

              <div className="detail-grid">
                <div className="stat-box">
                  <span>Program</span>
                  <strong>{selectedRecord?.primaryApp ?? "--"}</strong>
                </div>
                <div className="stat-box">
                  <span>Capture</span>
                  <strong>{selectedRecord?.captureKind ?? "--"}</strong>
                </div>
                <div className="stat-box">
                  <span>Display</span>
                  <strong>{selectedRecord?.display.name ?? "--"}</strong>
                </div>
                <div className="stat-box">
                  <span>Windows</span>
                  <strong>{selectedRecord?.visibleWindows.length ?? 0}</strong>
                </div>
              </div>
            </section>

            <section className="pane">
              <div className="section-head">
                <h2>Tags and Context</h2>
                <button
                  className="tool-button"
                  onClick={saveTags}
                  disabled={!selectedRecord}
                >
                  Save Tags
                </button>
              </div>

              <label className="inline-field">
                <span>Tags</span>
                <input
                  className="compact-input"
                  value={tagsDraft}
                  onChange={(event) => setTagsDraft(event.target.value)}
                  placeholder="boss-fight, hud, cinematic"
                />
              </label>

              <div className="window-list">
                {(selectedRecord?.visibleWindows.slice(0, 6) ?? []).map(
                  (window) => (
                    <article
                      key={`${selectedRecord?.id}-${window.id}`}
                      className="window-row"
                    >
                      <strong>{window.appName || "Unknown app"}</strong>
                      <span>{window.title || "Untitled window"}</span>
                      <em>
                        {window.isFocused
                          ? "Focused"
                          : window.isFullscreen
                            ? "Fullscreen"
                            : window.isMaximized
                              ? "Maximized"
                              : "Visible"}
                      </em>
                    </article>
                  ),
                )}

                {!selectedRecord?.visibleWindows.length ? (
                  <div className="empty-panel empty-panel--compact">
                    <strong>No window context</strong>
                    <span>Choose a capture from the Shots tab.</span>
                  </div>
                ) : null}
              </div>
            </section>
          </section>
        ) : null}

        {activeTab === "settings" ? (
          <section className="panel-grid panel-grid--settings">
            <section className="pane">
              <div className="section-head">
                <h2>Storage</h2>
                <button className="tool-button" onClick={chooseFolder}>
                  Choose Folder
                </button>
              </div>

              <div className="setting-box">
                <span>Save directory</span>
                <code>{data?.config.saveDir || "Not configured"}</code>
              </div>

              <div className="setting-box">
                <span>Library size</span>
                <strong>{screenshots.length} captures indexed</strong>
              </div>
            </section>

            <section className="pane">
              <div className="section-head">
                <h2>Hotkeys</h2>
                <button
                  className="tool-button tool-button--solid"
                  onClick={saveHotkeys}
                >
                  Save
                </button>
              </div>

              <div className="hotkey-row">
                <div>
                  <span>Display capture</span>
                  <strong>{captureHotkeyDraft || "Unset"}</strong>
                </div>
                <button
                  className={`tool-button ${recordingTarget === "capture" ? "tool-button--recording" : ""}`}
                  onClick={() =>
                    setRecordingTarget((current) =>
                      current === "capture" ? null : "capture",
                    )
                  }
                >
                  {recordingTarget === "capture" ? "Press keys" : "Record"}
                </button>
              </div>

              <div className="hotkey-row">
                <div>
                  <span>Area capture</span>
                  <strong>{regionHotkeyDraft || "Unset"}</strong>
                </div>
                <button
                  className={`tool-button ${recordingTarget === "region" ? "tool-button--recording" : ""}`}
                  onClick={() =>
                    setRecordingTarget((current) =>
                      current === "region" ? null : "region",
                    )
                  }
                >
                  {recordingTarget === "region" ? "Press keys" : "Record"}
                </button>
              </div>
            </section>
          </section>
        ) : null}
      </main>

      <footer className="statusline">
        <span>{busyLabel || error || "Ready"}</span>
        <span>
          {selectedRecord ? selectedRecord.fileName : "No capture selected"}
        </span>
      </footer>
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
