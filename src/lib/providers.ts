// Provider-aware constants for the topbar dropdowns + session creation.
//
// Each provider has its own models / effort / permission-mode taxonomy.
// The UI reads from PROVIDER_CONFIG[selectedProvider] so adding/removing
// options for one provider doesn't ripple into the other.

import type { PermissionMode } from "./types";

export type ProviderId = "anthropic" | "openai";

export interface ModelOption {
  id: string;
  label: string;
}
export interface EffortOption {
  id: string;
  label: string;
}
// Note: PermissionMode is the Claude-shaped union ("default" | "plan" | …);
// for Codex we use string ids that are translated at the IPC boundary.
export interface PermissionOption {
  id: string;
  label: string;
  color: string;
  desc: string;
}

interface ProviderConfig {
  label: string;
  models: ModelOption[];
  efforts: EffortOption[];
  permissions: PermissionOption[];
  defaultModel: string;
  defaultEffort: string;
  defaultPermission: string;
}

const ANTHROPIC_MODELS: ModelOption[] = [
  { id: "sonnet", label: "Sonnet" },
  { id: "opus", label: "Opus" },
  { id: "haiku", label: "Haiku" },
  { id: "opusplan", label: "Opus Plan" },
  { id: "claude-opus-4-7", label: "Opus 4.7" },
  { id: "sonnet[1m]", label: "Sonnet 1M" },
  { id: "opus[1m]", label: "Opus 1M" },
  { id: "claude-opus-4-7[1m]", label: "Opus 4.7 1M" },
];

const ANTHROPIC_EFFORTS: EffortOption[] = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Med" },
  { id: "high", label: "High" },
  { id: "max", label: "Max" },
  { id: "xhigh", label: "X-High" },
];

const ANTHROPIC_PERMISSIONS: PermissionOption[] = [
  { id: "default", label: "Default", color: "#89b4fa", desc: "Ask before every tool" },
  { id: "plan", label: "Plan", color: "#94e2d5", desc: "Read-only, no edits" },
  { id: "auto", label: "Auto", color: "#a6e3a1", desc: "Auto-approve safe ops" },
  { id: "accept_edits", label: "Edits", color: "#cba6f7", desc: "Auto-approve all edits" },
  { id: "bypass_all", label: "YOLO", color: "#f38ba8", desc: "Skip ALL permissions" },
];

// Models accepted by `codex exec` with a ChatGPT (Plus/Pro) account, verified
// 2026-04-25 against codex-cli-exec 0.121.0. The API-key path may allow more
// (o3 / o4-mini / gpt-5-codex / etc) but ChatGPT auth is whitelist-only —
// anything outside this set 400s with "model is not supported when using
// Codex with a ChatGPT account". Users on API keys can override via
// `~/.codex/config.toml`.
const OPENAI_MODELS: ModelOption[] = [
  { id: "gpt-5.5", label: "GPT-5.5" },
  { id: "gpt-5.4", label: "GPT-5.4" },
  { id: "gpt-5.4-mini", label: "GPT-5.4 Mini" },
  { id: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
  { id: "gpt-5.2", label: "GPT-5.2" },
];

// Canonical Codex `reasoning_effort` enum, matching upstream's
// `ClientRequest__ReasoningEffort` and t3code's `REASONING_EFFORT_LABELS`.
// Some combinations are server-rejected (e.g. `minimal` 400s if the model's
// auto-enabled web_search tool is on, with: "The following tools cannot be
// used with reasoning.effort 'minimal'") — surfaced as a runtime error
// rather than hidden from the picker. `none` is omitted; it's plan-mode
// territory and not useful from a chat composer.
const OPENAI_EFFORTS: EffortOption[] = [
  { id: "minimal", label: "Minimal" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra High" },
];

// Codex's permission surface is two enums: `--sandbox` (the filesystem
// sandbox) and `-c approval_policy=…` (when to ask the human). We collapse
// the common pairs into preset "modes" the user picks, then expand them at
// the IPC boundary inside ClaudeChat → createCodexSession.
//
// id matches the preset name; sandbox/policy/full_auto/yolo are encoded in
// `decodeCodexPermission()` below.
const OPENAI_PERMISSIONS: PermissionOption[] = [
  { id: "read-only", label: "Read", color: "#89b4fa", desc: "No filesystem writes" },
  { id: "workspace", label: "Workspace", color: "#94e2d5", desc: "Write inside cwd, ask first" },
  { id: "full-auto", label: "Auto", color: "#a6e3a1", desc: "Workspace + auto-approve all" },
  { id: "yolo", label: "YOLO", color: "#f38ba8", desc: "No sandbox, no approvals" },
];

export const PROVIDER_CONFIG: Record<ProviderId, ProviderConfig> = {
  anthropic: {
    label: "Anthropic",
    models: ANTHROPIC_MODELS,
    efforts: ANTHROPIC_EFFORTS,
    permissions: ANTHROPIC_PERMISSIONS,
    defaultModel: "sonnet",
    defaultEffort: "high",
    defaultPermission: "default",
  },
  openai: {
    label: "OpenAI",
    models: OPENAI_MODELS,
    efforts: OPENAI_EFFORTS,
    permissions: OPENAI_PERMISSIONS,
    defaultModel: "gpt-5.5",
    defaultEffort: "medium",
    defaultPermission: "workspace",
  },
};

export function isCodexPermissionId(id: string): boolean {
  return PROVIDER_CONFIG.openai.permissions.some((p) => p.id === id);
}
export function isClaudePermissionId(id: string): id is PermissionMode {
  return PROVIDER_CONFIG.anthropic.permissions.some((p) => p.id === id);
}

/**
 * Translate a Codex preset id into the four wire fields our backend expects:
 *   sandbox_mode | approval_policy | full_auto | yolo
 *
 * Mapping:
 *   "read-only"    → sandbox=read-only,        policy=on-request
 *   "workspace"    → sandbox=workspace-write,  policy=on-request
 *   "full-auto"    → full_auto=true (CLI implies workspace-write + never-ask)
 *   "yolo"         → yolo=true     (CLI bypasses sandbox AND approvals)
 */
export function decodeCodexPermission(id: string): {
  sandbox_mode?: string;
  approval_policy?: string;
  full_auto?: boolean;
  yolo?: boolean;
} {
  switch (id) {
    case "read-only":
      return { sandbox_mode: "read-only", approval_policy: "on-request" };
    case "workspace":
      return { sandbox_mode: "workspace-write", approval_policy: "on-request" };
    case "full-auto":
      return { full_auto: true };
    case "yolo":
      return { yolo: true };
    default:
      return { sandbox_mode: "workspace-write", approval_policy: "on-request" };
  }
}
