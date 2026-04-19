import { useEffect } from "react";
import type { Keybinding } from "../lib/types";
import { findMatchingBinding, DEFAULT_KEYBINDINGS } from "../lib/keybindingEngine";
import { executeCommand } from "../lib/commands";

export function useKeybindings(extraBindings?: Keybinding[]) {
  useEffect(() => {
    const bindings = [...DEFAULT_KEYBINDINGS, ...(extraBindings ?? [])];

    function handler(event: KeyboardEvent) {
      const match = findMatchingBinding(event, bindings);
      if (match) {
        const hasModifier = match.combo.ctrl || match.combo.shift || match.combo.alt || match.combo.meta;
        if (!hasModifier) {
          const el = document.activeElement;
          if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || (el as HTMLElement)?.isContentEditable) {
            return;
          }
        }
        event.preventDefault();
        event.stopPropagation();
        executeCommand(match.command, match.args);
      }
    }

    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [extraBindings]);
}
