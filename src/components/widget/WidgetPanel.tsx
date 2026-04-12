import { useEffect, useRef, useState, useCallback } from "react";
import { getWidgetServerPort, widgetFileModified, widgetGetState, widgetSetState, widgetClearState, proxyFetch, createBrowser, setBrowserBounds, setBrowserZoom, setBrowserVisible, closeBrowser, navigateBrowser, browserEval, shellExec, readFile, writeFile, listDirectory, searchFiles, deleteFiles, createTerminal, closeTerminal, writeTerminal, createClaudeSession, sendClaudePrompt, onTerminalOutput } from "../../lib/tauriApi";
import { pushToast } from "../../lib/notifications";
import { useClaudeStore, ClaudeSession } from "../../stores/claudeStore";
import { useThemeStore } from "../../stores/themeStore";
import { useCanvasStore } from "../../stores/canvasStore";
import { widgetBus } from "../../lib/widgetBus";
import "./Widget.css";

interface WidgetPanelProps {
  widgetId: string;
}

const POLL_INTERVAL = 1500;

/**
 * Build a snapshot of Terminal 64 state that widgets receive on init
 * and can request at any time via postMessage({ type: "t64:request-state" }).
 */
function buildStateSnapshot() {
  const claude = useClaudeStore.getState();
  const theme = useThemeStore.getState();
  const canvas = useCanvasStore.getState();

  const sessions: Record<string, {
    sessionId: string;
    name: string;
    cwd: string;
    model: string;
    isStreaming: boolean;
    promptCount: number;
    messageCount: number;
    totalTokens: number;
    totalCost: number;
    mcpServers: { name: string; status: string }[];
  }> = {};

  for (const [sid, s] of Object.entries(claude.sessions)) {
    sessions[sid] = {
      sessionId: sid,
      name: s.name,
      cwd: s.cwd,
      model: s.model,
      isStreaming: s.isStreaming,
      promptCount: s.promptCount,
      messageCount: s.messages.length,
      totalTokens: s.totalTokens,
      totalCost: s.totalCost,
      mcpServers: s.mcpServers,
    };
  }

  return {
    sessions,
    activeTerminals: canvas.terminals.map((t) => ({
      id: t.id,
      panelType: t.panelType,
      title: t.title,
      widgetId: t.widgetId,
      terminalId: t.terminalId,
    })),
    theme: {
      name: theme.currentThemeName,
      ui: theme.currentTheme.ui,
      terminal: theme.currentTheme.terminal,
    },
  };
}

export default function WidgetPanel({ widgetId }: WidgetPanelProps) {
  const [widgetUrl, setWidgetUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const lastModifiedRef = useRef(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const reloadCounterRef = useRef(0);

  // Embedded browser state — native webview overlaid on the widget panel
  const embeddedBrowserId = useRef<string | null>(null);
  const [browserActive, setBrowserActive] = useState(false);
  const browserRafRef = useRef<number>(0);
  const lastBoundsRef = useRef("");

  // Get widget server port on mount
  useEffect(() => {
    getWidgetServerPort()
      .then((port) => {
        setWidgetUrl(`http://127.0.0.1:${port}/widgets/${widgetId}/index.html`);
        setLoading(false);
      })
      .catch((err) => {
        setError(`Widget server not available: ${err}`);
        setLoading(false);
      });
  }, [widgetId]);

  const lastZoomRef = useRef(0);

  // Sync embedded browser position and zoom to widget panel bounds.
  const syncBrowserBounds = useCallback(() => {
    if (!embeddedBrowserId.current || !panelRef.current) return;
    const rect = panelRef.current.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    const inset = 6;
    const bx = rect.x + inset;
    const by = rect.y;
    const bw = rect.width - inset * 2;
    const bh = rect.height - inset;
    const key = `${Math.round(bx)},${Math.round(by)},${Math.round(bw)},${Math.round(bh)}`;
    if (key !== lastBoundsRef.current) {
      lastBoundsRef.current = key;
      setBrowserBounds(embeddedBrowserId.current, bx, by, bw, bh).catch(() => {});
    }
    const canvasZoom = useCanvasStore.getState().zoom;
    if (canvasZoom !== lastZoomRef.current) {
      lastZoomRef.current = canvasZoom;
      setBrowserZoom(embeddedBrowserId.current, canvasZoom).catch(() => {});
    }
  }, []);

  // RAF loop for embedded browser
  useEffect(() => {
    if (!browserActive) return;
    const loop = () => {
      syncBrowserBounds();
      browserRafRef.current = requestAnimationFrame(loop);
    };
    browserRafRef.current = requestAnimationFrame(loop);
    return () => {
      if (browserRafRef.current) cancelAnimationFrame(browserRafRef.current);
    };
  }, [browserActive, syncBrowserBounds]);

  // Cleanup embedded browser on unmount
  useEffect(() => {
    return () => {
      if (embeddedBrowserId.current) {
        closeBrowser(embeddedBrowserId.current).catch(() => {});
        embeddedBrowserId.current = null;
        setBrowserActive(false);
      }
    };
  }, []);

  // Poll for file changes (hot-reload any file in the widget dir)
  useEffect(() => {
    pollRef.current = setInterval(async () => {
      try {
        const modified = await widgetFileModified(widgetId);
        if (modified > 0 && modified !== lastModifiedRef.current) {
          lastModifiedRef.current = modified;
          // Bump a cache-buster to force iframe reload
          reloadCounterRef.current += 1;
          setWidgetUrl((prev) => {
            if (!prev) return prev;
            const base = prev.split("?")[0];
            return `${base}?t=${reloadCounterRef.current}`;
          });
        }
      } catch {}
    }, POLL_INTERVAL);

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [widgetId]);

  // ---- Event bridge: forward Claude store changes into the iframe ----
  useEffect(() => {
    const iframe = iframeRef.current;
    const post = (msg: any) => {
      try { iframe?.contentWindow?.postMessage(msg, "*"); } catch {}
    };

    // Send initial state once iframe loads
    const onLoad = () => {
      post({ type: "t64:init", payload: buildStateSnapshot() });
    };
    iframe?.addEventListener("load", onLoad);

    // Subscribe to Claude store — emit granular events
    const unsub = useClaudeStore.subscribe((state, prev) => {
      for (const [sid, session] of Object.entries(state.sessions)) {
        const prevSession = prev.sessions[sid] as ClaudeSession | undefined;
        if (!prevSession) {
          post({ type: "t64:session-created", payload: { sessionId: sid, name: session.name, cwd: session.cwd } });
          continue;
        }

        // New messages
        if (session.messages.length > prevSession.messages.length) {
          const newMsgs = session.messages.slice(prevSession.messages.length);
          for (const msg of newMsgs) {
            post({
              type: "t64:message",
              payload: {
                sessionId: sid,
                messageId: msg.id,
                role: msg.role,
                content: msg.content,
                toolCalls: msg.toolCalls?.map((tc) => ({
                  id: tc.id,
                  name: tc.name,
                  input: tc.input,
                  result: tc.result,
                  isError: tc.isError,
                })),
              },
            });
          }
        }

        // Tool results updated
        const lastMsg = session.messages[session.messages.length - 1];
        const prevLastMsg = prevSession.messages[prevSession.messages.length - 1];
        if (lastMsg?.toolCalls && prevLastMsg?.toolCalls && lastMsg.id === prevLastMsg.id) {
          for (let i = 0; i < lastMsg.toolCalls.length; i++) {
            const tc = lastMsg.toolCalls[i];
            const ptc = prevLastMsg.toolCalls[i];
            if (tc && ptc && tc.result !== ptc.result && tc.result !== undefined) {
              post({
                type: "t64:tool-result",
                payload: {
                  sessionId: sid,
                  toolCallId: tc.id,
                  toolName: tc.name,
                  input: tc.input,
                  result: tc.result,
                  isError: tc.isError,
                },
              });
            }
          }
        }

        // Streaming state changed
        if (session.isStreaming !== prevSession.isStreaming) {
          post({ type: "t64:streaming", payload: { sessionId: sid, isStreaming: session.isStreaming } });
          const anyStreaming = Object.values(state.sessions).some((s) => s.isStreaming);
          post({ type: "t64:any-streaming", payload: { isStreaming: anyStreaming } });
        }

        // Streaming text
        if (session.streamingText && session.streamingText !== prevSession.streamingText) {
          post({ type: "t64:streaming-text", payload: { sessionId: sid, text: session.streamingText } });
        }
      }
    });

    // Listen for requests FROM the widget iframe
    const handleMessage = (e: MessageEvent) => {
      if (e.source !== iframe?.contentWindow) return;
      const msg = e.data;
      if (!msg || typeof msg.type !== "string") return;

      switch (msg.type) {
        case "t64:request-state":
          post({ type: "t64:state", payload: buildStateSnapshot() });
          return;

        case "t64:open-url": {
          const url = msg.payload?.url;
          if (url && typeof url === "string") {
            useCanvasStore.getState().addBrowserPanel(url, msg.payload?.title);
          }
          return;
        }

        case "t64:embed-browser": {
          const url = msg.payload?.url;
          if (!url || typeof url !== "string") return;
          const el = panelRef.current;
          if (!el) return;
          const rect = el.getBoundingClientRect();
          const inset = 6;
          const bid = `wdg-browser-${widgetId}`;
          if (embeddedBrowserId.current) {
            navigateBrowser(bid, url).catch(() => {});
          } else {
            embeddedBrowserId.current = bid;
            createBrowser(bid, url, rect.x + inset, rect.y, rect.width - inset * 2, rect.height - inset)
              .then(() => setBrowserActive(true))
              .catch((err) => {
                console.warn("[widget] Failed to create embedded browser:", err);
                embeddedBrowserId.current = null;
              });
          }
          post({ type: "t64:browser-ready", payload: { browserId: bid } });
          return;
        }

        case "t64:navigate-browser": {
          const url = msg.payload?.url;
          if (embeddedBrowserId.current && url && typeof url === "string") {
            navigateBrowser(embeddedBrowserId.current, url).catch(() => {});
          }
          return;
        }

        case "t64:close-browser":
          if (embeddedBrowserId.current) {
            closeBrowser(embeddedBrowserId.current).catch(() => {});
            embeddedBrowserId.current = null;
            lastBoundsRef.current = "";
            setBrowserActive(false);
          }
          return;

        case "t64:show-browser":
          if (embeddedBrowserId.current) setBrowserVisible(embeddedBrowserId.current, true).catch(() => {});
          return;

        case "t64:hide-browser":
          if (embeddedBrowserId.current) setBrowserVisible(embeddedBrowserId.current, false).catch(() => {});
          return;

        case "t64:eval-browser": {
          const js = msg.payload?.js;
          if (embeddedBrowserId.current && js && typeof js === "string") {
            browserEval(embeddedBrowserId.current, js).catch(() => {});
          }
          return;
        }

        // ---- Widget bounds (for positioning relative terminals) ----

        case "t64:get-bounds": {
          const { id: gbId } = msg.payload || {};
          const panel = useCanvasStore.getState().terminals.find(
            (t) => t.panelType === "widget" && t.widgetId === widgetId
          );
          if (panel) {
            post({ type: "t64:bounds", payload: { id: gbId, x: panel.x, y: panel.y, width: panel.width, height: panel.height } });
          }
          return;
        }

        // ---- File open (opens in Monaco editor overlay) ----

        case "t64:open-file": {
          const { path: filePath } = msg.payload || {};
          if (filePath && typeof filePath === "string") {
            // Validate file exists before dispatching
            readFile(filePath)
              .then(() => {
                window.dispatchEvent(new CustomEvent("t64-open-file", { detail: { path: filePath } }));
              })
              .catch(() => {
                post({ type: "t64:open-file-error", payload: { path: filePath, error: "File not found" } });
              });
          }
          return;
        }

        // ---- Shell / System ----

        case "t64:exec": {
          const { command, cwd: execCwd, id: execId } = msg.payload || {};
          if (!command || typeof command !== "string") return;
          shellExec(command, execCwd || undefined)
            .then((result) => post({ type: "t64:exec-result", payload: { id: execId, ...result } }))
            .catch((err) => post({ type: "t64:exec-result", payload: { id: execId, stdout: "", stderr: String(err), code: -1 } }));
          return;
        }

        // ---- File System ----

        case "t64:read-file": {
          const { path, id: rfId } = msg.payload || {};
          if (!path || typeof path !== "string") return;
          readFile(path)
            .then((content) => post({ type: "t64:file-content", payload: { id: rfId, path, content, error: null } }))
            .catch((err) => post({ type: "t64:file-content", payload: { id: rfId, path, content: null, error: String(err) } }));
          return;
        }

        case "t64:write-file": {
          const { path, content, id: wfId } = msg.payload || {};
          if (!path || typeof path !== "string" || typeof content !== "string") return;
          writeFile(path, content)
            .then(() => post({ type: "t64:file-written", payload: { id: wfId, path, error: null } }))
            .catch((err) => post({ type: "t64:file-written", payload: { id: wfId, path, error: String(err) } }));
          return;
        }

        case "t64:list-dir": {
          const { path, id: ldId } = msg.payload || {};
          if (!path || typeof path !== "string") return;
          listDirectory(path)
            .then((entries) => post({ type: "t64:dir-listing", payload: { id: ldId, path, entries, error: null } }))
            .catch((err) => post({ type: "t64:dir-listing", payload: { id: ldId, path, entries: null, error: String(err) } }));
          return;
        }

        case "t64:search-files": {
          const { cwd: sfCwd, query, id: sfId } = msg.payload || {};
          if (!sfCwd || !query) return;
          searchFiles(sfCwd, query)
            .then((results) => post({ type: "t64:search-results", payload: { id: sfId, results, error: null } }))
            .catch((err) => post({ type: "t64:search-results", payload: { id: sfId, results: null, error: String(err) } }));
          return;
        }

        case "t64:delete-files": {
          const { paths, id: dfId } = msg.payload || {};
          if (!Array.isArray(paths)) return;
          deleteFiles(paths)
            .then(() => post({ type: "t64:files-deleted", payload: { id: dfId, error: null } }))
            .catch((err) => post({ type: "t64:files-deleted", payload: { id: dfId, error: String(err) } }));
          return;
        }

        // ---- Terminal ----

        case "t64:create-terminal": {
          const { cwd: termCwd, id: ctId, x: termX, y: termY, width: termW, height: termH, title: termTitle } = msg.payload || {};
          const newTerm = useCanvasStore.getState().addTerminal(
            termX ?? undefined, termY ?? undefined, termCwd || undefined,
            termW ?? undefined, termH ?? undefined, termTitle ?? undefined,
          );
          const tid = newTerm.terminalId;
          // Wait for the PTY to actually spawn (first output = shell prompt)
          // before telling the widget the terminal is ready to receive writes.
          let responded = false;
          const respond = () => {
            if (responded) return;
            responded = true;
            post({ type: "t64:terminal-created", payload: { id: ctId, terminalId: tid } });
          };
          onTerminalOutput((out) => {
            if (out.id === tid) respond();
          }).then((unlisten) => {
            // Clean up listener once we've responded (or after timeout)
            const cleanup = () => { unlisten(); respond(); };
            if (responded) { unlisten(); return; }
            setTimeout(cleanup, 3000);
          });
          return;
        }

        case "t64:write-terminal": {
          const { terminalId, data } = msg.payload || {};
          if (!terminalId || typeof data !== "string") return;
          writeTerminal(terminalId, data).catch(() => {});
          return;
        }

        case "t64:close-terminal": {
          const { terminalId: closeTid } = msg.payload || {};
          if (!closeTid || typeof closeTid !== "string") return;
          closeTerminal(closeTid).catch(() => {});
          const panel = useCanvasStore.getState().terminals.find((t) => t.terminalId === closeTid);
          if (panel) useCanvasStore.getState().removeTerminal(panel.id);
          return;
        }

        // ---- Claude Sessions ----

        case "t64:send-prompt": {
          const { sessionId, prompt, id: spId } = msg.payload || {};
          if (!sessionId || !prompt) return;
          const sess = useClaudeStore.getState().sessions[sessionId];
          if (!sess) { post({ type: "t64:prompt-sent", payload: { id: spId, error: "Session not found" } }); return; }
          sendClaudePrompt({
            session_id: sessionId,
            cwd: sess.cwd,
            prompt,
            permission_mode: "auto",
          })
            .then(() => post({ type: "t64:prompt-sent", payload: { id: spId, error: null } }))
            .catch((err) => post({ type: "t64:prompt-sent", payload: { id: spId, error: String(err) } }));
          return;
        }

        case "t64:create-session": {
          const { cwd: sessCwd, name: sessName, prompt: sessPrompt, id: csId } = msg.payload || {};
          const panel = useCanvasStore.getState().addClaudeTerminalAt(
            sessCwd || ".", false, sessName || "Widget Session"
          );
          const sid = panel.terminalId;
          useClaudeStore.getState().createSession(sid, sessName || "Widget Session");
          if (sessPrompt) {
            setTimeout(() => {
              createClaudeSession({
                session_id: sid,
                cwd: sessCwd || ".",
                prompt: sessPrompt,
                permission_mode: "auto",
              }).catch(() => {});
              useClaudeStore.getState().addUserMessage(sid, sessPrompt);
              useClaudeStore.getState().incrementPromptCount(sid);
            }, 300);
          }
          post({ type: "t64:session-spawned", payload: { id: csId, sessionId: sid } });
          return;
        }

        // ---- Fetch proxy (CORS bypass) ----

        case "t64:fetch": {
          const { url, method, headers: hdrs, body: fetchBody, id: fetchId } = msg.payload || {};
          if (!url || typeof url !== "string") return;
          proxyFetch(url, method, hdrs, fetchBody)
            .then((result) => post({ type: "t64:fetch-result", payload: { id: fetchId, ...result, error: null } }))
            .catch((err) => post({ type: "t64:fetch-result", payload: { id: fetchId, status: 0, ok: false, headers: {}, body: "", is_base64: false, error: String(err) } }));
          return;
        }

        // ---- Persistent state ----

        case "t64:get-state": {
          const { key, id: gsId } = msg.payload || {};
          widgetGetState(widgetId, key || undefined)
            .then((value) => post({ type: "t64:state-value", payload: { id: gsId, key, value, error: null } }))
            .catch((err) => post({ type: "t64:state-value", payload: { id: gsId, key, value: null, error: String(err) } }));
          return;
        }

        case "t64:set-state": {
          const { key, value, id: ssId } = msg.payload || {};
          if (!key || typeof key !== "string") return;
          widgetSetState(widgetId, key, value)
            .then(() => post({ type: "t64:state-saved", payload: { id: ssId, error: null } }))
            .catch((err) => post({ type: "t64:state-saved", payload: { id: ssId, error: String(err) } }));
          return;
        }

        case "t64:clear-state": {
          const { id: csId2 } = msg.payload || {};
          widgetClearState(widgetId)
            .then(() => post({ type: "t64:state-cleared", payload: { id: csId2, error: null } }))
            .catch((err) => post({ type: "t64:state-cleared", payload: { id: csId2, error: String(err) } }));
          return;
        }

        // ---- In-app notification ----

        case "t64:notify": {
          const { title, body: notifBody, id: nId } = msg.payload || {};
          if (!title || typeof title !== "string") return;
          pushToast(title.slice(0, 256), notifBody ? String(notifBody).slice(0, 1024) : undefined);
          post({ type: "t64:notify-result", payload: { id: nId, error: null } });
          return;
        }

        // ---- Inter-widget communication ----

        case "t64:subscribe": {
          const { topic } = msg.payload || {};
          if (!topic || typeof topic !== "string") return;
          widgetBus.subscribe(topic, widgetId, (data) => {
            post({ type: "t64:broadcast", payload: { topic, data } });
          });
          return;
        }

        case "t64:unsubscribe": {
          const { topic } = msg.payload || {};
          if (!topic || typeof topic !== "string") return;
          widgetBus.unsubscribe(topic, widgetId);
          return;
        }

        case "t64:broadcast": {
          const { topic, data } = msg.payload || {};
          if (!topic || typeof topic !== "string") return;
          widgetBus.broadcast(topic, data, widgetId);
          return;
        }

        default: break;
      }

      if (msg.type === "t64:request-messages") {
        const sid = msg.payload?.sessionId;
        const session = useClaudeStore.getState().sessions[sid];
        if (session) {
          post({
            type: "t64:messages",
            payload: {
              sessionId: sid,
              messages: session.messages.map((m) => ({
                id: m.id,
                role: m.role,
                content: m.content,
                toolCalls: m.toolCalls?.map((tc) => ({
                  id: tc.id,
                  name: tc.name,
                  input: tc.input,
                  result: tc.result,
                  isError: tc.isError,
                })),
              })),
            },
          });
        }
      }
    };

    window.addEventListener("message", handleMessage);

    return () => {
      unsub();
      iframe?.removeEventListener("load", onLoad);
      window.removeEventListener("message", handleMessage);
      widgetBus.unsubscribeAll(widgetId);
    };
  }, [widgetUrl, widgetId]);

  if (error) {
    return (
      <div className="wdg-panel wdg-panel--error">
        <span className="wdg-error-icon">!</span>
        <span className="wdg-error-text">{error}</span>
      </div>
    );
  }

  if (loading || !widgetUrl) {
    return (
      <div className="wdg-panel wdg-panel--loading">
        <div className="wdg-spinner" />
        <span className="wdg-loading-text">Waiting for widget content...</span>
        <span className="wdg-loading-sub">Claude is building your widget in ~/.terminal64/widgets/{widgetId}/</span>
      </div>
    );
  }

  return (
    <div className="wdg-panel" ref={panelRef}>
      <iframe
        ref={iframeRef}
        className="wdg-iframe"
        src={widgetUrl}
        sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-modals"
        allow="camera; microphone; geolocation; clipboard-read; clipboard-write"
        title={`Widget: ${widgetId}`}
      />
    </div>
  );
}
