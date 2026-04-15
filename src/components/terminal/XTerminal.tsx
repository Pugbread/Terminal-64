import { useEffect, useRef, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import {
  createTerminal,
  writeTerminal,
  resizeTerminal,
  onTerminalOutput,
  onTerminalExit,
} from "../../lib/tauriApi";
import { useThemeStore } from "../../stores/themeStore";
import { hexToRgba } from "../../lib/themeEngine";
import "@xterm/xterm/css/xterm.css";
import "./XTerminal.css";

// Global WebGL context tracker — browsers limit to ~8-16 concurrent contexts.
// When the limit is approached, new terminals fall back to canvas rendering
// instead of silently failing.
const MAX_WEBGL_CONTEXTS = 10;
let activeWebglCount = 0;
function releaseWebgl() { activeWebglCount = Math.max(0, activeWebglCount - 1); }

interface XTerminalProps {
  terminalId: string;
  isActive?: boolean;
  cwd?: string;
  autoCommand?: string; // run this command after shell starts
  onExit?: (id: string) => void;
  onFocus?: (id: string) => void;
  onTitleChange?: (id: string, title: string) => void;
  onActivity?: (id: string) => void;
  onCwdChange?: (id: string, cwd: string) => void;
}

export default function XTerminal({
  terminalId,
  isActive,
  onExit,
  cwd,
  autoCommand,
  onFocus,
  onTitleChange,
  onActivity,
  onCwdChange,
}: XTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const initializedRef = useRef(false);
  const lastSizeRef = useRef({ cols: 0, rows: 0 });
  const webglRef = useRef<WebglAddon | null>(null);
  const theme = useThemeStore((s) => s.currentTheme);
  const bgAlpha = useThemeStore((s) => s.bgAlpha);

  const focus = useCallback(() => {
    termRef.current?.focus();
    onFocus?.(terminalId);
  }, [terminalId, onFocus]);

  // Apply theme + alpha changes to xterm
  useEffect(() => {
    if (!termRef.current || !theme) return;
    const term = termRef.current;
    const container = containerRef.current;

    // Dispose WebGL when transparent (it can't render alpha)
    if (bgAlpha < 1 && webglRef.current) {
      webglRef.current.dispose();
      webglRef.current = null;
      releaseWebgl();
    }

    if (bgAlpha < 1) {
      // Make xterm canvas fully transparent — container provides the real bg
      term.options.theme = { ...theme.terminal, background: "#00000000" };
      if (container) {
        container.style.backgroundColor = hexToRgba(
          theme.terminal.background,
          bgAlpha
        );
      }
    } else {
      // Fully opaque — normal rendering
      term.options.theme = theme.terminal;
      if (container) {
        container.style.backgroundColor = "";
      }
    }

    term.refresh(0, term.rows - 1);

    // Re-enable WebGL when fully opaque (if under context limit)
    if (bgAlpha >= 1 && !webglRef.current && activeWebglCount < MAX_WEBGL_CONTEXTS) {
      try {
        const addon = new WebglAddon();
        addon.onContextLoss(() => { addon.dispose(); webglRef.current = null; releaseWebgl(); });
        term.loadAddon(addon);
        webglRef.current = addon;
        activeWebglCount++;
      } catch (e) {
        console.warn("[xterm] WebGL addon failed:", e);
      }
    }
  }, [theme, bgAlpha]);

  useEffect(() => {
    if (isActive && termRef.current) {
      termRef.current.focus();
    }
  }, [isActive]);

  useEffect(() => {
    if (!containerRef.current || initializedRef.current) return;
    initializedRef.current = true;

    // Use current alpha for initial theme so new splits are transparent
    const currentAlpha = useThemeStore.getState().bgAlpha;
    const baseTheme = theme?.terminal ?? {
      background: "#1e1e2e",
      foreground: "#cdd6f4",
      cursor: "#f5e0dc",
      selectionBackground: "#585b70",
      black: "#45475a",
      red: "#f38ba8",
      green: "#a6e3a1",
      yellow: "#f9e2af",
      blue: "#89b4fa",
      magenta: "#f5c2e7",
      cyan: "#94e2d5",
      white: "#bac2de",
      brightBlack: "#585b70",
      brightRed: "#f38ba8",
      brightGreen: "#a6e3a1",
      brightYellow: "#f9e2af",
      brightBlue: "#89b4fa",
      brightMagenta: "#f5c2e7",
      brightCyan: "#94e2d5",
      brightWhite: "#a6adc8",
    };
    const initialTheme =
      currentAlpha < 1
        ? { ...baseTheme, background: "#00000000" }
        : baseTheme;

    if (currentAlpha < 1 && containerRef.current) {
      containerRef.current.style.backgroundColor = hexToRgba(
        baseTheme.background,
        currentAlpha
      );
    }

    const term = new Terminal({
      cursorBlink: false,
      cursorStyle: "underline",
      cursorWidth: 1,
      cursorInactiveStyle: "none",
      fontSize: 14,
      fontFamily: "'Cascadia Code', 'Fira Code', Consolas, monospace",
      fontWeight: "400",
      letterSpacing: 0,
      lineHeight: 1.2,
      theme: initialTheme,
      allowProposedApi: true,
      scrollback: 10000,
      rightClickSelectsWord: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);

    // Only use WebGL when fully opaque and under context limit
    if (currentAlpha >= 1 && activeWebglCount < MAX_WEBGL_CONTEXTS) {
      try {
        const addon = new WebglAddon();
        addon.onContextLoss(() => { addon.dispose(); webglRef.current = null; releaseWebgl(); });
        term.loadAddon(addon);
        webglRef.current = addon;
        activeWebglCount++;
      } catch (e) {
        console.warn("[xterm] WebGL addon failed:", e);
      }
    }

    fitAddon.fit();
    lastSizeRef.current = { cols: term.cols, rows: term.rows };
    termRef.current = term;
    fitAddonRef.current = fitAddon;

    term.onData((data) => {
      writeTerminal(terminalId, data).catch(() => {});
    });

    term.onBinary((data) => {
      writeTerminal(terminalId, data).catch(() => {});
    });

    term.onTitleChange((title) => {
      onTitleChange?.(terminalId, title);
    });

    // Kill xterm's native paste on its hidden textarea.
    // stopImmediatePropagation prevents xterm's own paste listener from firing.
    const xtermTA = containerRef.current.querySelector(
      "textarea.xterm-helper-textarea"
    ) as HTMLTextAreaElement | null;
    const killPaste = (e: Event) => {
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    xtermTA?.addEventListener("paste", killPaste, true);

    const isMac = navigator.platform.includes("Mac");
    const mod = (e: KeyboardEvent) => (isMac ? e.metaKey : e.ctrlKey);

    term.attachCustomKeyEventHandler((event) => {
      // Ctrl/Cmd+Shift combos → bubble up for app keybindings
      if (mod(event) && event.shiftKey) return false;
      // Ctrl/Cmd+Tab → bubble up
      if (mod(event) && event.key === "Tab") return false;

      if (event.type !== "keydown") return true;

      // Ctrl/Cmd+V: paste from clipboard
      if (mod(event) && event.key === "v") {
        navigator.clipboard.readText().then((text) => {
          if (text) writeTerminal(terminalId, text).catch(() => {});
        });
        return false;
      }

      // Ctrl/Cmd+C: copy selection OR send interrupt
      if (mod(event) && event.key === "c") {
        if (term.hasSelection()) {
          navigator.clipboard.writeText(term.getSelection());
          term.clearSelection();
          return false;
        }
        return true;
      }

      // Ctrl/Cmd+A: select all
      if (mod(event) && event.key === "a") {
        term.selectAll();
        return false;
      }

      // Ctrl+Backspace (Windows) / Option+Backspace (Mac): delete word
      if (
        (event.ctrlKey && event.key === "Backspace") ||
        (isMac && event.altKey && event.key === "Backspace")
      ) {
        writeTerminal(
          terminalId,
          isMac ? "\x17" : "\x08" // Mac shells use \x17 (Ctrl+W), Windows ConPTY uses \x08
        ).catch(() => {});
        return false;
      }

      return true;
    });

    let unlistenOutput: (() => void) | null = null;
    let unlistenExit: (() => void) | null = null;
    let disposed = false;

    (async () => {
      unlistenOutput = await onTerminalOutput((payload) => {
        if (payload.id === terminalId) {
          term.write(payload.data);
          onActivity?.(terminalId);
          const psMatch = payload.data.match(/PS ([A-Z]:\\[^>]*?)>/);
          if (psMatch) onCwdChange?.(terminalId, psMatch[1]);
          const oscMatch = payload.data.match(/\x1b\]7;file:\/\/[^/]*\/(.*?)(?:\x07|\x1b\\)/);
          if (oscMatch) onCwdChange?.(terminalId, decodeURIComponent(oscMatch[1]));
        }
      });

      unlistenExit = await onTerminalExit((payload) => {
        if (payload.id === terminalId) {
          term.write("\r\n\x1b[38;5;242m[Process exited]\x1b[0m\r\n");
          onExit?.(terminalId);
        }
      });

      if (disposed) return;

      try {
        const cols = term.cols;
        const rows = term.rows;
        lastSizeRef.current = { cols, rows };
        await createTerminal({ id: terminalId, cols, rows, cwd: cwd || undefined });
        await resizeTerminal(terminalId, cols, rows);
        // Auto-run command after shell starts (e.g. launching claude)
        if (autoCommand) {
          setTimeout(() => {
            writeTerminal(terminalId, autoCommand + "\r").catch(() => {});
          }, 2000);
        }
      } catch (err) {
        term.write(`\r\n\x1b[31mFailed to start shell: ${err}\x1b[0m\r\n`);
      }
    })();

    let resizeTimeout: ReturnType<typeof setTimeout>;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect || rect.width === 0 || rect.height === 0) return;

      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        if (!fitAddonRef.current || !termRef.current) return;
        const proposed = fitAddonRef.current.proposeDimensions();
        if (
          !proposed ||
          (proposed.cols === lastSizeRef.current.cols &&
            proposed.rows === lastSizeRef.current.rows)
        ) {
          return;
        }
        fitAddonRef.current.fit();
        const cols = termRef.current.cols;
        const rows = termRef.current.rows;
        if (cols < 1 || rows < 1) return;
        lastSizeRef.current = { cols, rows };
        resizeTerminal(terminalId, cols, rows).catch(() => {});
      }, 50);
    });
    observer.observe(containerRef.current);

    const focusTimer = setTimeout(() => { if (!disposed) term.focus(); }, 50);

    return () => {
      disposed = true;
      clearTimeout(focusTimer);
      initializedRef.current = false;
      // Disconnect observer BEFORE clearing refs to prevent race condition
      observer.disconnect();
      clearTimeout(resizeTimeout);
      unlistenOutput?.();
      unlistenExit?.();
      xtermTA?.removeEventListener("paste", killPaste, true);
      if (webglRef.current) {
        webglRef.current.dispose();
        webglRef.current = null;
        releaseWebgl();
      }
      term.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
    };
  }, [terminalId]);

  return (
    <div
      ref={containerRef}
      className={`xterminal ${isActive ? "xterminal--active" : ""}`}
      onMouseDown={focus}
    />
  );
}
