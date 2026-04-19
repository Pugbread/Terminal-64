import type { ThemeDefinition, UiTheme } from "./types";

export function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function applyUiTheme(ui: UiTheme, alpha: number = 1) {
  const root = document.documentElement;
  const a = (hex: string) => (alpha < 1 ? hexToRgba(hex, alpha) : hex);

  // Backgrounds get alpha applied
  root.style.setProperty("--bg", a(ui.bg));
  root.style.setProperty("--bg-secondary", a(ui.bgSecondary));
  root.style.setProperty("--bg-tertiary", a(ui.bgTertiary));
  root.style.setProperty("--tab-active-bg", a(ui.tabActiveBg));
  root.style.setProperty("--tab-inactive-bg", a(ui.tabInactiveBg));
  root.style.setProperty("--tab-hover-bg", a(ui.tabHoverBg));

  // Text/borders/accents stay fully opaque
  root.style.setProperty("--fg", ui.fg);
  root.style.setProperty("--fg-secondary", ui.fgSecondary);
  root.style.setProperty("--fg-muted", ui.fgMuted);
  root.style.setProperty("--border", ui.border);
  root.style.setProperty("--accent", ui.accent);
  root.style.setProperty("--accent-hover", ui.accentHover);
  root.style.setProperty("--tab-active-fg", ui.tabActiveFg);
  root.style.setProperty("--tab-inactive-fg", ui.tabInactiveFg);
  root.style.setProperty("--scrollbar", ui.scrollbar);
  root.style.setProperty("--scrollbar-hover", ui.scrollbarHover);
}

export function applyTheme(theme: ThemeDefinition, alpha: number = 1) {
  applyUiTheme(theme.ui, alpha);
}
