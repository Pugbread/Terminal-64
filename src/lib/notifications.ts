// Simple in-app toast notification system

export interface Toast {
  id: string;
  title: string;
  body?: string;
  ts: number;
}

type Listener = (toasts: Toast[]) => void;

let toasts: Toast[] = [];
const listeners = new Set<Listener>();

function emit() {
  for (const fn of listeners) fn(toasts);
}

const MAX_TOASTS = 5;

export function pushToast(title: string, body?: string) {
  const id = Math.random().toString(36).slice(2);
  const toast: Toast = { id, title, body, ts: Date.now() };
  toasts = [...toasts, toast];
  // Cap at MAX_TOASTS — remove oldest
  while (toasts.length > MAX_TOASTS) {
    toasts = toasts.slice(1);
  }
  emit();
  // Auto-dismiss after 4s
  setTimeout(() => dismissToast(id), 4000);
}

export function dismissToast(id: string) {
  const prev = toasts;
  toasts = toasts.filter((t) => t.id !== id);
  if (toasts !== prev) emit();
}

export function subscribeToasts(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
