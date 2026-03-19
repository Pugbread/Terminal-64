import { create } from "zustand";
import { v4 as uuidv4 } from "uuid";
import {
  DEFAULT_BORDER_COLOR,
  DEFAULT_TERMINAL_WIDTH,
  DEFAULT_TERMINAL_HEIGHT,
  MIN_TERMINAL_WIDTH,
  MIN_TERMINAL_HEIGHT,
  AUTO_SAVE_INTERVAL_MS,
} from "../lib/constants";

export interface CanvasTerminal {
  id: string;
  terminalId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
  title: string;
  borderColor: string;
  poppedOut: boolean;
  cwd: string;
  claudeSessionId: string;
  isClaudeSession: boolean;
  claudeSkipPermissions: boolean;
}

interface CanvasState {
  terminals: CanvasTerminal[];
  panX: number;
  panY: number;
  zoom: number;
  nextZ: number;
  activeTerminalId: string | null;

  addTerminal: (x?: number, y?: number) => void;
  addClaudeTerminal: (cwd: string, skipPermissions: boolean) => void;
  setClaudeSessionId: (id: string, sessionId: string) => void;
  removeTerminal: (id: string) => void;
  moveTerminal: (id: string, x: number, y: number) => void;
  resizeTerminal: (id: string, width: number, height: number) => void;
  bringToFront: (id: string) => void;
  setTitle: (id: string, title: string) => void;
  setCwd: (id: string, cwd: string) => void;
  setBorderColor: (id: string, color: string) => void;
  popOut: (id: string) => void;
  popIn: (terminalId: string) => void;
  setActive: (id: string) => void;
  pan: (dx: number, dy: number) => void;
  setZoom: (zoom: number) => void;
  getAllTerminalIds: () => string[];
  saveSession: () => void;
  loadSession: () => boolean;
}

// Shared deserialization for session data
interface SerializedTerminal {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  title?: string;
  borderColor?: string;
  cwd?: string;
}

function deserializeTerminals(items: SerializedTerminal[]): CanvasTerminal[] {
  return items.map((t, i) => ({
    id: uuidv4(),
    terminalId: uuidv4(),
    x: t.x ?? 60,
    y: t.y ?? 60,
    width: t.width ?? DEFAULT_TERMINAL_WIDTH,
    height: t.height ?? DEFAULT_TERMINAL_HEIGHT,
    zIndex: i + 1,
    title: t.title ?? "Terminal",
    borderColor: t.borderColor ?? DEFAULT_BORDER_COLOR,
    poppedOut: false,
    cwd: t.cwd ?? "",
    claudeSessionId: (t as any).claudeSessionId ?? "",
    isClaudeSession: (t as any).isClaudeSession ?? false,
    claudeSkipPermissions: (t as any).claudeSkipPermissions ?? false,
  }));
}

function makeTerminal(zIndex: number, overrides: Partial<CanvasTerminal> = {}): CanvasTerminal {
  return {
    id: uuidv4(),
    terminalId: uuidv4(),
    x: 60,
    y: 60,
    width: DEFAULT_TERMINAL_WIDTH,
    height: DEFAULT_TERMINAL_HEIGHT,
    zIndex,
    title: "Terminal",
    borderColor: DEFAULT_BORDER_COLOR,
    poppedOut: false,
    cwd: "",
    claudeSessionId: "",
    isClaudeSession: false,
    claudeSkipPermissions: false,
    ...overrides,
  };
}

function createDefaultTerminal(): CanvasTerminal {
  return {
    id: uuidv4(),
    terminalId: uuidv4(),
    x: 60,
    y: 60,
    width: DEFAULT_TERMINAL_WIDTH,
    height: DEFAULT_TERMINAL_HEIGHT,
    zIndex: 1,
    title: "Terminal",
    borderColor: DEFAULT_BORDER_COLOR,
    poppedOut: false,
    cwd: "",
    claudeSessionId: "",
    isClaudeSession: false,
    claudeSkipPermissions: false,
  };
}

// Load saved session at init time (before any components mount)
function getInitialState() {
  try {
    const raw = localStorage.getItem("terminal64-session");
    if (raw) {
      const session = JSON.parse(raw);
      if (session.terminals?.length) {
        const terminals = deserializeTerminals(session.terminals);
        return {
          terminals,
          panX: session.panX ?? 0,
          panY: session.panY ?? 0,
          zoom: session.zoom ?? 1,
          nextZ: terminals.length + 1,
          activeTerminalId: terminals[0]?.terminalId ?? null,
        };
      }
    }
  } catch {}

  const def = createDefaultTerminal();
  return {
    terminals: [def],
    panX: 0,
    panY: 0,
    zoom: 1,
    nextZ: 2,
    activeTerminalId: def.terminalId,
  };
}

let dirty = false;

export const useCanvasStore = create<CanvasState>((set, get) => {
  const initial = getInitialState();

  // Auto-save only when dirty
  setInterval(() => {
    if (dirty) {
      try {
        useCanvasStore.getState().saveSession();
        dirty = false;
      } catch {}
    }
  }, AUTO_SAVE_INTERVAL_MS);

  const markDirty = () => { dirty = true; };

  return {
    ...initial,

    addTerminal: (x?: number, y?: number) => {
      const state = get();
      const count = state.terminals.length;
      const newTerm = makeTerminal(state.nextZ, {
        x: x ?? 80 + (count % 5) * 30,
        y: y ?? 80 + (count % 5) * 30,
      });
      set({
        terminals: [...state.terminals, newTerm],
        nextZ: state.nextZ + 1,
        activeTerminalId: newTerm.terminalId,
      });
      markDirty();
    },

    addClaudeTerminal: (cwd: string, skipPermissions: boolean) => {
      const state = get();
      const count = state.terminals.length;
      const newTerm = makeTerminal(state.nextZ, {
        x: 80 + (count % 5) * 30,
        y: 80 + (count % 5) * 30,
        title: "Claude",
        borderColor: "#cba6f7",
        cwd,
        isClaudeSession: true,
        claudeSkipPermissions: skipPermissions,
      });
      set({
        terminals: [...state.terminals, newTerm],
        nextZ: state.nextZ + 1,
        activeTerminalId: newTerm.terminalId,
      });
      markDirty();
    },

    setClaudeSessionId: (id: string, sessionId: string) => {
      set((s) => ({
        terminals: s.terminals.map((t) =>
          t.id === id ? { ...t, claudeSessionId: sessionId } : t
        ),
      }));
      markDirty();
    },

    removeTerminal: (id: string) => {
      set((s) => {
        const removed = s.terminals.find((t) => t.id === id);
        const newTerminals = s.terminals.filter((t) => t.id !== id);
        return {
          terminals: newTerminals,
          activeTerminalId:
            removed?.terminalId === s.activeTerminalId
              ? newTerminals[newTerminals.length - 1]?.terminalId ?? null
              : s.activeTerminalId,
        };
      });
      markDirty();
    },

    moveTerminal: (id: string, x: number, y: number) => {
      set((s) => ({
        terminals: s.terminals.map((t) =>
          t.id === id ? { ...t, x, y } : t
        ),
      }));
      markDirty();
    },

    resizeTerminal: (id: string, width: number, height: number) => {
      set((s) => ({
        terminals: s.terminals.map((t) =>
          t.id === id
            ? {
                ...t,
                width: Math.max(MIN_TERMINAL_WIDTH, width),
                height: Math.max(MIN_TERMINAL_HEIGHT, height),
              }
            : t
        ),
      }));
      markDirty();
    },

    bringToFront: (id: string) => {
      const state = get();
      const term = state.terminals.find((t) => t.id === id);
      if (!term || term.zIndex === state.nextZ - 1) return; // Already on top
      set({
        terminals: state.terminals.map((t) =>
          t.id === id ? { ...t, zIndex: state.nextZ } : t
        ),
        nextZ: state.nextZ + 1,
        activeTerminalId: term.terminalId,
      });
    },

    setTitle: (id: string, title: string) => {
      set((s) => ({
        terminals: s.terminals.map((t) =>
          t.id === id ? { ...t, title } : t
        ),
      }));
    },

    setCwd: (id: string, cwd: string) => {
      const current = get().terminals.find((t) => t.id === id);
      if (current?.cwd === cwd) return; // No-op if unchanged
      set((s) => ({
        terminals: s.terminals.map((t) =>
          t.id === id ? { ...t, cwd } : t
        ),
      }));
      markDirty();
    },

    setBorderColor: (id: string, color: string) => {
      set((s) => ({
        terminals: s.terminals.map((t) =>
          t.id === id ? { ...t, borderColor: color } : t
        ),
      }));
      markDirty();
    },

    popOut: (id: string) => {
      set((s) => ({
        terminals: s.terminals.map((t) =>
          t.id === id ? { ...t, poppedOut: true } : t
        ),
      }));
    },

    popIn: (terminalId: string) => {
      set((s) => ({
        terminals: s.terminals.map((t) =>
          t.terminalId === terminalId ? { ...t, poppedOut: false } : t
        ),
      }));
    },

    setActive: (id: string) => {
      set({ activeTerminalId: id });
    },

    pan: (dx: number, dy: number) => {
      set((s) => ({ panX: s.panX + dx, panY: s.panY + dy }));
    },

    setZoom: (zoom: number) => {
      set({ zoom: Math.max(0.3, Math.min(2, zoom)) });
    },

    getAllTerminalIds: () => {
      return get().terminals.map((t) => t.terminalId);
    },

    saveSession: () => {
      const s = get();
      const session = {
        terminals: s.terminals
          .filter((t) => !t.poppedOut)
          .map((t) => ({
            x: t.x,
            y: t.y,
            width: t.width,
            height: t.height,
            title: t.title,
            borderColor: t.borderColor,
            cwd: t.cwd,
            claudeSessionId: t.claudeSessionId,
            isClaudeSession: t.isClaudeSession,
            claudeSkipPermissions: t.claudeSkipPermissions,
          })),
        panX: s.panX,
        panY: s.panY,
        zoom: s.zoom,
      };
      try {
        localStorage.setItem("terminal64-session", JSON.stringify(session));
      } catch {}
    },

    loadSession: () => {
      try {
        const raw = localStorage.getItem("terminal64-session");
        if (!raw) return false;
        const session = JSON.parse(raw);
        if (!session.terminals?.length) return false;
        const terminals = deserializeTerminals(session.terminals);
        set({
          terminals,
          panX: session.panX ?? 0,
          panY: session.panY ?? 0,
          zoom: session.zoom ?? 1,
          nextZ: terminals.length + 1,
          activeTerminalId: terminals[0]?.terminalId ?? null,
        });
        return true;
      } catch {
        return false;
      }
    },
  };
});
