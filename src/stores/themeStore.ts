import { create } from "zustand";
import { ThemeDefinition } from "../lib/types";

import catppuccinMocha from "../themes/catppuccin-mocha.json";
import dracula from "../themes/dracula.json";
import monokai from "../themes/monokai.json";
import defaultDark from "../themes/default-dark.json";
import tokyoNight from "../themes/tokyo-night.json";
import black from "../themes/black.json";
import dark from "../themes/dark.json";
import discord from "../themes/discord.json";

const builtInThemes: ThemeDefinition[] = [
  discord as ThemeDefinition,
  dark as ThemeDefinition,
  black as ThemeDefinition,
  catppuccinMocha as ThemeDefinition,
  dracula as ThemeDefinition,
  monokai as ThemeDefinition,
  defaultDark as ThemeDefinition,
  tokyoNight as ThemeDefinition,
];

const THEME_STORAGE_KEY = "terminal64-theme";
const CUSTOM_THEMES_KEY = "terminal64-custom-themes";

function loadCustomThemes(): ThemeDefinition[] {
  try {
    const raw = localStorage.getItem(CUSTOM_THEMES_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return [];
}

function persistCustomThemes(themes: ThemeDefinition[]) {
  try {
    localStorage.setItem(CUSTOM_THEMES_KEY, JSON.stringify(themes));
  } catch {}
}

const customThemes = loadCustomThemes();

function loadSavedTheme(): { themeName: string; theme: ThemeDefinition; bgAlpha: number } {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      const all = [...builtInThemes, ...customThemes];
      const theme = all.find((t) => t.name === saved.themeName);
      if (theme) {
        return { themeName: saved.themeName, theme, bgAlpha: saved.bgAlpha ?? 1 };
      }
    }
  } catch {}
  return { themeName: "Catppuccin Mocha", theme: catppuccinMocha as ThemeDefinition, bgAlpha: 1 };
}

function persistTheme(themeName: string, bgAlpha: number) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify({ themeName, bgAlpha }));
  } catch {}
}

interface ThemeState {
  themes: ThemeDefinition[];
  currentThemeName: string;
  currentTheme: ThemeDefinition;
  bgAlpha: number; // 0-1, background transparency
  setTheme: (name: string) => void;
  setBgAlpha: (alpha: number) => void;
  addTheme: (theme: ThemeDefinition) => void;
  removeTheme: (name: string) => void;
}

const initial = loadSavedTheme();

export const useThemeStore = create<ThemeState>((set, get) => ({
  themes: [...builtInThemes, ...customThemes],
  currentThemeName: initial.themeName,
  currentTheme: initial.theme,
  bgAlpha: initial.bgAlpha,
  setTheme: (name: string) => {
    const theme = get().themes.find((t) => t.name === name);
    if (theme) {
      set({ currentThemeName: name, currentTheme: theme });
      persistTheme(name, get().bgAlpha);
    }
  },
  setBgAlpha: (alpha: number) => {
    const clamped = Math.max(0, Math.min(1, alpha));
    set({ bgAlpha: clamped });
    persistTheme(get().currentThemeName, clamped);
  },
  addTheme: (theme: ThemeDefinition) => {
    const existing = get().themes;
    // Replace if same name exists, otherwise append
    const idx = existing.findIndex((t) => t.name === theme.name);
    const updated = idx >= 0
      ? existing.map((t, i) => i === idx ? theme : t)
      : [...existing, theme];
    set({ themes: updated });
    // Persist only custom themes (non-builtin)
    const customs = updated.filter((t) => !builtInThemes.some((b) => b.name === t.name));
    persistCustomThemes(customs);
  },
  removeTheme: (name: string) => {
    if (builtInThemes.some((t) => t.name === name)) return;
    const updated = get().themes.filter((t) => t.name !== name);
    set({ themes: updated });
    persistCustomThemes(updated.filter((t) => !builtInThemes.some((b) => b.name === t.name)));
    if (get().currentThemeName === name) {
      get().setTheme("Catppuccin Mocha");
    }
  },
}));
