import { useEffect, useState } from "react";
import { v4 as uuidv4 } from "uuid";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import Canvas from "./components/canvas/Canvas";
import CommandPalette from "./components/command-palette/CommandPalette";
import SettingsPanel from "./components/settings/SettingsPanel";
import PopOutTerminal from "./components/canvas/PopOutTerminal";
import { useTheme } from "./hooks/useTheme";
import { useKeybindings } from "./hooks/useKeybindings";
import { useCanvasStore } from "./stores/canvasStore";
import { useThemeStore } from "./stores/themeStore";
import { useSettingsStore } from "./stores/settingsStore";
import { registerCommand } from "./lib/commands";
import { closeTerminal } from "./lib/tauriApi";
import { checkForUpdate, UpdateInfo } from "./lib/updater";
import "./App.css";

const appWindow = getCurrentWindow();
const isPopOut = new URLSearchParams(window.location.search).has("popout");

function App() {
  if (isPopOut) return <PopOutTerminal />;
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);

  useTheme();
  useKeybindings();

  // Check for updates on startup
  useEffect(() => {
    checkForUpdate().then(setUpdate);
  }, []);

  // Restore saved settings (theme, opacity) on startup
  useEffect(() => {
    const saved = useSettingsStore.getState();
    if (saved.theme) useThemeStore.getState().setTheme(saved.theme);
    if (saved.bgAlpha < 1) useThemeStore.getState().setBgAlpha(saved.bgAlpha);
  }, []);

  // Save session on window close (backup — store also auto-saves every 5s)
  useEffect(() => {
    const unlisten = appWindow.onCloseRequested(() => {
      useCanvasStore.getState().saveSession();
    });
    return () => { unlisten.then((fn) => fn()); };
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

    for (const theme of themeStore.themes) {
      registerCommand({
        id: `theme.${theme.name.toLowerCase().replace(/\s+/g, "-")}`,
        label: `Theme: ${theme.name}`,
        category: "Themes",
        execute: () => useThemeStore.getState().setTheme(theme.name),
      });
    }
  }, []);

  // Cleanup closed terminals (only if not popped out)
  useEffect(() => {
    const unsub = useCanvasStore.subscribe((state, prev) => {
      const currentIds = new Set(state.terminals.map((t) => t.terminalId));
      for (const t of prev.terminals) {
        if (!currentIds.has(t.terminalId) && !t.poppedOut) {
          closeTerminal(t.terminalId).catch(() => {});
        }
      }
    });
    return unsub;
  }, []);

  // Listen for popped-out terminals coming back
  useEffect(() => {
    const unlisten = listen<{ terminalId: string }>(
      "terminal-pop-back",
      (event) => {
        useCanvasStore.getState().popIn(event.payload.terminalId);
      }
    );
    return () => { unlisten.then((fn) => fn()); };
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
          <span className="brand-64">64</span>
        </div>

        <button
          className="header-action"
          onClick={() => useCanvasStore.getState().addTerminal()}
          title="New Terminal"
        >
          <svg width="12" height="12" viewBox="0 0 12 12">
            <path d="M6 1V11M1 6H11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <span>New</span>
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
          <button className="window-btn window-btn--minimize" onClick={handleMinimize}>
            <svg width="10" height="1" viewBox="0 0 10 1"><rect width="10" height="1" fill="currentColor" /></svg>
          </button>
          <button className="window-btn window-btn--maximize" onClick={handleMaximize}>
            {isMaximized ? (
              <svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 3V9H8V3H2ZM3 0H10V7H9V1H3V0Z" fill="currentColor" /></svg>
            ) : (
              <svg width="10" height="10" viewBox="0 0 10 10"><rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor" fill="none" strokeWidth="1" /></svg>
            )}
          </button>
          <button className="window-btn window-btn--close" onClick={handleClose}>
            <svg width="10" height="10" viewBox="0 0 10 10"><path d="M1 1L9 9M9 1L1 9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></svg>
          </button>
        </div>
      </div>

      {/* Canvas */}
      <Canvas />

      {/* Overlays */}
      <CommandPalette isOpen={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <SettingsPanel isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}

export default App;
