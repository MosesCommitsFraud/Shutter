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
type ManagerTab = "shots" | "settings";
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

const PAGE_SIZE = 50;
const previewCache = new Map<string, string>();
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

function ListThumb(props: { path: string | null; app: string }) {
  const src = usePreviewImage(props.path, 96, 64);

  if (!src) {
    return (
      <div className="list-item__thumb-placeholder">
        <span>{props.app.slice(0, 2)}</span>
      </div>
    );
  }

  return <img className="list-item__thumb" src={src} alt="" />;
}

function DetailPreview(props: { path: string | null; alt: string }) {
  const src = usePreviewImage(props.path, 860, 520);

  if (!src) {
    return (
      <div className="detail-preview-placeholder">
        <span>No preview</span>
      </div>
    );
  }

  return <img className="detail-preview" src={src} alt={props.alt} />;
}

function FlashPreviewImage(props: { path: string | null }) {
  const src = usePreviewImage(props.path, 480, 280);

  if (!src) {
    return null;
  }

  return <img className="flash-card__image" src={src} alt="" />;
}

function SearchIcon() {
  return (
    <div className="search-header__icon">
      <svg viewBox="0 0 24 24">
        <circle cx="11" cy="11" r="7" />
        <path d="M16 16l5 5" />
      </svg>
    </div>
  );
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
        <FlashPreviewImage path={payload.filePath} />
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

  return (
    <div className="window-shell">
      {/* ── Search Header ── */}
      <div className="search-header" data-tauri-drag-region>
        <SearchIcon />
        <input
          className="search-header__input"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search captures..."
        />
        {activeTab === "shots" ? (
          <select
            className="search-header__filter"
            value={activeProgram}
            onChange={(event) => setActiveProgram(event.target.value)}
          >
            {programs.map((program) => (
              <option key={program} value={program}>
                {program}
              </option>
            ))}
          </select>
        ) : null}
        <div className="window-controls">
          <button
            className="window-btn"
            onClick={() => void currentWindow.minimize()}
          >
            <svg viewBox="0 0 12 12"><path d="M2 6h8" /></svg>
          </button>
          <button
            className="window-btn"
            onClick={() => void currentWindow.toggleMaximize()}
          >
            <svg viewBox="0 0 12 12"><rect x="2.5" y="2.5" width="7" height="7" rx="0.5" /></svg>
          </button>
          <button
            className="window-btn window-btn--close"
            onClick={() => void currentWindow.close()}
          >
            <svg viewBox="0 0 12 12"><path d="M3 3l6 6M9 3l-6 6" /></svg>
          </button>
        </div>
      </div>

      {/* ── Tab Bar ── */}
      <div className="tab-bar">
        <button
          className={`tab-bar__item ${activeTab === "shots" ? "tab-bar__item--active" : ""}`}
          onClick={() => setActiveTab("shots")}
        >
          Shots
        </button>
        <button
          className={`tab-bar__item ${activeTab === "settings" ? "tab-bar__item--active" : ""}`}
          onClick={() => setActiveTab("settings")}
        >
          Settings
        </button>
        <div className="tab-bar__spacer" />
        <button
          className="tab-bar__action"
          onClick={() => void invoke("capture_now")}
        >
          Capture
        </button>
        <button
          className="tab-bar__action tab-bar__action--ghost"
          onClick={() => void invoke("begin_region_capture")}
        >
          Area
        </button>
      </div>

      {/* ── Content ── */}
      <div className="content-area">
        {activeTab === "shots" ? (
          <div className="shots-layout">
            <div className="shots-list">
              {pageItems.map((record) => (
                <button
                  key={record.id}
                  className={`list-item ${selectedRecord?.id === record.id ? "list-item--selected" : ""}`}
                  onClick={() => setSelectedId(record.id)}
                >
                  <ListThumb path={record.filePath} app={record.primaryApp} />
                  <div className="list-item__info">
                    <span className="list-item__title">
                      {record.activeWindow?.title || record.primaryApp}
                    </span>
                    <span className="list-item__subtitle">
                      {record.primaryApp} &middot;{" "}
                      {formatTimestamp(record.createdAt)}
                    </span>
                  </div>
                  <span className="list-item__badge">
                    {record.captureKind === "region" ? "Area" : "Full"}
                  </span>
                </button>
              ))}

              {!pageItems.length ? (
                <div className="empty-state">
                  <span className="empty-state__title">No captures</span>
                  <span className="empty-state__desc">
                    Take a screenshot or change filters.
                  </span>
                </div>
              ) : null}
            </div>

            <div className="detail-pane">
              {selectedRecord ? (
                <>
                  <DetailPreview
                    path={selectedRecord.filePath}
                    alt={selectedRecord.fileName}
                  />

                  <div className="detail-meta">
                    <div className="detail-meta__item">
                      <span className="detail-meta__label">Application</span>
                      <span className="detail-meta__value">
                        {selectedRecord.primaryApp}
                      </span>
                    </div>
                    <div className="detail-meta__item">
                      <span className="detail-meta__label">Dimensions</span>
                      <span className="detail-meta__value">
                        {selectedRecord.width} x {selectedRecord.height}
                      </span>
                    </div>
                    <div className="detail-meta__item">
                      <span className="detail-meta__label">Display</span>
                      <span className="detail-meta__value">
                        {selectedRecord.display.name}
                      </span>
                    </div>
                    <div className="detail-meta__item">
                      <span className="detail-meta__label">Captured</span>
                      <span className="detail-meta__value">
                        {formatTimestamp(selectedRecord.createdAt)}
                      </span>
                    </div>
                  </div>

                  <div className="tags-section">
                    <span className="tags-section__label">Tags</span>
                    <div className="tags-section__input-row">
                      <input
                        className="tags-section__input"
                        value={tagsDraft}
                        onChange={(event) => setTagsDraft(event.target.value)}
                        placeholder="boss-fight, hud, cinematic"
                      />
                      <button className="tags-section__save" onClick={saveTags}>
                        Save
                      </button>
                    </div>
                  </div>

                  {selectedRecord.visibleWindows.length > 0 ? (
                    <div className="windows-section">
                      <span className="windows-section__label">
                        Visible Windows
                      </span>
                      {selectedRecord.visibleWindows.slice(0, 5).map((w) => (
                        <div
                          key={`${selectedRecord.id}-${w.id}`}
                          className="window-row"
                        >
                          <span className="window-row__app">
                            {w.appName || "Unknown"}
                          </span>
                          <span className="window-row__title">
                            {w.title || "Untitled"}
                          </span>
                          <span className="window-row__state">
                            {w.isFocused
                              ? "Focused"
                              : w.isFullscreen
                                ? "Fullscreen"
                                : w.isMaximized
                                  ? "Maximized"
                                  : "Visible"}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </>
              ) : (
                <div className="empty-state">
                  <span className="empty-state__title">No capture selected</span>
                  <span className="empty-state__desc">
                    Select a capture from the list or take a new one.
                  </span>
                </div>
              )}
            </div>
          </div>
        ) : null}

        {activeTab === "settings" ? (
          <div className="settings-layout">
            <div className="settings-group">
              <span className="settings-group__title">Storage</span>
              <div className="settings-row">
                <div className="settings-row__info">
                  <span className="settings-row__label">Save directory</span>
                  <span className="settings-row__value settings-row__value--accent">
                    {data?.config.saveDir || "Not configured"}
                  </span>
                </div>
                <button className="settings-btn" onClick={chooseFolder}>
                  Choose
                </button>
              </div>
              <div className="settings-row">
                <div className="settings-row__info">
                  <span className="settings-row__label">Library size</span>
                  <span className="settings-row__value">
                    {screenshots.length} captures indexed
                  </span>
                </div>
              </div>
            </div>

            <div className="settings-group">
              <span className="settings-group__title">Hotkeys</span>
              <div className="settings-row">
                <div className="settings-row__info">
                  <span className="settings-row__label">Display capture</span>
                  <span className="settings-row__value">
                    {captureHotkeyDraft || "Unset"}
                  </span>
                </div>
                <button
                  className={`settings-btn ${recordingTarget === "capture" ? "settings-btn--recording" : ""}`}
                  onClick={() =>
                    setRecordingTarget((current) =>
                      current === "capture" ? null : "capture",
                    )
                  }
                >
                  {recordingTarget === "capture" ? "Press keys..." : "Record"}
                </button>
              </div>
              <div className="settings-row">
                <div className="settings-row__info">
                  <span className="settings-row__label">Area capture</span>
                  <span className="settings-row__value">
                    {regionHotkeyDraft || "Unset"}
                  </span>
                </div>
                <button
                  className={`settings-btn ${recordingTarget === "region" ? "settings-btn--recording" : ""}`}
                  onClick={() =>
                    setRecordingTarget((current) =>
                      current === "region" ? null : "region",
                    )
                  }
                >
                  {recordingTarget === "region" ? "Press keys..." : "Record"}
                </button>
              </div>
              <div className="settings-row" style={{ justifyContent: "flex-end" }}>
                <button
                  className="settings-btn settings-btn--primary"
                  onClick={saveHotkeys}
                >
                  Save Hotkeys
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>

      {/* ── Pager (shots only) ── */}
      {activeTab === "shots" && totalPages > 1 ? (
        <div className="pager">
          <button
            className="pager__btn"
            disabled={pageIndex === 0}
            onClick={() =>
              setPageIndex((current) => Math.max(0, current - 1))
            }
          >
            Prev
          </button>
          <span>
            {pageIndex + 1} / {totalPages}
          </span>
          <button
            className="pager__btn"
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
      ) : null}

      {/* ── Action Bar ── */}
      <div className="action-bar">
        <div className="action-bar__left">
          <span className="action-bar__status">
            {busyLabel || error || `${filteredScreenshots.length} captures`}
          </span>
        </div>
        <div className="action-bar__right">
          <button
            className="action-shortcut"
            disabled={!selectedRecord}
            onClick={() =>
              selectedRecord
                ? void invoke("open_screenshot", {
                    path: selectedRecord.filePath,
                  })
                : undefined
            }
          >
            <kbd>O</kbd> Open
          </button>
          <button
            className="action-shortcut"
            disabled={!selectedRecord}
            onClick={() =>
              selectedRecord
                ? void invoke("reveal_screenshot", {
                    path: selectedRecord.filePath,
                  })
                : undefined
            }
          >
            <kbd>R</kbd> Reveal
          </button>
        </div>
      </div>
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
