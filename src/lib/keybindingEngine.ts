import { KeyCombo, Keybinding } from "./types";

export function parseKeyCombo(str: string): KeyCombo {
  const parts = str.toLowerCase().split("+").map((s) => s.trim());
  const combo: KeyCombo = { key: "" };

  for (const part of parts) {
    switch (part) {
      case "ctrl":
      case "control":
        combo.ctrl = true;
        break;
      case "shift":
        combo.shift = true;
        break;
      case "alt":
        combo.alt = true;
        break;
      case "meta":
      case "cmd":
      case "win":
        combo.meta = true;
        break;
      default:
        combo.key = part;
    }
  }

  return combo;
}

export function matchesKeyCombo(
  event: KeyboardEvent,
  combo: KeyCombo
): boolean {
  const key = event.key.toLowerCase();
  const comboKey = combo.key.toLowerCase();
  const isMac = navigator.platform.includes("Mac");

  if (key !== comboKey) return false;
  // On Mac, treat Cmd as Ctrl for keybinding matching
  const ctrlPressed = isMac ? (event.metaKey || event.ctrlKey) : event.ctrlKey;
  if (!!combo.ctrl !== ctrlPressed) return false;
  if (!!combo.shift !== event.shiftKey) return false;
  if (!!combo.alt !== event.altKey) return false;
  if (!isMac && !!combo.meta !== event.metaKey) return false;

  return true;
}

export function formatKeyCombo(combo: KeyCombo): string {
  const parts: string[] = [];
  if (combo.ctrl) parts.push("Ctrl");
  if (combo.shift) parts.push("Shift");
  if (combo.alt) parts.push("Alt");
  if (combo.meta) parts.push("Meta");
  parts.push(combo.key.length === 1 ? combo.key.toUpperCase() : combo.key);
  return parts.join("+");
}

export function findMatchingBinding(
  event: KeyboardEvent,
  bindings: Keybinding[]
): Keybinding | undefined {
  return bindings.find((b) => matchesKeyCombo(event, b.combo));
}

export const DEFAULT_KEYBINDINGS: Keybinding[] = [
  {
    combo: { key: "t", ctrl: true, shift: true },
    command: "terminal.newTab",
  },
  {
    combo: { key: "w", ctrl: true, shift: true },
    command: "terminal.closeTab",
  },
  {
    combo: { key: "d", ctrl: true, shift: true },
    command: "terminal.splitRight",
  },
  {
    combo: { key: "e", ctrl: true, shift: true },
    command: "terminal.splitDown",
  },
  {
    combo: { key: "p", ctrl: true, shift: true },
    command: "commandPalette.toggle",
  },
  {
    combo: { key: "Tab", ctrl: true },
    command: "terminal.nextTab",
  },
  {
    combo: { key: "Tab", ctrl: true, shift: true },
    command: "terminal.prevTab",
  },
  {
    combo: { key: "=", ctrl: true },
    command: "terminal.zoomIn",
  },
  {
    combo: { key: "-", ctrl: true },
    command: "terminal.zoomOut",
  },
  {
    combo: { key: "0", ctrl: true },
    command: "terminal.zoomReset",
  },
  {
    combo: { key: "g", ctrl: true, shift: true },
    command: "terminal.createGrid",
  },
  {
    combo: { key: "n" },
    command: "claude.newSession",
  },
];
