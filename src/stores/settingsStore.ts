import { create } from "zustand";
import { v4 as uuidv4 } from "uuid";

export interface QuickPaste {
  id: string;
  command: string;
  lastUsed: number;
}

export interface Settings {
  claudeModel: string;
  claudeEffort: string;
  claudePermMode: string;
  claudeFont: string;
  theme: string;
  bgAlpha: number;
  snapToGrid: boolean;
  quickPastes: QuickPaste[];
  recentDirs: string[];
  discordBotToken: string;
  discordServerId: string;
}

const STORAGE_KEY = "terminal64-settings";

const defaultSettings: Settings = {
  claudeModel: "sonnet",
  claudeEffort: "high",
  claudePermMode: "",
  claudeFont: "system",
  theme: "Catppuccin Mocha",
  bgAlpha: 1,
  snapToGrid: false,
  quickPastes: [],
  recentDirs: [],
  discordBotToken: "",
  discordServerId: "",
};

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...defaultSettings, ...JSON.parse(raw) };
  } catch {}
  return defaultSettings;
}

function persist(state: Settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {}
}

interface SettingsState extends Settings {
  set: (partial: Partial<Settings>) => void;
  save: () => void;
  addQuickPaste: (command: string) => void;
  removeQuickPaste: (id: string) => void;
  touchQuickPaste: (id: string) => void;
  addRecentDir: (dir: string) => void;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  ...loadSettings(),

  set: (partial) => {
    set(partial);
    persist({ ...get(), ...partial });
  },

  save: () => persist(get()),

  addQuickPaste: (command) => {
    const qp: QuickPaste = { id: uuidv4(), command, lastUsed: 0 };
    const updated = [...get().quickPastes, qp];
    set({ quickPastes: updated });
    persist({ ...get(), quickPastes: updated });
  },

  removeQuickPaste: (id) => {
    const updated = get().quickPastes.filter((q) => q.id !== id);
    set({ quickPastes: updated });
    persist({ ...get(), quickPastes: updated });
  },

  touchQuickPaste: (id) => {
    const updated = get().quickPastes.map((q) =>
      q.id === id ? { ...q, lastUsed: Date.now() } : q
    );
    set({ quickPastes: updated });
    persist({ ...get(), quickPastes: updated });
  },

  addRecentDir: (dir) => {
    const current = get().recentDirs.filter((d) => d !== dir);
    const updated = [dir, ...current].slice(0, 3);
    set({ recentDirs: updated });
    persist({ ...get(), recentDirs: updated });
  },
}));
