import { create } from "zustand";
import { v4 as uuidv4 } from "uuid";
import type { DelegateTaskStatus, DelegationGroup, DelegationStatus } from "../lib/types";

const STORAGE_KEY = "terminal64-delegations";

interface DelegationState {
  groups: Record<string, DelegationGroup>;
  sessionToGroup: Record<string, string>; // child sessionId → groupId
  parentToGroup: Record<string, string>; // parent sessionId → groupId

  createGroup: (
    parentSessionId: string,
    tasks: { description: string }[],
    mergeStrategy: "auto" | "manual",
    sharedContext?: string,
    parentPermissionMode?: string,
  ) => DelegationGroup;
  setTaskSessionId: (groupId: string, taskId: string, sessionId: string) => void;
  updateTaskStatus: (groupId: string, taskId: string, status: DelegateTaskStatus, result?: string) => void;
  setTaskForwarded: (groupId: string, taskId: string, messageId: string) => void;
  setTaskAction: (groupId: string, taskId: string, action: string) => void;
  setGroupStatus: (groupId: string, status: DelegationStatus) => void;
  removeGroup: (groupId: string) => void;
  getGroupForSession: (sessionId: string) => DelegationGroup | undefined;
  getGroupByParent: (parentSessionId: string) => DelegationGroup | undefined;
  isChildSession: (sessionId: string) => boolean;
  getSiblingSessionIds: (sessionId: string) => string[];
}

function saveToStorage(groups: Record<string, DelegationGroup>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(groups));
  } catch (e) {
    console.warn("[delegation] Failed to save to localStorage:", e);
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function debouncedSave(groups: Record<string, DelegationGroup>) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveToStorage(groups), 1000);
}

function loadFromStorage(): Record<string, DelegationGroup> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) {
    console.warn("[delegation] Failed to load from localStorage:", e);
  }
  return {};
}

// Build reverse index from groups
function buildSessionIndex(groups: Record<string, DelegationGroup>): Record<string, string> {
  const idx: Record<string, string> = {};
  for (const [gid, group] of Object.entries(groups)) {
    for (const task of group.tasks) {
      if (task.sessionId) idx[task.sessionId] = gid;
    }
  }
  return idx;
}

function buildParentIndex(groups: Record<string, DelegationGroup>): Record<string, string> {
  const idx: Record<string, string> = {};
  for (const [gid, group] of Object.entries(groups)) {
    idx[group.parentSessionId] = gid;
  }
  return idx;
}

const initialGroups = loadFromStorage();

export const useDelegationStore = create<DelegationState>((set, get) => ({
  groups: initialGroups,
  sessionToGroup: buildSessionIndex(initialGroups),
  parentToGroup: buildParentIndex(initialGroups),

  createGroup: (parentSessionId, tasks, mergeStrategy, sharedContext, parentPermissionMode) => {
    const group: DelegationGroup = {
      id: uuidv4(),
      parentSessionId,
      tasks: tasks.map((t) => ({
        id: uuidv4(),
        description: t.description,
        sessionId: "",
        status: "pending" as DelegateTaskStatus,
      })),
      mergeStrategy,
      status: "active",
      createdAt: Date.now(),
      sharedContext,
      collaborationEnabled: true,
      parentPermissionMode: (parentPermissionMode as DelegationGroup["parentPermissionMode"]) || "auto",
    };
    set((s) => {
      const groups = { ...s.groups, [group.id]: group };
      const parentToGroup = { ...s.parentToGroup, [parentSessionId]: group.id };
      debouncedSave(groups);
      return { groups, parentToGroup };
    });
    return group;
  },

  setTaskSessionId: (groupId, taskId, sessionId) => {
    set((s) => {
      const group = s.groups[groupId];
      if (!group) return s;
      const tasks = group.tasks.map((t) => (t.id === taskId ? { ...t, sessionId } : t));
      const groups = { ...s.groups, [groupId]: { ...group, tasks } };
      const sessionToGroup = { ...s.sessionToGroup, [sessionId]: groupId };
      debouncedSave(groups);
      return { groups, sessionToGroup };
    });
  },

  updateTaskStatus: (groupId, taskId, status, result) => {
    set((s) => {
      const group = s.groups[groupId];
      if (!group) return s;
      const now = Date.now();
      const tasks = group.tasks.map((t) =>
        t.id === taskId
          ? {
              ...t,
              status,
              ...(result !== undefined ? { result } : {}),
              ...(status === "running" && !t.startedAt ? { startedAt: now } : {}),
              ...(status === "completed" || status === "failed" ? { completedAt: now } : {}),
            }
          : t,
      );
      const groups = { ...s.groups, [groupId]: { ...group, tasks } };
      debouncedSave(groups);
      return { groups };
    });
  },

  setTaskForwarded: (groupId, taskId, messageId) => {
    set((s) => {
      const group = s.groups[groupId];
      if (!group) return s;
      const tasks = group.tasks.map((t) =>
        t.id === taskId ? { ...t, lastForwardedMessageId: messageId } : t,
      );
      const groups = { ...s.groups, [groupId]: { ...group, tasks } };
      debouncedSave(groups);
      return { groups };
    });
  },

  setTaskAction: (groupId, taskId, action) => {
    set((s) => {
      const group = s.groups[groupId];
      if (!group) return s;
      const task = group.tasks.find((t) => t.id === taskId);
      if (task?.lastAction === action) return s;
      const tasks = group.tasks.map((t) =>
        t.id === taskId ? { ...t, lastAction: action, lastActionAt: Date.now() } : t,
      );
      const groups = { ...s.groups, [groupId]: { ...group, tasks } };
      debouncedSave(groups);
      return { groups };
    });
  },

  setGroupStatus: (groupId, status) => {
    set((s) => {
      const group = s.groups[groupId];
      if (!group) return s;
      const groups = { ...s.groups, [groupId]: { ...group, status } };
      debouncedSave(groups);
      return { groups };
    });
  },

  removeGroup: (groupId) => {
    set((s) => {
      const { [groupId]: removed, ...rest } = s.groups;
      if (!removed) return s;
      const sessionToGroup = { ...s.sessionToGroup };
      for (const task of removed.tasks) {
        if (task.sessionId) delete sessionToGroup[task.sessionId];
      }
      const parentToGroup = { ...s.parentToGroup };
      delete parentToGroup[removed.parentSessionId];
      debouncedSave(rest);
      return { groups: rest, sessionToGroup, parentToGroup };
    });
  },

  getGroupForSession: (sessionId) => {
    const { groups, sessionToGroup } = get();
    const gid = sessionToGroup[sessionId];
    return gid ? groups[gid] : undefined;
  },

  getGroupByParent: (parentSessionId) => {
    const { groups, parentToGroup } = get();
    const gid = parentToGroup[parentSessionId];
    if (!gid) return undefined;
    const group = groups[gid];
    return group && group.status !== "cancelled" ? group : undefined;
  },

  isChildSession: (sessionId) => {
    return !!get().sessionToGroup[sessionId];
  },

  getSiblingSessionIds: (sessionId) => {
    const group = get().getGroupForSession(sessionId);
    if (!group) return [];
    return group.tasks
      .filter((t) => t.sessionId && t.sessionId !== sessionId && t.status === "running")
      .map((t) => t.sessionId);
  },
}));
