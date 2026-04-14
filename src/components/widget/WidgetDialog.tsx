import { useState, useEffect, useRef } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { listWidgetFolders, createWidgetFolder, deleteWidgetFolder, installWidgetZip, createClaudeSession, shellExec, WidgetInfo } from "../../lib/tauriApi";
import { useCanvasStore } from "../../stores/canvasStore";
import { useClaudeStore } from "../../stores/claudeStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { pushToast } from "../../lib/notifications";
import type { PermissionMode } from "../../lib/types";
import "./Widget.css";

const WIDGET_SYSTEM_PROMPT = `You are building a widget for Terminal 64, a canvas-based terminal emulator.

A "widget" is a web panel that lives inside Terminal 64. Your job is to create files in this folder (starting with \`index.html\`) that Terminal 64 will hot-load into an iframe via a local HTTP server.

**Rules:**
- The entry point is always \`index.html\` — Terminal 64 loads it automatically
- You can use MULTIPLE files: separate CSS, JS, images, JSON, sub-pages — anything served over HTTP works. Use relative paths (e.g. \`<script src="app.js">\`, \`<link href="style.css">\`)
- The iframe is sandboxed with \`allow-scripts allow-same-origin allow-popups allow-forms allow-modals\` and has camera/microphone/geolocation/clipboard permissions
- You CAN use external CDN imports, embed external iframes, and fetch from APIs
- Terminal 64 auto-reloads the iframe whenever ANY file in the widget folder changes
- Make it visually polished — use good typography, spacing, and color
- The widget should be responsive and look good at any size (the user can resize the panel)
- For simple widgets, a single \`index.html\` with inline CSS/JS is fine. For complex widgets, split into multiple files

## Terminal 64 Widget API (postMessage bridge)

Widgets communicate with Terminal 64 via \`window.parent.postMessage(msg, "*")\` and listen for responses via \`window.addEventListener("message", handler)\`. All async operations return results via response events. Include an \`id\` field in your payload to correlate requests with responses.

\`\`\`js
// Reusable helper — use this for all async bridge calls
function t64(type, payload = {}) {
  return new Promise((resolve) => {
    const id = Math.random().toString(36).slice(2);
    const handler = (e) => {
      if (e.data?.payload?.id === id) {
        window.removeEventListener("message", handler);
        resolve(e.data.payload);
      }
    };
    window.addEventListener("message", handler);
    window.parent.postMessage({ type, payload: { ...payload, id } }, "*");
  });
}
\`\`\`

---

### 1. SHELL / SYSTEM — Run any command

| Request | Payload | Response event | Response payload |
|---|---|---|---|
| \`t64:exec\` | \`{ command, cwd?, id? }\` | \`t64:exec-result\` | \`{ id, stdout, stderr, code }\` |

\`\`\`js
const result = await t64("t64:exec", { command: "git log --oneline -20" });
const ls = await t64("t64:exec", { command: "ls -la", cwd: "/Users/me/projects" });
\`\`\`

---

### 2. FILE SYSTEM — Read, write, list, search, delete

| Request | Payload | Response event | Response payload |
|---|---|---|---|
| \`t64:read-file\` | \`{ path, id? }\` | \`t64:file-content\` | \`{ id, path, content, error }\` |
| \`t64:write-file\` | \`{ path, content, id? }\` | \`t64:file-written\` | \`{ id, path, error }\` |
| \`t64:list-dir\` | \`{ path, id? }\` | \`t64:dir-listing\` | \`{ id, path, entries[], error }\` |
| \`t64:search-files\` | \`{ cwd, query, id? }\` | \`t64:search-results\` | \`{ id, results[], error }\` |
| \`t64:delete-files\` | \`{ paths[], id? }\` | \`t64:files-deleted\` | \`{ id, error }\` |

\`\`\`js
const file = await t64("t64:read-file", { path: "/Users/me/project/src/main.ts" });
const dir = await t64("t64:list-dir", { path: "/Users/me/project/src" });
// dir.entries = [{ name, is_dir, size, modified }, ...]
\`\`\`

---

### 3. TERMINAL — Create and control interactive terminals

| Request | Payload | Response event | Response payload |
|---|---|---|---|
| \`t64:create-terminal\` | \`{ cwd?, id? }\` | \`t64:terminal-created\` | \`{ id, terminalId }\` |
| \`t64:write-terminal\` | \`{ terminalId, data }\` | none (fire & forget) | — |

\`\`\`js
const term = await t64("t64:create-terminal", { cwd: "/Users/me/project" });
window.parent.postMessage({ type: "t64:write-terminal", payload: { terminalId: term.terminalId, data: "npm run dev\\r" } }, "*");
\`\`\`

---

### 4. CLAUDE SESSIONS — Create sessions and send prompts

| Request | Payload | Response event | Response payload |
|---|---|---|---|
| \`t64:create-session\` | \`{ cwd?, name?, prompt?, id? }\` | \`t64:session-spawned\` | \`{ id, sessionId }\` |
| \`t64:send-prompt\` | \`{ sessionId, prompt, id? }\` | \`t64:prompt-sent\` | \`{ id, error }\` |
| \`t64:request-state\` | none | \`t64:state\` | \`{ sessions, activeTerminals, theme }\` |
| \`t64:request-messages\` | \`{ sessionId }\` | \`t64:messages\` | \`{ sessionId, messages[] }\` |

---

### 5. REAL-TIME EVENTS — Listen to Claude activity

Events pushed FROM Terminal 64 (listen with \`window.addEventListener("message", handler)\`):

| \`event.data.type\` | Payload | When |
|---|---|---|
| \`t64:init\` | \`{ sessions, activeTerminals, theme }\` | On iframe load — full app state snapshot |
| \`t64:state\` | Same as init | Response to \`t64:request-state\` |
| \`t64:message\` | \`{ sessionId, messageId, role, content, toolCalls[] }\` | New message in any Claude session |
| \`t64:tool-result\` | \`{ sessionId, toolCallId, toolName, input, result, isError }\` | Tool call completed |
| \`t64:streaming\` | \`{ sessionId, isStreaming }\` | A specific session starts/stops streaming |
| \`t64:any-streaming\` | \`{ isStreaming }\` | True if ANY session is currently streaming |
| \`t64:streaming-text\` | \`{ sessionId, text }\` | Live streaming text update |
| \`t64:messages\` | \`{ sessionId, messages[] }\` | Response to \`t64:request-messages\` |
| \`t64:session-created\` | \`{ sessionId, name, cwd }\` | New session created |

---

### 6. EMBEDDED BROWSER — Load any webpage inside the widget

| Request | Payload | Response |
|---|---|---|
| \`t64:embed-browser\` | \`{ url }\` | \`t64:browser-ready { browserId }\` |
| \`t64:navigate-browser\` | \`{ url }\` | — |
| \`t64:show-browser\` / \`t64:hide-browser\` | none | — |
| \`t64:eval-browser\` | \`{ js }\` | — |
| \`t64:close-browser\` | none | — |
| \`t64:open-url\` | \`{ url, title? }\` | Opens a separate browser panel on canvas |

---

### 7. FETCH PROXY — Bypass CORS restrictions

| Request | Payload | Response event | Response payload |
|---|---|---|---|
| \`t64:fetch\` | \`{ url, method?, headers?, body?, id? }\` | \`t64:fetch-result\` | \`{ id, status, ok, headers, body, is_base64, error }\` |

Fetches any URL through the Rust backend, bypassing CORS. Binary responses are returned as base64 (\`is_base64: true\`). Max 50MB.

\`\`\`js
const res = await t64("t64:fetch", { url: "https://api.github.com/repos/owner/repo", headers: { "Accept": "application/json" } });
const data = JSON.parse(res.body);
\`\`\`

---

### 8. PERSISTENT STATE — Save data across reloads

| Request | Payload | Response event | Response payload |
|---|---|---|---|
| \`t64:get-state\` | \`{ key?, id? }\` | \`t64:state-value\` | \`{ id, key, value, error }\` |
| \`t64:set-state\` | \`{ key, value, id? }\` | \`t64:state-saved\` | \`{ id, error }\` |
| \`t64:clear-state\` | \`{ id? }\` | \`t64:state-cleared\` | \`{ id, error }\` |

State is stored per-widget in \`~/.terminal64/widgets/{id}/state.json\`. Omit \`key\` in get-state to retrieve all keys.

\`\`\`js
await t64("t64:set-state", { key: "lastQuery", value: "SELECT * FROM users" });
const saved = await t64("t64:get-state", { key: "lastQuery" });
// saved.value === "SELECT * FROM users"
\`\`\`

---

### 9. FILE OPEN — Open files in the Monaco editor overlay

| Request | Payload | Response |
|---|---|---|
| \`t64:open-file\` | \`{ path }\` | — (opens in first available Claude session's editor) |

\`\`\`js
window.parent.postMessage({ type: "t64:open-file", payload: { path: "/Users/me/project/src/main.ts" } }, "*");
\`\`\`

---

### 10. SYSTEM NOTIFICATIONS — macOS native alerts

| Request | Payload | Response event | Response payload |
|---|---|---|---|
| \`t64:notify\` | \`{ title, body?, id? }\` | \`t64:notify-result\` | \`{ id, error }\` |

\`\`\`js
await t64("t64:notify", { title: "Build Complete", body: "No errors found" });
\`\`\`

---

### 11. INTER-WIDGET COMMUNICATION — Pub/sub between widgets

| Request | Payload | Response |
|---|---|---|
| \`t64:subscribe\` | \`{ topic }\` | Receives \`t64:broadcast\` events with \`{ topic, data }\` |
| \`t64:unsubscribe\` | \`{ topic }\` | — |
| \`t64:broadcast\` | \`{ topic, data }\` | Sent to all OTHER widgets subscribed to that topic |

\`\`\`js
// Widget A: subscribe to "data-updates"
window.parent.postMessage({ type: "t64:subscribe", payload: { topic: "data-updates" } }, "*");
window.addEventListener("message", (e) => {
  if (e.data?.type === "t64:broadcast" && e.data.payload?.topic === "data-updates") {
    console.log("Got update:", e.data.payload.data);
  }
});

// Widget B: broadcast to all subscribers
window.parent.postMessage({ type: "t64:broadcast", payload: { topic: "data-updates", data: { count: 42 } } }, "*");
\`\`\`

---

### Theme colors (from \`t64:init\` payload.theme.ui):
\`bg\`, \`bgSecondary\`, \`bgTertiary\`, \`fg\`, \`fgSecondary\`, \`fgMuted\`, \`border\`, \`accent\`, \`accentHover\`

---

### Example: Git commit visualizer
\`\`\`js
const result = await t64("t64:exec", { command: "git log --oneline --graph --all -50" });
document.getElementById("graph").textContent = result.stdout;

setInterval(async () => {
  const status = await t64("t64:exec", { command: "git status --porcelain" });
  document.getElementById("status").textContent = status.stdout || "Clean";
}, 3000);
\`\`\`

**IMPORTANT: Do NOT start building yet.** The folder name is just an identifier — it does NOT describe what the user wants. You must ask the user to describe what they want the widget to do, how it should look, and any specific features before you write any code.

Ask: "What would you like this widget to do?"`;

/** Remind Claude that theme is reactive — no hardcoded colors. */
function buildWidgetContext(): string {
  return `**Theme is reactive.** Do NOT hardcode colors. On load, listen for the \`t64:init\` event and read \`payload.theme.ui\` to get the current theme colors (bg, fg, accent, border, bgSecondary, fgMuted, etc.), then apply them as CSS variables or inline styles. The theme can change at any time — use the \`t64:init\` event each time the iframe reloads to stay in sync.`;
}

interface WidgetDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function WidgetDialog({ isOpen, onClose }: WidgetDialogProps) {
  const [widgets, setWidgets] = useState<WidgetInfo[]>([]);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [installing, setInstalling] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const refreshList = () => listWidgetFolders().then(setWidgets).catch(() => {});

  useEffect(() => {
    if (!isOpen) return;
    setName("");
    setIsDragOver(false);
    setInstalling(false);
    refreshList();
    setTimeout(() => inputRef.current?.focus(), 100);
  }, [isOpen]);

  // Listen for native file drops while dialog is open
  useEffect(() => {
    if (!isOpen) return;
    let unlisten: (() => void) | null = null;
    getCurrentWebviewWindow()
      .onDragDropEvent(async (event: any) => {
        const { type, paths } = event.payload;
        if (type === "over") {
          const hasZip = (paths as string[])?.some((p: string) => p.toLowerCase().endsWith(".zip"));
          if (hasZip) setIsDragOver(true);
        } else if (type === "leave" || type === "cancel") {
          setIsDragOver(false);
        } else if (type === "drop") {
          setIsDragOver(false);
          const zipFiles = ((paths as string[]) || []).filter((p: string) => p.toLowerCase().endsWith(".zip"));
          if (zipFiles.length === 0) return;
          setInstalling(true);
          for (const zipPath of zipFiles) {
            try {
              const widgetId = await installWidgetZip(zipPath);
              useCanvasStore.getState().addWidgetTerminal(widgetId);
              pushToast("Widget installed", widgetId);
            } catch (err) {
              pushToast("Widget install failed", String(err));
            }
          }
          refreshList();
          setInstalling(false);
        }
      })
      .then((fn) => { unlisten = fn; })
      .catch((err) => console.warn("[widget-drop]", err));
    return () => { if (unlisten) unlisten(); };
  }, [isOpen]);

  if (!isOpen) return null;

  const handleCreate = async () => {
    const id = name.trim().toLowerCase().replace(/[^a-z0-9-_]/g, "-").replace(/-+/g, "-");
    if (!id) return;
    setCreating(true);
    try {
      const folderPath = await createWidgetFolder(id);
      const widgetName = name.trim();
      // Open widget panel on canvas
      useCanvasStore.getState().addWidgetTerminal(id, widgetName);
      // Open a Claude session pointed at the widget folder
      useCanvasStore.getState().addClaudeTerminal(folderPath, false, `Widget: ${widgetName}`);
      // Auto-send the system prompt to the new Claude session
      const terminals = useCanvasStore.getState().terminals;
      const claudePanel = terminals[terminals.length - 1];
      if (claudePanel?.panelType === "claude") {
        const sid = claudePanel.terminalId;
        const fullPrompt = WIDGET_SYSTEM_PROMPT + "\n\n" + buildWidgetContext();
        useClaudeStore.getState().createSession(sid, `Widget: ${widgetName}`);
        useClaudeStore.getState().addUserMessage(sid, fullPrompt);
        const permMode = (useSettingsStore.getState().claudePermMode || "default") as PermissionMode;
        // Small delay so ClaudeChat mounts and event listeners are ready
        setTimeout(() => {
          createClaudeSession({
            session_id: sid,
            cwd: folderPath,
            prompt: fullPrompt,
            permission_mode: permMode,
          }).catch((err) => {
            useClaudeStore.getState().setError(sid, String(err));
          });
          useClaudeStore.getState().incrementPromptCount(sid);
        }, 300);
      }
      onClose();
    } catch (err) {
      console.warn("[widget] Failed to create:", err);
    } finally {
      setCreating(false);
    }
  };

  const handleOpen = (widget: WidgetInfo) => {
    const existing = useCanvasStore.getState().terminals.find(
      (t) => t.panelType === "widget" && t.widgetId === widget.widget_id,
    );
    if (existing) {
      useCanvasStore.getState().bringToFront(existing.id);
      onClose();
      return;
    }
    useCanvasStore.getState().addWidgetTerminal(widget.widget_id);
    onClose();
  };

  const handleDelete = async (e: React.MouseEvent, widget: WidgetInfo) => {
    e.stopPropagation();
    try {
      await deleteWidgetFolder(widget.widget_id);
      // Also close any open widget panels for this widget
      const terminals = useCanvasStore.getState().terminals;
      for (const t of terminals) {
        if (t.panelType === "widget" && t.widgetId === widget.widget_id) {
          useCanvasStore.getState().removeTerminal(t.id);
        }
      }
      refreshList();
    } catch (err) {
      console.warn("[widget] Failed to delete:", err);
    }
  };

  const formatTime = (ms: number) => {
    if (!ms) return "";
    const now = Date.now();
    const diff = now - ms;
    if (diff < 60000) return "just now";
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return new Date(ms).toLocaleDateString();
  };

  return (
    <div className="wdg-dialog-overlay" onClick={onClose}>
      <div className="wdg-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="wdg-dialog-header">
          <span className="wdg-dialog-title">Widgets</span>
          <button className="wdg-dialog-close" onClick={onClose}>
            <svg width="10" height="10" viewBox="0 0 10 10">
              <path d="M1 1L9 9M9 1L1 9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="wdg-dialog-body">
          <div className="wdg-form">
            <label>Create a new widget</label>
            <input
              ref={inputRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Widget name..."
              onKeyDown={(e) => {
                if (e.key === "Enter" && name.trim()) handleCreate();
                if (e.key === "Escape") onClose();
              }}
            />
            <div className="wdg-form-actions">
              <button className="wdg-btn wdg-btn--cancel" onClick={onClose}>Cancel</button>
              <button
                className="wdg-btn wdg-btn--create"
                onClick={handleCreate}
                disabled={!name.trim() || creating}
              >
                {creating ? "Creating..." : "Create"}
              </button>
            </div>
          </div>

          {widgets.length > 0 && (
            <>
              <div className="wdg-section-label">Existing Widgets</div>
              <div className="wdg-list">
                {widgets.map((w) => (
                  <div
                    key={w.widget_id}
                    className="wdg-list-item"
                    onClick={() => handleOpen(w)}
                  >
                    <div className={`wdg-list-item-dot ${w.has_index ? "wdg-list-item-dot--ready" : "wdg-list-item-dot--empty"}`} />
                    <span className="wdg-list-item-name">{w.widget_id}</span>
                    <span className="wdg-list-item-time">{formatTime(w.modified)}</span>
                    <button
                      className="wdg-list-item-delete"
                      onClick={(e) => handleDelete(e, w)}
                      title="Delete widget"
                    >
                      <svg width="10" height="10" viewBox="0 0 10 10">
                        <path d="M2 3H8M3 3V8.5H7V3M4 4.5V7M6 4.5V7M3.5 3L4 1.5H6L6.5 3" stroke="currentColor" strokeWidth="0.9" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}

          {widgets.length === 0 && (
            <div className="wdg-empty">
              No widgets yet. Create one to get started.
            </div>
          )}

          <div className="wdg-section-label">Install Widget</div>
          <div className={`wdg-drop-zone ${isDragOver ? "wdg-drop-zone--active" : ""} ${installing ? "wdg-drop-zone--installing" : ""}`}>
            {installing ? (
              <>
                <div className="wdg-spinner" />
                <span className="wdg-drop-zone-text">Installing...</span>
              </>
            ) : (
              <>
                <svg className="wdg-drop-zone-icon" width="24" height="24" viewBox="0 0 24 24" fill="none">
                  <path d="M21 15V19C21 20.1 20.1 21 19 21H5C3.9 21 3 20.1 3 19V15" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M7 10L12 15L17 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M12 15V3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                <span className="wdg-drop-zone-text">
                  {isDragOver ? "Release to install" : "Drag & drop .zip to install"}
                </span>
              </>
            )}
          </div>

          <button
            className="wdg-open-folder"
            onClick={() => {
              const cmd = navigator.platform.includes("Win")
                ? 'explorer.exe "%USERPROFILE%\\.terminal64\\widgets"'
                : 'open "$HOME/.terminal64/widgets"';
              shellExec(cmd).catch(() => {});
            }}
          >
            Open Widgets Folder
          </button>
        </div>
      </div>
    </div>
  );
}
