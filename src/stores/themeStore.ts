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

interface ThemeState {
  themes: ThemeDefinition[];
  currentThemeName: string;
  currentTheme: ThemeDefinition;
  bgAlpha: number; // 0-1, background transparency
  setTheme: (name: string) => void;
  setBgAlpha: (alpha: number) => void;
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  themes: builtInThemes,
  currentThemeName: "Catppuccin Mocha",
  currentTheme: catppuccinMocha as ThemeDefinition,
  bgAlpha: 1,
  setTheme: (name: string) => {
    const theme = get().themes.find((t) => t.name === name);
    if (theme) {
      set({ currentThemeName: name, currentTheme: theme });
    }
  },
  setBgAlpha: (alpha: number) => {
    set({ bgAlpha: Math.max(0, Math.min(1, alpha)) });
  },
}));
