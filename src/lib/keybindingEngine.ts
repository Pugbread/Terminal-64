import type { KeyCombo, Keybinding } from "./types";
import { IS_MAC } from "./platform";

function matchesKeyCombo(
  event: KeyboardEvent,
  combo: KeyCombo
): boolean {
  const key = event.key.toLowerCase();
  const comboKey = combo.key.toLowerCase();

  if (key !== comboKey) return false;
  // On Mac, treat Cmd as Ctrl for keybinding matching
  const ctrlPressed = IS_MAC ? (event.metaKey || event.ctrlKey) : event.ctrlKey;
  if (!!combo.ctrl !== ctrlPressed) return false;
  if (!!combo.shift !== event.shiftKey) return false;
  if (!!combo.alt !== event.altKey) return false;
  if (!IS_MAC && !!combo.meta !== event.metaKey) return false;

  return true;
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
  {
    combo: { key: "v", ctrl: true, shift: true },
    command: "voice.toggle",
  },
  {
    combo: { key: ",", ctrl: true },
    command: "settings.toggle",
  },
];
