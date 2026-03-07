import {
  startTransition,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
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

type TagDefinition = {
  id: string;
  name: string;
  color: string;
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
  tagDefinitions: TagDefinition[];
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

type ViewerPayload = {
  files: string[];
  currentIndex: number;
};

type Rect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

const TAG_COLORS = [
  "#E5534B",
  "#F0883E",
  "#FFBF64",
  "#57AB5A",
  "#539BF5",
  "#B083F0",
  "#F778BA",
  "#768390",
];

const PAGE_SIZE = 50;
const previewCache = new Map<string, string>();
const currentWebview = getCurrentWebviewWindow();
const currentWindow = getCurrentWindow();
const viewLabel = currentWebview.label;
const isMacOS = navigator.userAgent.includes("Mac");
const EVENT_VIEWER_OPEN = "flashbang://viewer-open";
const HEADER_DRAG_THRESHOLD = 6;

type HeaderPointerState = {
  pointerId: number;
  startX: number;
  startY: number;
  dragging: boolean;
};

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

function isHeaderControlTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest(
      ".window-controls, button, [role='button'], a, select, textarea",
    ) !== null
  );
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
  const src = usePreviewImage(props.path, 192, 128);

  if (!src) {
    return (
      <div className="list-item__thumb-placeholder">
        <span>{props.app.slice(0, 2)}</span>
      </div>
    );
  }

  return <img className="list-item__thumb" src={src} alt="" />;
}

function DetailPreview(props: {
  path: string | null;
  alt: string;
  onClick: () => void;
}) {
  const src = usePreviewImage(props.path, 1920, 1080);

  if (!src) {
    return (
      <div className="detail-preview-placeholder">
        <span>No preview</span>
      </div>
    );
  }

  return (
    <img
      className="detail-preview"
      src={src}
      alt={props.alt}
      onClick={props.onClick}
    />
  );
}

function FullscreenViewer() {
  const [payload, setPayload] = useState<ViewerPayload | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    document.body.dataset.view = "viewer";
  }, []);

  useEffect(() => {
    if (!isMacOS) return;
    const viewerWindow = getCurrentWindow();
    let mounted = true;
    void viewerWindow.isFullscreen().then((fs) => {
      if (mounted) setIsFullscreen(fs);
    });
    const unlisten = viewerWindow.onResized(() => {
      void viewerWindow.isFullscreen().then((fs) => {
        if (mounted) setIsFullscreen(fs);
      });
    });
    return () => {
      mounted = false;
      void unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    void invoke<ViewerPayload | null>("get_viewer_payload").then(
      (viewerPayload) => {
        if (viewerPayload) {
          setPayload(viewerPayload);
        }
      },
    );
  }, []);

  useEffect(() => {
    let mounted = true;
    let unlisten: (() => void) | undefined;

    void listen<ViewerPayload>(EVENT_VIEWER_OPEN, (event) => {
      if (mounted) {
        setPayload(event.payload);
      }
    }).then((callback) => {
      unlisten = callback;
    });

    return () => {
      mounted = false;
      unlisten?.();
    };
  }, []);

  const files = payload?.files ?? [];
  const currentIndex = payload?.currentIndex ?? 0;
  const currentPath = files[currentIndex] ?? null;
  const currentName = currentPath?.split(/[/\\]/).pop() ?? "";
  const currentSrc = currentPath ? convertFileSrc(currentPath) : "";

  const setIndex = (nextIndex: number) => {
    if (!payload || files.length === 0) {
      return;
    }

    const boundedIndex = (nextIndex + files.length) % files.length;
    setPayload({
      ...payload,
      currentIndex: boundedIndex,
    });
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        void invoke("hide_viewer");
      } else if (event.key === "ArrowLeft") {
        setIndex(currentIndex - 1);
      } else if (event.key === "ArrowRight") {
        setIndex(currentIndex + 1);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [currentIndex, payload]);

  const viewerClass = `viewer-root${isMacOS && !isFullscreen ? " viewer-root--macos" : ""}`;

  if (!currentPath) {
    return <div className={viewerClass} />;
  }

  return (
    <div className={viewerClass}>
      <div className="viewer-toolbar">
        <button
          className="viewer-toolbar__btn"
          onClick={() => void invoke("hide_viewer")}
        >
          Back
        </button>
        <div className="viewer-toolbar__meta">
          <span>{currentName}</span>
          <span>
            {currentIndex + 1} / {files.length}
          </span>
        </div>
        <div className="viewer-toolbar__actions">
          <button
            className="viewer-toolbar__btn"
            onClick={() =>
              void invoke("share_screenshot", { path: currentPath })
            }
          >
            Share
          </button>
          <button
            className="viewer-toolbar__btn viewer-toolbar__btn--primary"
            onClick={() =>
              void invoke("copy_screenshot_to_clipboard", { path: currentPath })
            }
          >
            Copy
          </button>
        </div>
      </div>

      <button
        className="viewer-nav viewer-nav--prev"
        disabled={files.length <= 1}
        onClick={() => setIndex(currentIndex - 1)}
      >
        ‹
      </button>

      <div className="viewer-stage">
        <img className="viewer-image" src={currentSrc} alt={currentName} />
      </div>

      <button
        className="viewer-nav viewer-nav--next"
        disabled={files.length <= 1}
        onClick={() => setIndex(currentIndex + 1)}
      >
        ›
      </button>
    </div>
  );
}

function FlashPreviewImage(props: { path: string | null }) {
  const src = usePreviewImage(props.path, 960, 560);

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
  const [selectedId, setSelectedId] = useState("");
  const [pageIndex, setPageIndex] = useState(0);
  const [captureHotkeyDraft, setCaptureHotkeyDraft] = useState("");
  const [regionHotkeyDraft, setRegionHotkeyDraft] = useState("");
  const [recordingTarget, setRecordingTarget] = useState<HotkeyTarget>(null);
  const [busyLabel, setBusyLabel] = useState("");
  const [error, setError] = useState("");
  const [tagPickerOpen, setTagPickerOpen] = useState(false);
  const [newTagName, setNewTagName] = useState("");
  const [newTagColor, setNewTagColor] = useState(TAG_COLORS[0]);
  const [editingTagId, setEditingTagId] = useState<string | null>(null);
  const [editTagName, setEditTagName] = useState("");
  const [editTagColor, setEditTagColor] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const deferredSearch = useDeferredValue(search);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const headerPointerStateRef = useRef<HeaderPointerState | null>(null);

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

  // Keyboard shortcuts
  useEffect(() => {
    if (recordingTarget) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      const currentSelectedRecord = selectedId
        ? (data?.screenshots.find((record) => record.id === selectedId) ?? null)
        : null;

      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLSelectElement ||
        event.target instanceof HTMLTextAreaElement
      ) {
        return;
      }

      if (
        event.key === "/" ||
        ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f")
      ) {
        event.preventDefault();
        setSearchFocused(true);
        requestAnimationFrame(() => searchInputRef.current?.focus());
        return;
      }

      if (event.key === "o" && currentSelectedRecord) {
        void invoke("open_viewer", { path: currentSelectedRecord.filePath });
      } else if (event.key === "r" && currentSelectedRecord) {
        void invoke("reveal_screenshot", {
          path: currentSelectedRecord.filePath,
        });
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [data, recordingTarget, selectedId]);

  const screenshots = data?.screenshots ?? [];
  const tagDefinitions = data?.tagDefinitions ?? [];
  const tagMap = useMemo(() => {
    const map = new Map<string, TagDefinition>();
    for (const tag of tagDefinitions) {
      map.set(tag.id, tag);
    }
    return map;
  }, [tagDefinitions]);

  const filteredScreenshots = useMemo(() => {
    const query = deferredSearch.trim().toLowerCase();
    return screenshots.filter((record) => {
      if (!query) {
        return true;
      }

      const tagNames = record.tags
        .map((id) => tagMap.get(id)?.name ?? "")
        .join(" ");

      const haystack = [
        record.fileName,
        record.primaryApp,
        record.activeWindow?.title ?? "",
        tagNames,
      ]
        .join(" ")
        .toLowerCase();

      return haystack.includes(query);
    });
  }, [deferredSearch, screenshots, tagMap]);

  const totalPages = Math.max(
    1,
    Math.ceil(filteredScreenshots.length / PAGE_SIZE),
  );
  const pageStart = pageIndex * PAGE_SIZE;
  const pageItems = filteredScreenshots.slice(pageStart, pageStart + PAGE_SIZE);

  useEffect(() => {
    setPageIndex(0);
  }, [deferredSearch]);

  useEffect(() => {
    setPageIndex((current) => Math.min(current, totalPages - 1));
  }, [totalPages]);

  useEffect(() => {
    if (!pageItems.length) {
      setSelectedId("");
      return;
    }

    if (!pageItems.some((record) => record.id === selectedId)) {
      setSelectedId(pageItems[0].id);
    }
  }, [pageItems, selectedId]);

  const selectedRecord =
    filteredScreenshots.find((record) => record.id === selectedId) ??
    pageItems[0] ??
    null;

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

  const addTagToScreenshot = async (tagId: string) => {
    if (!selectedRecord || selectedRecord.tags.includes(tagId)) {
      return;
    }
    try {
      const payload = await invoke<BootstrapPayload>("update_tags", {
        id: selectedRecord.id,
        tags: [...selectedRecord.tags, tagId],
      });
      setData(payload);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setTagPickerOpen(false);
  };

  const removeTagFromScreenshot = async (tagId: string) => {
    if (!selectedRecord) {
      return;
    }
    try {
      const payload = await invoke<BootstrapPayload>("update_tags", {
        id: selectedRecord.id,
        tags: selectedRecord.tags.filter((id) => id !== tagId),
      });
      setData(payload);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleCreateTag = async () => {
    const name = newTagName.trim();
    if (!name) {
      return;
    }
    try {
      const payload = await invoke<BootstrapPayload>("create_tag", {
        name,
        color: newTagColor,
      });
      setData(payload);
      setNewTagName("");
      setNewTagColor(TAG_COLORS[0]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleRenameTag = async (id: string) => {
    const name = editTagName.trim();
    if (!name) {
      return;
    }
    try {
      const payload = await invoke<BootstrapPayload>("rename_tag", {
        id,
        name,
        color: editTagColor,
      });
      setData(payload);
      setEditingTagId(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleDeleteTag = async (id: string) => {
    try {
      const payload = await invoke<BootstrapPayload>("delete_tag", { id });
      setData(payload);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleSearchDragStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || isHeaderControlTarget(event.target)) {
      headerPointerStateRef.current = null;
      return;
    }

    headerPointerStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      dragging: false,
    };
  };

  const handleSearchDragMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = headerPointerStateRef.current;
    if (!state || state.pointerId !== event.pointerId || state.dragging) {
      return;
    }

    const deltaX = Math.abs(event.clientX - state.startX);
    const deltaY = Math.abs(event.clientY - state.startY);
    if (Math.max(deltaX, deltaY) < HEADER_DRAG_THRESHOLD) {
      return;
    }

    state.dragging = true;
    void invoke("start_window_drag");
  };

  const handleSearchDragEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = headerPointerStateRef.current;
    if (!state || state.pointerId !== event.pointerId) {
      return;
    }

    headerPointerStateRef.current = null;

    if (!state.dragging) {
      setSearchFocused(true);
      requestAnimationFrame(() => searchInputRef.current?.focus());
    }
  };

  return (
    <div className={`window-shell ${isMacOS ? "window-shell--macos" : ""}`}>
      {/* ── Image Viewer ── */}

      {/* ── Search Header ── */}
      <div className="search-header">
        <SearchIcon />
        <div className="search-header__field">
          <input
            ref={searchInputRef}
            className="search-header__input"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onFocus={() => setSearchFocused(true)}
            onBlur={() => setSearchFocused(false)}
            placeholder="Search captures, apps, tags..."
          />
          {!searchFocused ? (
            <div
              className={`search-header__inactive ${search ? "" : "search-header__inactive--placeholder"}`}
              onPointerDown={handleSearchDragStart}
              onPointerMove={handleSearchDragMove}
              onPointerUp={handleSearchDragEnd}
              onPointerCancel={handleSearchDragEnd}
            >
              {search || "Search captures, apps, tags..."}
            </div>
          ) : null}
        </div>
        {!isMacOS ? (
          <div className="window-controls">
            <button
              className="window-btn"
              onClick={() => void currentWindow.minimize()}
            >
              <svg viewBox="0 0 12 12">
                <path d="M2 6h8" />
              </svg>
            </button>
            <button
              className="window-btn"
              onClick={() => void currentWindow.toggleMaximize()}
            >
              <svg viewBox="0 0 12 12">
                <rect x="2.5" y="2.5" width="7" height="7" rx="0.5" />
              </svg>
            </button>
            <button
              className="window-btn window-btn--close"
              onClick={() => void currentWindow.close()}
            >
              <svg viewBox="0 0 12 12">
                <path d="M3 3l6 6M9 3l-6 6" />
              </svg>
            </button>
          </div>
        ) : null}
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
                    onClick={() =>
                      void invoke("open_viewer", {
                        path: selectedRecord.filePath,
                      })
                    }
                  />

                  <div className="detail-info-row">
                    <span className="detail-info-row__app">
                      {selectedRecord.primaryApp}
                    </span>
                    <span className="detail-info-row__dim">
                      {selectedRecord.width} x {selectedRecord.height}
                    </span>
                    <span className="detail-info-row__time">
                      {formatTimestamp(selectedRecord.createdAt)}
                    </span>
                  </div>

                  <div className="tag-chips">
                    {selectedRecord.tags.map((tagId) => {
                      const tag = tagMap.get(tagId);
                      if (!tag) return null;
                      return (
                        <button
                          key={tagId}
                          className="tag-chip"
                          style={
                            {
                              "--tag-color": tag.color,
                            } as React.CSSProperties
                          }
                          onClick={() => void removeTagFromScreenshot(tagId)}
                        >
                          <span
                            className="tag-chip__dot"
                            style={{ background: tag.color }}
                          />
                          {tag.name}
                          <span className="tag-chip__x">&times;</span>
                        </button>
                      );
                    })}
                    <div className="tag-picker-wrapper">
                      <button
                        className="tag-add-btn"
                        onClick={() => setTagPickerOpen(!tagPickerOpen)}
                      >
                        +
                      </button>
                      {tagPickerOpen ? (
                        <div className="tag-picker">
                          {tagDefinitions.length === 0 ? (
                            <span className="tag-picker__empty">
                              No tags defined. Create tags in Settings.
                            </span>
                          ) : null}
                          {tagDefinitions.map((tag) => (
                            <button
                              key={tag.id}
                              className={`tag-picker__item ${selectedRecord.tags.includes(tag.id) ? "tag-picker__item--assigned" : ""}`}
                              onClick={() => void addTagToScreenshot(tag.id)}
                              disabled={selectedRecord.tags.includes(tag.id)}
                            >
                              <span
                                className="tag-chip__dot"
                                style={{ background: tag.color }}
                              />
                              {tag.name}
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </div>
                </>
              ) : (
                <div className="empty-state">
                  <span className="empty-state__title">
                    No capture selected
                  </span>
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
              <div
                className="settings-row"
                style={{ justifyContent: "flex-end" }}
              >
                <button
                  className="settings-btn settings-btn--primary"
                  onClick={saveHotkeys}
                >
                  Save Hotkeys
                </button>
              </div>
            </div>

            <div className="settings-group">
              <span className="settings-group__title">Tags</span>
              {tagDefinitions.map((tag) => (
                <div key={tag.id} className="settings-row">
                  {editingTagId === tag.id ? (
                    <>
                      <div className="tag-edit-row">
                        <div className="color-picker">
                          {TAG_COLORS.map((c) => (
                            <button
                              key={c}
                              className={`color-dot ${editTagColor === c ? "color-dot--active" : ""}`}
                              style={{ background: c }}
                              onClick={() => setEditTagColor(c)}
                            />
                          ))}
                        </div>
                        <input
                          className="tag-name-input"
                          value={editTagName}
                          onChange={(e) => setEditTagName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              void handleRenameTag(tag.id);
                            }
                          }}
                        />
                      </div>
                      <button
                        className="settings-btn"
                        onClick={() => void handleRenameTag(tag.id)}
                      >
                        Save
                      </button>
                      <button
                        className="settings-btn"
                        onClick={() => setEditingTagId(null)}
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <>
                      <div className="settings-row__info">
                        <span className="settings-row__label">
                          <span
                            className="tag-chip__dot"
                            style={{ background: tag.color }}
                          />
                          {tag.name}
                        </span>
                      </div>
                      <button
                        className="settings-btn"
                        onClick={() => {
                          setEditingTagId(tag.id);
                          setEditTagName(tag.name);
                          setEditTagColor(tag.color);
                        }}
                      >
                        Edit
                      </button>
                      <button
                        className="settings-btn settings-btn--danger"
                        onClick={() => void handleDeleteTag(tag.id)}
                      >
                        Delete
                      </button>
                    </>
                  )}
                </div>
              ))}
              <div className="settings-row">
                <div className="tag-edit-row">
                  <div className="color-picker">
                    {TAG_COLORS.map((c) => (
                      <button
                        key={c}
                        className={`color-dot ${newTagColor === c ? "color-dot--active" : ""}`}
                        style={{ background: c }}
                        onClick={() => setNewTagColor(c)}
                      />
                    ))}
                  </div>
                  <input
                    className="tag-name-input"
                    value={newTagName}
                    onChange={(e) => setNewTagName(e.target.value)}
                    placeholder="New tag name"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        void handleCreateTag();
                      }
                    }}
                  />
                </div>
                <button
                  className="settings-btn settings-btn--primary"
                  onClick={handleCreateTag}
                >
                  Create
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
            onClick={() => setPageIndex((current) => Math.max(0, current - 1))}
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
              setPageIndex((current) => Math.min(totalPages - 1, current + 1))
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
                ? void invoke("open_viewer", {
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

  if (viewLabel === "viewer_fullscreen") {
    return <FullscreenViewer />;
  }

  return <ManagerApp />;
}
