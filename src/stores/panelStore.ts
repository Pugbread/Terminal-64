import { create } from "zustand";

export interface PanelSizes {
  left: number;
  center: number;
  right: number;
}

interface PanelState {
  sizes: PanelSizes;
  leftOpen: boolean;
  rightOpen: boolean;
  setSizes: (sizes: number[]) => void;
  setLeftOpen: (open: boolean) => void;
  setRightOpen: (open: boolean) => void;
}

const STORAGE_KEY = "terminal64-panel-layout";

const defaults = {
  sizes: { left: 22, center: 56, right: 22 } as PanelSizes,
  leftOpen: true,
  rightOpen: false,
};

function load(): { sizes: PanelSizes; leftOpen: boolean; rightOpen: boolean } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<typeof defaults>;
      return { ...defaults, ...parsed, sizes: { ...defaults.sizes, ...(parsed.sizes ?? {}) } };
    }
  } catch (e) {
    console.warn("[panelStore] load failed:", e);
  }
  return defaults;
}

function persist(state: { sizes: PanelSizes; leftOpen: boolean; rightOpen: boolean }) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.warn("[panelStore] persist failed:", e);
  }
}

export const usePanelStore = create<PanelState>((set, get) => ({
  ...load(),

  setSizes: (sizes) => {
    const [left, center, right] = sizes;
    if (left == null || center == null || right == null) return;
    const next: PanelSizes = { left, center, right };
    set({ sizes: next });
    persist({ sizes: next, leftOpen: get().leftOpen, rightOpen: get().rightOpen });
  },

  setLeftOpen: (leftOpen) => {
    set({ leftOpen });
    persist({ sizes: get().sizes, leftOpen, rightOpen: get().rightOpen });
  },

  setRightOpen: (rightOpen) => {
    set({ rightOpen });
    persist({ sizes: get().sizes, leftOpen: get().leftOpen, rightOpen });
  },
}));
