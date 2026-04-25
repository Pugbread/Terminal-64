import { useEffect, useRef, useState } from "react";
import { Toaster } from "sonner";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import Canvas from "./components/canvas/Canvas";
import CommandPalette from "./components/command-palette/CommandPalette";
import SettingsPanel from "./components/settings/SettingsPanel";
import PopOutTerminal from "./components/canvas/PopOutTerminal";
import ClaudeDialog from "./components/canvas/ClaudeDialog";
import WidgetDialog from "./components/widget/WidgetDialog";
import SkillDialog from "./components/skill/SkillDialog";
import { useTheme } from "./hooks/useTheme";
import { useKeybindings } from "./hooks/useKeybindings";
import { useClaudeEvents } from "./hooks/useClaudeEvents";
import { useDelegationOrchestrator } from "./hooks/useDelegationOrchestrator";
import { usePartyMode } from "./hooks/usePartyMode";
import { useVoiceControl } from "./hooks/useVoiceControl";
import { useVoiceStore } from "./stores/voiceStore";
import { PartyEqualizer, PartyEdgeGlow } from "./components/party/PartyOverlay";
import { useCanvasStore } from "./stores/canvasStore";
import { useThemeStore } from "./stores/themeStore";
import { useSettingsStore } from "./stores/settingsStore";
import { registerCommand } from "./lib/commands";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { closeTerminal, closeClaudeSession, closeCodexSession, linkSessionToDiscord, unlinkSessionFromDiscord, renameDiscordSession, startDiscordBot, discordCleanupOrphaned, setAllBrowsersVisible, ensureSkillsPlugin, installWidgetZip, openwolfDaemonSwitch, openwolfProjectCwd, installBundledWidget } from "./lib/tauriApi";
import { pushToast } from "./lib/notifications";
import { useDelegationStore } from "./stores/delegationStore";
import { useClaudeStore, flushSave as flushClaudeSave, STORAGE_KEY } from "./stores/claudeStore";
import { checkForUpdate, type UpdateInfo } from "./lib/updater";
import "./App.css";

const appWindow = getCurrentWindow();
const isPopOut = new URLSearchParams(window.location.search).has("popout");

function App() {
  if (isPopOut) return <PopOutTerminal />;
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [claudeDialogOpen, setClaudeDialogOpen] = useState(false);
  const [widgetDialogOpen, setWidgetDialogOpen] = useState(false);
  const [skillDialogOpen, setSkillDialogOpen] = useState(false);

  useTheme();
  useKeybindings();
  useClaudeEvents();
  useDelegationOrchestrator();
  usePartyMode();
  useVoiceControl();

  const [widgetDropOver, setWidgetDropOver] = useState(false);
  const widgetDialogRef = useRef(widgetDialogOpen);
  widgetDialogRef.current = widgetDialogOpen;

  // Global drag-drop: intercept .zip files and install as widgets (skips when widget dialog handles it)
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    getCurrentWebviewWindow()
      .onDragDropEvent(async (event) => {
        if (widgetDialogRef.current) return;
        const payload = event.payload;
        if (payload.type === "enter") {
          const hasZip = payload.paths.some((p) => p.toLowerCase().endsWith(".zip"));
          if (hasZip) setWidgetDropOver(true);
        } else if (payload.type === "leave") {
          setWidgetDropOver(false);
        } else if (payload.type === "drop") {
          setWidgetDropOver(false);
          const zipFiles = payload.paths.filter((p) => p.toLowerCase().endsWith(".zip"));
          for (const zipPath of zipFiles) {
            try {
              const widgetId = await installWidgetZip(zipPath);
              useCanvasStore.getState().addWidgetTerminal(widgetId);
              pushToast("Widget installed", widgetId);
            } catch (err) {
              pushToast("Widget install failed", String(err));
            }
          }
        }
      })
      .then((fn) => { unlisten = fn; })
      .catch((err) => console.warn("[widget-drop]", err));
    return () => { if (unlisten) unlisten(); };
  }, []);

  // Hide all native browser webviews when any overlay is open (they render above DOM)
  const anyOverlayOpen = settingsOpen || paletteOpen || claudeDialogOpen || widgetDialogOpen || skillDialogOpen;
  useEffect(() => {
    setAllBrowsersVisible(!anyOverlayOpen).catch(() => {});
  }, [anyOverlayOpen]);

  useEffect(() => {
    checkForUpdate().then(setUpdate);
    ensureSkillsPlugin().catch(() => {});
  }, []);

  // Restore saved settings (theme, opacity) on startup
  useEffect(() => {
    const saved = useSettingsStore.getState();
    if (saved.theme) useThemeStore.getState().setTheme(saved.theme);
    if (saved.bgAlpha < 1) useThemeStore.getState().setBgAlpha(saved.bgAlpha);
    // Sync bundled widgets to latest version on every launch
    installBundledWidget("project-intel").catch(() => {});
    // Auto-connect Discord bot if credentials are saved, then link open sessions
    if (saved.discordBotToken && saved.discordServerId) {
      startDiscordBot(saved.discordBotToken, saved.discordServerId).then(async () => {
        // Wait for gateway to be ready, then link all open Claude panels sequentially
        await new Promise((r) => setTimeout(r, 2000));
        const terminals = useCanvasStore.getState().terminals;
        // Pull the authoritative name/cwd from claudeStore — canvas `t.title` is a
        // stale snapshot that isn't updated when the user renames a Claude session.
        let claudeSaved: Record<string, { name?: string; cwd?: string }> = {};
        try {
          const raw = localStorage.getItem(STORAGE_KEY);
          if (raw) claudeSaved = JSON.parse(raw);
        } catch (e) {
          console.warn("[discord] Failed to read claude store:", e);
        }
        const claudeSessions = useClaudeStore.getState().sessions;

        for (const t of terminals) {
          if (t.panelType !== "claude") continue;
          const liveName = claudeSessions[t.terminalId]?.name;
          const savedName = claudeSaved[t.terminalId]?.name;
          const name = (liveName || savedName || "").trim();
          if (!name) continue;
          const cwd = claudeSessions[t.terminalId]?.cwd
            || claudeSaved[t.terminalId]?.cwd
            || t.cwd
            || "";
          try {
            await renameDiscordSession(t.terminalId, name, cwd);
          } catch (err) {
            console.warn("[discord] Failed to rename/link session:", t.terminalId, err);
            await new Promise((r) => setTimeout(r, 1500));
            await renameDiscordSession(t.terminalId, name, cwd).catch(() => {});
          }
          await new Promise((r) => setTimeout(r, 500));
        }
        // Clean up Discord channels that no longer match any linked session
        const activeIds = useCanvasStore.getState().terminals
          .filter((x) => x.panelType === "claude")
          .map((x) => x.terminalId);
        discordCleanupOrphaned(activeIds).catch(() => {});
      }).catch(() => {});
    }
    // Auto-start OpenWolf daemon if enabled. Prefer the project-intel widget's
    // saved project dir (since only one daemon can run at a time — port 18791).
    // Fall back to any Claude session's cwd.
    if (saved.openwolfEnabled && saved.openwolfDaemon) {
      openwolfProjectCwd()
        .then((widgetCwd) => {
          let cwd = widgetCwd;
          if (!cwd) {
            const claudeSessions = useClaudeStore.getState().sessions;
            cwd = Object.values(claudeSessions).find((s) => s.cwd)?.cwd ?? null;
          }
          if (cwd) openwolfDaemonSwitch(cwd).catch(() => {});
        })
        .catch(() => {});
    }
  }, []);

  // Save ALL state on window close — critical for persistence
  useEffect(() => {
    let unlistenFn: (() => void) | undefined;
    appWindow.onCloseRequested(() => {
      useCanvasStore.getState().saveSession();
      flushClaudeSave();
    }).then((fn) => { unlistenFn = fn; });
    return () => { unlistenFn?.(); };
  }, []);

  useEffect(() => {
    appWindow.isMaximized().then(setIsMaximized);
  }, []);

  // Register commands
  useEffect(() => {
    const themeStore = useThemeStore.getState();

    registerCommand({
      id: "terminal.new",
      label: "New Terminal",
      category: "Terminal",
      execute: () => useCanvasStore.getState().addTerminal(),
    });

    registerCommand({
      id: "commandPalette.toggle",
      label: "Toggle Command Palette",
      category: "UI",
      execute: () => setPaletteOpen((v) => !v),
    });

    registerCommand({
      id: "settings.toggle",
      label: "Toggle Settings",
      category: "UI",
      execute: () => setSettingsOpen((v) => !v),
    });

    registerCommand({
      id: "voice.toggle",
      label: "Toggle Voice Control",
      category: "Voice",
      execute: () => useVoiceStore.getState().toggleEnabled(),
    });

    registerCommand({
      id: "claude.newSession",
      label: "New Codex Session (same folder)",
      category: "Codex",
      execute: () => {
        const canvas = useCanvasStore.getState();
        const active = canvas.terminals.find(t => t.terminalId === canvas.activeTerminalId);
        if (active?.panelType === "claude" && active.cwd) {
          canvas.addClaudeTerminal(active.cwd, false);
        }
      },
    });

    for (const theme of themeStore.themes) {
      registerCommand({
        id: `theme.${theme.name.toLowerCase().replace(/\s+/g, "-")}`,
        label: `Theme: ${theme.name}`,
        category: "Themes",
        execute: () => useThemeStore.getState().setTheme(theme.name),
      });
    }
  }, []);

  // Reactively rename Discord channels when a Claude session's name/cwd changes.
  useEffect(() => {
    const unsub = useClaudeStore.subscribe((state, prev) => {
      for (const [sid, sess] of Object.entries(state.sessions)) {
        const before = prev.sessions[sid];
        if (!before) continue;
        const nameChanged = before.name !== sess.name;
        const cwdChanged = before.cwd !== sess.cwd;
        if ((nameChanged || cwdChanged) && sess.name && sess.name.trim()) {
          renameDiscordSession(sid, sess.name, sess.cwd || "").catch(() => {});
        }
      }
    });
    return unsub;
  }, []);

  // Cleanup closed terminals (only if not popped out)
  useEffect(() => {
    const unsub = useCanvasStore.subscribe((state, prev) => {
      const currentIds = new Set(state.terminals.map((t) => t.terminalId));
      for (const t of prev.terminals) {
        if (!currentIds.has(t.terminalId) && !t.poppedOut) {
          if (t.panelType === "claude") {
            const sess = useClaudeStore.getState().sessions[t.terminalId];
            if (sess?.provider === "openai") {
              closeCodexSession(t.terminalId).catch(() => {});
            } else {
              closeClaudeSession(t.terminalId).catch(() => {});
            }
            unlinkSessionFromDiscord(t.terminalId).catch(() => {});
            // Only remove unnamed/disposable sessions — named ones (e.g. widget chats)
            // stay in memory so they can be reopened with messages intact
            if (!sess?.name) {
              useClaudeStore.getState().removeSession(t.terminalId);
            }
            // Cancel delegation task if this was a child session
            const delStore = useDelegationStore.getState();
            const group = delStore.getGroupForSession(t.terminalId);
            if (group) {
              const task = group.tasks.find((tk) => tk.sessionId === t.terminalId);
              if (task && task.status === "running") {
                delStore.updateTaskStatus(group.id, task.id, "cancelled");
              }
            }
          } else {
            closeTerminal(t.terminalId).catch(() => {});
          }
        }
      }
    });
    return unsub;
  }, []);

  // Voice: when SelectSession intent flips activeSessionId, focus that panel on the canvas
  useEffect(() => {
    const unsub = useVoiceStore.subscribe((state, prev) => {
      if (state.activeSessionId && state.activeSessionId !== prev.activeSessionId) {
        const canvas = useCanvasStore.getState();
        const target = canvas.terminals.find((t) => t.terminalId === state.activeSessionId);
        if (target) canvas.setActive(target.terminalId);
      }
    });
    return unsub;
  }, []);

  // Listen for popped-out terminals coming back
  useEffect(() => {
    let unlistenFn: (() => void) | undefined;
    listen<{ terminalId: string; borderColor?: string }>(
      "terminal-pop-back",
      (event) => {
        const store = useCanvasStore.getState();
        store.popIn(event.payload.terminalId);
        if (event.payload.borderColor) {
          const term = store.terminals.find((t) => t.terminalId === event.payload.terminalId);
          if (term) store.setBorderColor(term.id, event.payload.borderColor);
        }
      }
    ).then((fn) => { unlistenFn = fn; });
    return () => { unlistenFn?.(); };
  }, []);

  const handleMinimize = () => appWindow.minimize();
  const handleMaximize = async () => {
    await appWindow.toggleMaximize();
    setIsMaximized(await appWindow.isMaximized());
  };
  const handleClose = () => appWindow.close();

  return (
    <div className="app">
      {/* Header */}
      <div className="header">
        <div className="header-brand" data-tauri-drag-region>
          <span className="brand-text">&gt;64_</span>
        </div>

        <button
          className="header-action"
          onClick={() => useCanvasStore.getState().addTerminal()}
          title="New Terminal"
        >
          <svg width="12" height="12" viewBox="0 0 12 12">
            <path d="M6 1V11M1 6H11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <span>Terminal</span>
        </button>

        <button
          className="header-action header-action--claude"
          onClick={() => setClaudeDialogOpen(true)}
          title="New Code Session"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M2 9L5 3L8 7L10 4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          <span>Code</span>
        </button>

        <button
          className="header-action header-action--widget"
          onClick={() => setWidgetDialogOpen(true)}
          title="Widgets"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <rect x="1" y="1" width="4" height="4" rx="1" stroke="currentColor" strokeWidth="1.1"/>
            <rect x="7" y="1" width="4" height="4" rx="1" stroke="currentColor" strokeWidth="1.1"/>
            <rect x="1" y="7" width="4" height="4" rx="1" stroke="currentColor" strokeWidth="1.1"/>
            <rect x="7" y="7" width="4" height="4" rx="1" stroke="currentColor" strokeWidth="1.1"/>
          </svg>
          <span>Widget</span>
        </button>

        <button
          className="header-action header-action--skill"
          onClick={() => setSkillDialogOpen(true)}
          title="Skills"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M6 1L10 3.5V8.5L6 11L2 8.5V3.5L6 1Z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round"/>
            <path d="M6 5.5V8M6 4V4.5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/>
          </svg>
          <span>Skills</span>
        </button>

        <div className="header-drag" data-tauri-drag-region />

        {update && (
          <button
            className="header-update"
            onClick={() => window.open(update.url)}
            title={`Update available: v${update.version}`}
          >
            v{update.version}
          </button>
        )}

        <button
          className="header-btn"
          onClick={() => setPaletteOpen(true)}
          title="Quick Pastes (Ctrl+Shift+P)"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M2 3H12M2 7H9M2 11H11" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
          </svg>
        </button>
        <button
          className="header-btn"
          onClick={() => setSettingsOpen(true)}
          title="Settings"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M6.5 1L7 3L6 3.5L4.5 2L3 3.5L4 5L3.5 6L1.5 5.5V7.5L3.5 8L4 9L3 10.5L4.5 12L6 11L7 11.5L6.5 13.5H8.5L9 11.5L10 11L11.5 12L13 10.5L12 9L12.5 8L14.5 7.5V5.5L12.5 6L12 5L13 3.5L11.5 2L10 3L9 2.5L8.5 1H6.5Z" stroke="currentColor" strokeWidth="1" strokeLinejoin="round"/>
            <circle cx="7.5" cy="7.5" r="2" stroke="currentColor" strokeWidth="1"/>
          </svg>
        </button>

        <div className="window-controls">
          <button className="window-btn window-btn--minimize" onClick={handleMinimize} title="Minimize">
            <svg width="10" height="1" viewBox="0 0 10 1"><rect width="10" height="1" fill="currentColor" /></svg>
          </button>
          <button className="window-btn window-btn--maximize" onClick={handleMaximize} title={isMaximized ? "Restore" : "Maximize"}>
            {isMaximized ? (
              <svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 3V9H8V3H2ZM3 0H10V7H9V1H3V0Z" fill="currentColor" /></svg>
            ) : (
              <svg width="10" height="10" viewBox="0 0 10 10"><rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor" fill="none" strokeWidth="1" /></svg>
            )}
          </button>
          <button className="window-btn window-btn--close" onClick={handleClose} title="Close">
            <svg width="10" height="10" viewBox="0 0 10 10"><path d="M1 1L9 9M9 1L1 9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></svg>
          </button>
        </div>
      </div>

      {/* Widget zip drop overlay */}
      {widgetDropOver && (
        <div className="wdg-drop-overlay">
          <div className="wdg-drop-content">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none">
              <rect x="3" y="3" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.5"/>
              <rect x="14" y="3" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.5"/>
              <rect x="3" y="14" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.5"/>
              <rect x="14" y="14" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.5"/>
            </svg>
            <span>Drop to install widget</span>
          </div>
        </div>
      )}

      {/* Canvas */}
      <Canvas />

      {/* Party mode edge glow — fixed overlay on top */}
      <PartyEdgeGlow />

      {/* Overlays */}
      <CommandPalette isOpen={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <SettingsPanel isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <ClaudeDialog
        isOpen={claudeDialogOpen}
        onClose={() => setClaudeDialogOpen(false)}
        onConfirm={(cwd, _skip, sessionName, provider) => {
          useCanvasStore.getState().addClaudeTerminal(cwd, false, sessionName);
          {
            const terminals = useCanvasStore.getState().terminals;
            const newest = terminals[terminals.length - 1];
            if (newest?.panelType === "claude") {
              const sid = newest.terminalId;
              // Pre-create the store session with the dialog's provider choice.
              // ClaudeChat.useEffect's createSession is idempotent, so this
              // primes provider before it ever defaults to "anthropic".
              useClaudeStore.getState().createSession(sid, sessionName, false, undefined, cwd, provider);
              if (sessionName) {
                // Auto-link to Discord (silently fails if bot not running)
                linkSessionToDiscord(sid, sessionName, cwd).catch(() => {});
              }
            }
          }
        }}
        onReopen={(sessionId, dialogCwd) => {
          // Pull the cached name + cwd metadata out of localStorage so we can
          // spawn the panel with the right label + working dir. Messages no
          // longer live here — claudeStore.createSession loads them from JSONL.
          let name: string | undefined;
          let savedCwd = "";
          try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (raw) {
              const d = JSON.parse(raw);
              name = d[sessionId]?.name;
              savedCwd = d[sessionId]?.cwd || "";
            }
          } catch (e) {
            console.warn("[session] Failed to read session metadata from localStorage:", e);
          }
          const effectiveCwd = savedCwd || dialogCwd || ".";
          useCanvasStore.getState().addClaudeTerminal(effectiveCwd, false, name || undefined, sessionId);
          if (name) linkSessionToDiscord(sessionId, name, effectiveCwd).catch(() => {});
        }}
      />
      <WidgetDialog
        isOpen={widgetDialogOpen}
        onClose={() => setWidgetDialogOpen(false)}
      />
      <SkillDialog
        isOpen={skillDialogOpen}
        onClose={() => setSkillDialogOpen(false)}
      />

      {/* Sonner toast notifications */}
      <Toaster
        position="top-right"
        theme="dark"
        richColors
        closeButton
        expand={false}
        toastOptions={{
          style: {
            background: "var(--bg-secondary, #181825)",
            border: "1px solid var(--ft-border, #cba6f7)",
            color: "var(--fg, #cdd6f4)",
            fontFamily: "'Cascadia Code', Consolas, monospace",
            fontSize: "12px",
          },
        }}
      />
    </div>
  );
}

export default App;
