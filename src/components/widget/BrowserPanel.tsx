import { useEffect, useRef, useState, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  createBrowser,
  navigateBrowser,
  setBrowserBounds,
  setBrowserZoom,
  closeBrowser,
  browserGoBack,
  browserGoForward,
  browserReload,
} from "../../lib/tauriApi";
import { useCanvasStore } from "../../stores/canvasStore";
import "./BrowserPanel.css";

interface BrowserPanelProps {
  browserId: string;
  initialUrl: string;
}

/** Ensure a URL has a protocol; default to https. */
function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^[a-z0-9-]+\.[a-z]{2,}/i.test(trimmed)) return `https://${trimmed}`;
  return trimmed;
}

export default function BrowserPanel({ browserId, initialUrl }: BrowserPanelProps) {
  const [url, setUrl] = useState(initialUrl || "https://google.com");
  const [created, setCreated] = useState(false);
  const [loading, setLoading] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);
  const rafRef = useRef<number>(0);
  const lastBoundsRef = useRef("");
  const lastZoomRef = useRef(0);

  // Sync the native webview position and zoom to match the content area's screen position
  const syncBounds = useCallback(() => {
    if (!created) return;
    const el = contentRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    // Skip if the panel is off-screen or has no size
    if (rect.width < 1 || rect.height < 1) return;
    const key = `${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.width)},${Math.round(rect.height)}`;
    if (key !== lastBoundsRef.current) {
      lastBoundsRef.current = key;
      setBrowserBounds(browserId, rect.x, rect.y, rect.width, rect.height).catch(() => {});
    }
    // Sync webview zoom to canvas zoom so page content scales with the canvas
    const canvasZoom = useCanvasStore.getState().zoom;
    if (canvasZoom !== lastZoomRef.current) {
      lastZoomRef.current = canvasZoom;
      setBrowserZoom(browserId, canvasZoom).catch(() => {});
    }
  }, [browserId, created]);

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;

    // Small delay to let the panel render and position itself
    const timer = setTimeout(() => {
      const rect = el.getBoundingClientRect();
      const startUrl = normalizeUrl(url);
      if (!startUrl) return;

      setLoading(true);
      createBrowser(browserId, startUrl, rect.x, rect.y, rect.width, rect.height)
        .then(() => {
          setCreated(true);
          setLoading(false);
        })
        .catch((err) => {
          console.warn("[browser] Failed to create:", err);
          setLoading(false);
        });
    }, 100);

    return () => clearTimeout(timer);
  }, [browserId]); // Only on mount

  // Destroy the native webview on unmount
  useEffect(() => {
    return () => {
      closeBrowser(browserId).catch(() => {});
    };
  }, [browserId]);

  // Position sync — native webviews sit outside the DOM, so they need explicit
  // bounds updates when the canvas or panel geometry changes. Coalesce those
  // changes into one RAF instead of polling layout every frame while idle.
  useEffect(() => {
    if (!created) return;
    const el = contentRef.current;
    if (!el) return;

    const scheduleSync = () => {
      if (rafRef.current) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = 0;
        syncBounds();
      });
    };

    scheduleSync();
    const unsubscribeCanvas = useCanvasStore.subscribe(scheduleSync);
    const observer = new ResizeObserver(scheduleSync);
    observer.observe(el);
    window.addEventListener("resize", scheduleSync);

    return () => {
      unsubscribeCanvas();
      observer.disconnect();
      window.removeEventListener("resize", scheduleSync);
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
      }
    };
  }, [created, syncBounds]);

  // Final immediate sync after layout-affecting React commits that do not touch
  // canvas state, e.g. URL bar loading state.
  useEffect(() => {
    if (created) {
      syncBounds();
    }
  }, [created, loading, syncBounds]);

  // Listen for URL changes from the native webview (link clicks, redirects)
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let unmounted = false;
    listen<string>(`browser-navigated-${browserId}`, (event) => {
      if (unmounted) return;
      // Only update URL bar when it's not focused (avoid overwriting user input)
      if (document.activeElement !== urlInputRef.current) {
        setUrl(event.payload);
      }
      useCanvasStore.setState((s) => ({
        terminals: s.terminals.map((t) =>
          t.terminalId === browserId ? { ...t, browserUrl: event.payload } : t,
        ),
      }));
    }).then((fn) => {
      if (unmounted) fn(); // Already unmounted — clean up immediately
      else unlisten = fn;
    });
    return () => { unmounted = true; unlisten?.(); };
  }, [browserId]);

  const handleNavigate = () => {
    const target = normalizeUrl(url);
    if (!target) return;
    setUrl(target);
    if (created) {
      navigateBrowser(browserId, target).catch(() => {});
    }
    urlInputRef.current?.blur();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleNavigate();
    }
    // Prevent canvas keybindings from firing while typing
    e.stopPropagation();
  };

  return (
    <div className="brw-panel">
      <div className="brw-toolbar" onMouseDown={(e) => e.stopPropagation()}>
        {/* Back */}
        <button
          className="brw-nav-btn"
          onClick={() => browserGoBack(browserId).catch(() => {})}
          title="Back"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M8 2L4 6L8 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
        {/* Forward */}
        <button
          className="brw-nav-btn"
          onClick={() => browserGoForward(browserId).catch(() => {})}
          title="Forward"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M4 2L8 6L4 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
        {/* Reload */}
        <button
          className="brw-nav-btn"
          onClick={() => browserReload(browserId).catch(() => {})}
          title="Reload"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M10 6A4 4 0 1 1 6 2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
            <path d="M7 1L6 3L8 3.5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
        {/* URL bar */}
        <input
          ref={urlInputRef}
          className="brw-url-input"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Enter URL..."
          spellCheck={false}
        />
      </div>

      {/* Content area — native webview renders on top of this */}
      <div ref={contentRef} className="brw-content">
        {!created && !loading && (
          <div className="brw-placeholder">
            <span className="brw-placeholder-icon">&#127760;</span>
            <span>Enter a URL to browse</span>
          </div>
        )}
        {loading && <div className="brw-loading" />}
      </div>
    </div>
  );
}
