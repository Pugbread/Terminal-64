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

function loadSavedTheme(): { themeName: string; theme: ThemeDefinition; bgAlpha: number } {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      const theme = builtInThemes.find((t) => t.name === saved.themeName);
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
}

const initial = loadSavedTheme();

export const useThemeStore = create<ThemeState>((set, get) => ({
  themes: builtInThemes,
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
}));
