import { create } from "zustand";
import { v4 as uuidv4 } from "uuid";
import type { ChatMessage, ToolCall, McpTool, HookEvent, PermissionMode, LuauDiagnostic } from "../lib/types";
import {
  normalizeProviderToolCall,
  normalizeProviderToolPatch,
} from "../contracts/providerEvents";
import {
  coerceProviderControlValue,
  getProviderControl,
  getProviderDefaultControlValues,
  getProviderDefaultPermission,
  getProviderHistoryPolicy,
  getProviderInputPermissionControl,
  getProviderLegacyControl,
  isProviderPermissionValue,
  isProviderControlValue,
  isProviderId,
  listProviderControls,
  providerPersistsLocalTranscript,
  type ProviderControlValue,
  type ProviderHistorySource,
  type ProviderControlId,
  type ProviderId,
} from "../lib/providers";
import type {
  ProviderHydrateInput,
  ProviderSessionRuntimeMetadata,
  ProviderSessionRuntimeMetadataMap,
  ProviderSessionRuntimeMetadataPatch,
} from "../contracts/providerRuntime";
import { stripSystemReminderBlocks } from "../lib/promptSanitization";

// Keep the persisted key stable for existing installs; the exported
// provider-neutral name is the preferred surface for new callers.
export const PROVIDER_SESSIONS_STORAGE_KEY = "terminal64-claude-sessions";
/** @deprecated Use PROVIDER_SESSIONS_STORAGE_KEY. */
export const STORAGE_KEY = PROVIDER_SESSIONS_STORAGE_KEY;
export const PROVIDER_SESSION_META_ROW_PREFIX = `${PROVIDER_SESSIONS_STORAGE_KEY}:row:`;
export const PROVIDER_SESSION_META_INDEX_KEY = `${PROVIDER_SESSIONS_STORAGE_KEY}:index`;
const STALE_UNNAMED_META_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_PERSISTED_META_ENTRIES = 160;
const MAX_LOCAL_TRANSCRIPT_MESSAGES = 500;
const MAX_COMPACT_LOCAL_TRANSCRIPT_MESSAGES = 80;

export interface OpenAiProviderSessionMetadata {
  codexThreadId: string | null;
}

export type ProviderPermissionMap = Partial<Record<ProviderId, string | null>>;
export type ProviderControlValueMap = Record<ProviderControlId, ProviderControlValue>;
export type ProviderSelectedControlsMap = Partial<Record<ProviderId, ProviderControlValueMap>>;

export interface ProviderSessionMetadataRegistry {
  anthropic: Record<string, never>;
  openai: OpenAiProviderSessionMetadata;
}

export type ProviderSessionMetadataFor<P extends ProviderId> = P extends keyof ProviderSessionMetadataRegistry
  ? ProviderSessionMetadataRegistry[P]
  : Record<string, unknown>;

export type ProviderSessionMetadataMap = Partial<{
  [P in ProviderId]: ProviderSessionMetadataFor<P>;
}>;

export interface ProviderSessionState {
  provider: ProviderId;
  providerLocked: boolean;
  selectedControls: ProviderSelectedControlsMap;
  selectedModel: string | null;
  selectedEffort: string | null;
  seedTranscript: ChatMessage[] | null;
  runtimeMetadata: ProviderSessionRuntimeMetadataMap;
  providerMetadata: ProviderSessionMetadataMap;
  providerPermissions: ProviderPermissionMap;
}

interface ProviderCompatibilityFields {
  provider: ProviderId;
  providerLocked: boolean;
  providerPermissions: ProviderPermissionMap;
  selectedControls: ProviderSelectedControlsMap;
  runtimeMetadata: ProviderSessionRuntimeMetadataMap;
  codexThreadId: string | null;
  seedTranscript: ChatMessage[] | null;
  selectedModel: string | null;
  selectedEffort: string | null;
}

type ProviderStateSource = {
  providerState?: ProviderSessionState | undefined;
  provider?: ProviderId | undefined;
  providerLocked?: boolean | undefined;
  runtimeMetadata?: ProviderSessionRuntimeMetadataMap | undefined;
  providerMetadata?: ProviderSessionMetadataMap | undefined;
  providerPermissions?: ProviderPermissionMap | undefined;
  selectedControls?: ProviderSelectedControlsMap | undefined;
  codexThreadId?: string | null | undefined;
  seedTranscript?: ChatMessage[] | null | undefined;
  selectedModel?: string | null | undefined;
  selectedEffort?: string | null | undefined;
  selectedCodexPermission?: string | null | undefined;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isProviderHistorySource(value: unknown): value is ProviderHistorySource {
  return value === "claude-jsonl"
    || value === "codex-rollout"
    || value === "local-transcript"
    || value === "none";
}

function providerResumeMetadataFromUnknown(value: unknown): { id: string | null } {
  if (typeof value === "string") return { id: value };
  if (!isRecord(value)) return { id: null };
  return {
    id: typeof value.id === "string" || value.id === null ? value.id : null,
  };
}

function createProviderRuntimeMetadata(
  provider: ProviderId,
  patch?: ProviderSessionRuntimeMetadataPatch | ProviderSessionRuntimeMetadata | undefined,
): ProviderSessionRuntimeMetadata {
  const source = isProviderHistorySource(patch?.historySource)
    ? patch.historySource
    : getProviderHistoryPolicy(provider).source;
  const runtimePayload = isRecord(patch?.runtimePayload) ? { ...patch.runtimePayload } : {};
  const resume = patch?.resume === null ? { id: null } : providerResumeMetadataFromUnknown(patch?.resume);
  return {
    historySource: source,
    resume,
    runtimePayload,
  };
}

function providerRuntimeMetadataFromUnknown(value: unknown): ProviderSessionRuntimeMetadataMap {
  if (!isRecord(value)) return {};
  const metadata: ProviderSessionRuntimeMetadataMap = {};
  for (const provider of Object.keys(value)) {
    if (!isProviderId(provider)) continue;
    const raw = value[provider];
    if (!isRecord(raw)) continue;
    const historySource = isProviderHistorySource(raw.historySource) ? raw.historySource : undefined;
    const resume = typeof raw.resume === "string" || isRecord(raw.resume)
      ? providerResumeMetadataFromUnknown(raw.resume)
      : raw.resume === null
        ? null
        : undefined;
    const runtimePayload = isRecord(raw.runtimePayload) ? raw.runtimePayload : undefined;
    metadata[provider] = createProviderRuntimeMetadata(provider, {
      historySource,
      resume,
      runtimePayload,
    });
  }
  return metadata;
}

function mergeRuntimeMetadata(
  base: ProviderSessionRuntimeMetadataMap,
  patch: ProviderSessionRuntimeMetadataMap | undefined,
): ProviderSessionRuntimeMetadataMap {
  if (!patch) return base;
  const merged: ProviderSessionRuntimeMetadataMap = { ...base };
  for (const provider of Object.keys(patch)) {
    if (!isProviderId(provider)) continue;
    const current = merged[provider];
    const next = createProviderRuntimeMetadata(provider, {
      historySource: patch[provider]?.historySource ?? current?.historySource,
      resume: patch[provider]?.resume ?? current?.resume ?? null,
      runtimePayload: {
        ...(current?.runtimePayload ?? {}),
        ...(patch[provider]?.runtimePayload ?? {}),
      },
    });
    merged[provider] = next;
  }
  return merged;
}

function runtimeResumeId(metadata: ProviderSessionRuntimeMetadata | undefined): string | null {
  return metadata?.resume.id ?? null;
}

function runtimeStringPayload(
  metadata: ProviderSessionRuntimeMetadata | undefined,
  key: string,
): string | null | undefined {
  const value = metadata?.runtimePayload[key];
  return typeof value === "string" || value === null ? value : undefined;
}

function openAiCodexThreadIdFromRuntime(
  metadata: ProviderSessionRuntimeMetadata | undefined,
): string | null | undefined {
  return runtimeStringPayload(metadata, "codexThreadId") ?? runtimeResumeId(metadata) ?? undefined;
}

function runtimeMetadataWithResume(
  provider: ProviderId,
  existing: ProviderSessionRuntimeMetadata | undefined,
  resumeId: string | null,
  runtimePayload?: Record<string, unknown>,
): ProviderSessionRuntimeMetadata {
  return createProviderRuntimeMetadata(provider, {
    historySource: existing?.historySource,
    resume: { id: resumeId },
    runtimePayload: {
      ...(existing?.runtimePayload ?? {}),
      ...(runtimePayload ?? {}),
    },
  });
}

function openAiMetadataFromUnknown(
  value: unknown,
  fallback?: Partial<OpenAiProviderSessionMetadata>,
): OpenAiProviderSessionMetadata {
  const record = isRecord(value) ? value : {};
  const codexThreadId = typeof record.codexThreadId === "string" || record.codexThreadId === null
    ? record.codexThreadId
    : fallback?.codexThreadId ?? null;
  return { codexThreadId };
}

function legacyOpenAiPermissionFromUnknown(value: unknown): string | null | undefined {
  if (!isRecord(value)) return undefined;
  return typeof value.selectedCodexPermission === "string" || value.selectedCodexPermission === null
    ? value.selectedCodexPermission
    : undefined;
}

function providerMetadataFromUnknown(value: unknown): ProviderSessionMetadataMap {
  if (!isRecord(value)) return {};
  const metadata = { ...value } as ProviderSessionMetadataMap;
  if (isRecord(value.openai)) {
    metadata.openai = openAiMetadataFromUnknown(value.openai);
  }
  return metadata;
}

function isPermissionIdForProvider(provider: ProviderId, value: unknown): value is string {
  return isProviderPermissionValue(provider, value);
}

function providerPermissionsFromUnknown(value: unknown): ProviderPermissionMap {
  if (!isRecord(value)) return {};
  const permissions: ProviderPermissionMap = {};
  for (const provider of Object.keys(value)) {
    if (!isProviderId(provider)) continue;
    const permissionId = value[provider];
    if (permissionId === null || isPermissionIdForProvider(provider, permissionId)) {
      permissions[provider] = permissionId;
    }
  }
  return permissions;
}

function providerSelectedControlsFromUnknown(value: unknown): ProviderSelectedControlsMap {
  if (!isRecord(value)) return {};
  const selectedControls: ProviderSelectedControlsMap = {};
  for (const providerKey of Object.keys(value)) {
    if (!isProviderId(providerKey)) continue;
    const rawControls = value[providerKey];
    if (!isRecord(rawControls)) continue;
    const controls: ProviderControlValueMap = {};
    for (const [controlId, controlValue] of Object.entries(rawControls)) {
      if (!getProviderControl(providerKey, controlId)) continue;
      if (controlValue === null || isProviderControlValue(providerKey, controlId, controlValue)) {
        controls[controlId] = controlValue;
      }
    }
    if (Object.keys(controls).length > 0) {
      selectedControls[providerKey] = controls;
    }
  }
  return selectedControls;
}

function mergeSelectedControls(
  base: ProviderSelectedControlsMap,
  patch: ProviderSelectedControlsMap | undefined,
): ProviderSelectedControlsMap {
  if (!patch) return base;
  const merged: ProviderSelectedControlsMap = { ...base };
  for (const provider of Object.keys(patch)) {
    if (!isProviderId(provider)) continue;
    merged[provider] = {
      ...(merged[provider] ?? {}),
      ...(patch[provider] ?? {}),
    };
  }
  return merged;
}

function setSelectedControlValue(
  selectedControls: ProviderSelectedControlsMap,
  provider: ProviderId,
  controlId: ProviderControlId,
  value: ProviderControlValue,
): ProviderSelectedControlsMap {
  return {
    ...selectedControls,
    [provider]: {
      ...(selectedControls[provider] ?? {}),
      [controlId]: value,
    },
  };
}

function seedSelectedControlValue(
  selectedControls: ProviderSelectedControlsMap,
  provider: ProviderId,
  controlId: ProviderControlId | undefined,
  value: ProviderControlValue | undefined,
): ProviderSelectedControlsMap {
  if (!controlId || value === undefined) return selectedControls;
  const existing = selectedControls[provider]?.[controlId];
  if (existing !== undefined) return selectedControls;
  if (value === null || isProviderControlValue(provider, controlId, value)) {
    return setSelectedControlValue(selectedControls, provider, controlId, value);
  }
  return selectedControls;
}

function seedLegacySelectedControlValue(
  selectedControls: ProviderSelectedControlsMap,
  provider: ProviderId,
  legacySlot: "model" | "effort",
  value: string | null | undefined,
): ProviderSelectedControlsMap {
  const legacyControl = getProviderLegacyControl(provider, legacySlot);
  let next = seedSelectedControlValue(selectedControls, provider, legacyControl?.id, value);
  if (legacyControl || value === undefined) return next;
  const alias = listProviderControls(provider).find((control) => control.migrationAliases?.includes(legacySlot));
  next = seedSelectedControlValue(next, provider, alias?.id, value);
  return next;
}

function defaultSelectedControlsForProvider(provider: ProviderId): ProviderSelectedControlsMap {
  return { [provider]: getProviderDefaultControlValues(provider) };
}

function syncPermissionControls(
  selectedControls: ProviderSelectedControlsMap,
  permissions: ProviderPermissionMap,
): ProviderSelectedControlsMap {
  let next = selectedControls;
  for (const providerKey of Object.keys(permissions)) {
    if (!isProviderId(providerKey)) continue;
    const permissionId = permissions[providerKey];
    const control = getProviderInputPermissionControl(providerKey);
    if (!control) continue;
    if (permissionId === null || isProviderControlValue(providerKey, control.id, permissionId)) {
      next = setSelectedControlValue(next, providerKey, control.id, permissionId);
    }
  }
  return next;
}

export function getProviderSelectedControlValue(
  providerState: ProviderSessionState | null | undefined,
  provider: ProviderId,
  controlId: ProviderControlId,
): ProviderControlValue {
  const candidate = providerState?.selectedControls[provider]?.[controlId];
  return coerceProviderControlValue(provider, controlId, candidate);
}

export function getProviderSelectedControlValues(
  providerState: ProviderSessionState | null | undefined,
  provider: ProviderId,
): ProviderControlValueMap {
  const values: ProviderControlValueMap = {};
  for (const control of listProviderControls(provider)) {
    values[control.id] = getProviderSelectedControlValue(providerState, provider, control.id);
  }
  return values;
}

function getLegacySelectedControlValue(
  selectedControls: ProviderSelectedControlsMap,
  provider: ProviderId,
  legacySlot: "model" | "effort",
): string | null {
  const control = getProviderLegacyControl(provider, legacySlot);
  if (!control) return null;
  const candidate = selectedControls[provider]?.[control.id];
  return typeof candidate === "string" && isProviderControlValue(provider, control.id, candidate) ? candidate : null;
}

function legacyOpenAiFieldsFromProviderState(
  value: unknown,
): { codexThreadId: string | null; selectedCodexPermission?: string | null | undefined } | null {
  if (!isRecord(value)) return null;
  if (isRecord(value.providerMetadata) && isRecord(value.providerMetadata.openai)) {
    const openai = value.providerMetadata.openai;
    const permission = legacyOpenAiPermissionFromUnknown(openai);
    return {
      ...openAiMetadataFromUnknown(openai),
      ...(permission !== undefined ? { selectedCodexPermission: permission } : {}),
    };
  }
  if (isRecord(value.openai)) {
    const permission = legacyOpenAiPermissionFromUnknown(value.openai);
    return {
      ...openAiMetadataFromUnknown(value.openai),
      ...(permission !== undefined ? { selectedCodexPermission: permission } : {}),
    };
  }
  return null;
}

function createProviderState({
  provider,
  providerLocked,
  selectedModel,
  selectedEffort,
  seedTranscript,
  runtimeMetadata,
  providerMetadata,
  providerPermissions,
  selectedControls,
  codexThreadId,
  selectedCodexPermission,
}: {
  provider: ProviderId;
  providerLocked?: boolean | undefined;
  selectedModel?: string | null | undefined;
  selectedEffort?: string | null | undefined;
  seedTranscript?: ChatMessage[] | null | undefined;
  runtimeMetadata?: ProviderSessionRuntimeMetadataMap | undefined;
  providerMetadata?: ProviderSessionMetadataMap | undefined;
  providerPermissions?: ProviderPermissionMap | undefined;
  selectedControls?: ProviderSelectedControlsMap | undefined;
  codexThreadId?: string | null | undefined;
  selectedCodexPermission?: string | null | undefined;
}): ProviderSessionState {
  const runtime = providerRuntimeMetadataFromUnknown(runtimeMetadata);
  const metadata = providerMetadataFromUnknown(providerMetadata);
  const permissions = providerPermissionsFromUnknown(providerPermissions);
  let controls = providerSelectedControlsFromUnknown(selectedControls);
  const existingOpenAi = openAiMetadataFromUnknown(metadata.openai);
  const runtimeOpenAiThreadId = openAiCodexThreadIdFromRuntime(runtime.openai);
  const shouldStoreOpenAiRuntimeMetadata =
    provider === "openai"
    || runtime.openai !== undefined
    || metadata.openai !== undefined
    || codexThreadId !== undefined;
  const openAiThreadId = codexThreadId !== undefined
    ? codexThreadId
    : runtimeOpenAiThreadId ?? existingOpenAi.codexThreadId;
  const migratedOpenAiPermission = selectedCodexPermission !== undefined
    ? selectedCodexPermission
    : legacyOpenAiPermissionFromUnknown(
      isRecord(providerMetadata) ? providerMetadata.openai : undefined,
    );
  if (
    permissions.openai === undefined
    && (migratedOpenAiPermission === null || isPermissionIdForProvider("openai", migratedOpenAiPermission))
  ) {
    permissions.openai = migratedOpenAiPermission;
  }
  if (shouldStoreOpenAiRuntimeMetadata) {
    runtime.openai = runtimeMetadataWithResume(
      "openai",
      runtime.openai,
      openAiThreadId,
      { codexThreadId: openAiThreadId },
    );
    metadata.openai = { codexThreadId: openAiThreadId };
  }
  if (provider === "cursor" || runtime.cursor !== undefined) {
    const cursorResumeId = runtimeStringPayload(runtime.cursor, "cursorChatId")
      ?? runtimeResumeId(runtime.cursor)
      ?? null;
    runtime.cursor = runtimeMetadataWithResume(
      "cursor",
      runtime.cursor,
      cursorResumeId,
      { cursorChatId: cursorResumeId },
    );
  }
  controls = seedLegacySelectedControlValue(controls, provider, "model", selectedModel);
  controls = seedLegacySelectedControlValue(controls, provider, "effort", selectedEffort);
  controls = syncPermissionControls(controls, permissions);

  return {
    provider,
    providerLocked: providerLocked ?? false,
    selectedControls: controls,
    selectedModel: getLegacySelectedControlValue(controls, provider, "model"),
    selectedEffort: getLegacySelectedControlValue(controls, provider, "effort"),
    seedTranscript: seedTranscript ?? null,
    runtimeMetadata: runtime,
    providerMetadata: metadata,
    providerPermissions: permissions,
  };
}

export function resolveSessionProviderState(session: ProviderStateSource | null | undefined): ProviderSessionState {
  if (session?.providerState) {
    const legacyOpenAiFields = legacyOpenAiFieldsFromProviderState(session.providerState);
    return createProviderState({
      provider: session.providerState.provider,
      providerLocked: session.providerState.providerLocked ?? session.providerLocked ?? false,
      selectedModel: session.providerState.selectedModel,
      selectedEffort: session.providerState.selectedEffort,
      seedTranscript: session.providerState.seedTranscript,
      runtimeMetadata: session.providerState.runtimeMetadata,
      providerMetadata: session.providerState.providerMetadata,
      providerPermissions: session.providerState.providerPermissions,
      selectedControls: session.providerState.selectedControls,
      ...(legacyOpenAiFields ? legacyOpenAiFields : {}),
    });
  }
  return createProviderState({
    provider: session?.provider ?? "anthropic",
    providerLocked: session?.providerLocked ?? false,
    selectedModel: session?.selectedModel ?? null,
    selectedEffort: session?.selectedEffort ?? null,
    seedTranscript: session?.seedTranscript ?? null,
    runtimeMetadata: session?.runtimeMetadata,
    providerMetadata: session?.providerMetadata,
    providerPermissions: session?.providerPermissions,
    selectedControls: session?.selectedControls,
    codexThreadId: session?.codexThreadId,
    selectedCodexPermission: session?.selectedCodexPermission ?? null,
  });
}

export function getProviderSessionMetadata<P extends ProviderId>(
  providerState: ProviderSessionState | null | undefined,
  provider: P,
): ProviderSessionMetadataFor<P> | undefined {
  if (provider === "openai") {
    return getOpenAiProviderSessionMetadata(providerState) as ProviderSessionMetadataFor<P> | undefined;
  }
  return providerState?.providerMetadata[provider] as ProviderSessionMetadataFor<P> | undefined;
}

export function getProviderSessionRuntimeMetadata(
  providerState: ProviderSessionState | null | undefined,
  provider: ProviderId,
): ProviderSessionRuntimeMetadata | undefined {
  return providerState?.runtimeMetadata[provider];
}

export function resolveProviderSessionRuntimeMetadata(
  session: ProviderStateSource | null | undefined,
  provider: ProviderId,
): ProviderSessionRuntimeMetadata | undefined {
  return getProviderSessionRuntimeMetadata(resolveSessionProviderState(session), provider);
}

export function getProviderRuntimeResumeId(
  providerState: ProviderSessionState | null | undefined,
  provider: ProviderId,
): string | null {
  return runtimeResumeId(getProviderSessionRuntimeMetadata(providerState, provider));
}

export function resolveProviderRuntimeResumeId(
  session: ProviderStateSource | null | undefined,
  provider?: ProviderId,
): string | null {
  const providerState = resolveSessionProviderState(session);
  return getProviderRuntimeResumeId(providerState, provider ?? providerState.provider);
}

export function resolveProviderSessionMetadata<P extends ProviderId>(
  session: ProviderStateSource | null | undefined,
  provider: P,
): ProviderSessionMetadataFor<P> | undefined {
  return getProviderSessionMetadata(resolveSessionProviderState(session), provider);
}

export function getOpenAiProviderSessionMetadata(
  providerState: ProviderSessionState | null | undefined,
): OpenAiProviderSessionMetadata | undefined {
  const runtime = providerState?.runtimeMetadata.openai;
  const legacy = providerState?.providerMetadata.openai;
  const codexThreadId = openAiCodexThreadIdFromRuntime(runtime) ?? legacy?.codexThreadId ?? null;
  if (!runtime && !legacy) return undefined;
  return { codexThreadId };
}

export function resolveOpenAiProviderSessionMetadata(
  session: ProviderStateSource | null | undefined,
): OpenAiProviderSessionMetadata | undefined {
  return resolveProviderSessionMetadata(session, "openai");
}

export function getProviderPermissionId(
  providerState: ProviderSessionState | null | undefined,
  provider: ProviderId,
): string {
  const candidate = providerState?.providerPermissions[provider];
  if (isPermissionIdForProvider(provider, candidate)) return candidate;
  return getProviderDefaultPermission(provider);
}

export function resolveProviderPermissionId(
  session: ProviderStateSource | null | undefined,
  provider?: ProviderId,
): string {
  const providerState = resolveSessionProviderState(session);
  return getProviderPermissionId(providerState, provider ?? providerState.provider);
}

function providerCompatibilityFields(providerState: ProviderSessionState): ProviderCompatibilityFields {
  const openaiMetadata = providerState.provider === "openai"
    ? getOpenAiProviderSessionMetadata(providerState)
    : undefined;
  return {
    provider: providerState.provider,
    providerLocked: providerState.providerLocked,
    providerPermissions: providerState.providerPermissions,
    selectedControls: providerState.selectedControls,
    runtimeMetadata: providerState.runtimeMetadata,
    codexThreadId: openaiMetadata?.codexThreadId ?? null,
    seedTranscript: providerState.seedTranscript,
    selectedModel: providerState.selectedModel,
    selectedEffort: providerState.selectedEffort,
  };
}

function hasOwn<K extends PropertyKey>(value: object, key: K): value is Record<K, unknown> {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function normalizeProviderState(
  base: ProviderSessionState,
  patch: Partial<ProviderCompatibilityFields> & {
    providerState?: ProviderSessionState;
    runtimeMetadata?: ProviderSessionRuntimeMetadataMap;
    providerPermissions?: ProviderPermissionMap;
    selectedControls?: ProviderSelectedControlsMap;
  },
): ProviderSessionState {
  const source = patch.providerState ?? base;
  const provider = hasOwn(patch, "provider") ? (patch.provider as ProviderId) : source.provider;
  const providerLocked = hasOwn(patch, "providerLocked")
    ? (patch.providerLocked as boolean)
    : source.providerLocked ?? false;
  const selectedModel = hasOwn(patch, "selectedModel")
    ? (patch.selectedModel as string | null)
    : source.selectedModel;
  const selectedEffort = hasOwn(patch, "selectedEffort")
    ? (patch.selectedEffort as string | null)
    : source.selectedEffort;
  const seedTranscript = hasOwn(patch, "seedTranscript")
    ? (patch.seedTranscript as ChatMessage[] | null)
    : source.seedTranscript;
  const sourceRuntimeMetadata = source.runtimeMetadata ?? {};
  const patchRuntimeMetadata = hasOwn(patch, "runtimeMetadata")
    ? providerRuntimeMetadataFromUnknown(patch.runtimeMetadata)
    : undefined;
  const runtimeMetadata = mergeRuntimeMetadata(sourceRuntimeMetadata, patchRuntimeMetadata);
  const sourceMetadata = source.providerMetadata ?? {};
  const patchMetadata = hasOwn(patch, "providerMetadata")
    ? (patch.providerMetadata as ProviderSessionMetadataMap | undefined)
    : undefined;
  const providerMetadata = patchMetadata ? { ...sourceMetadata, ...patchMetadata } : sourceMetadata;
  const sourcePermissions = source.providerPermissions ?? {};
  const patchPermissions = hasOwn(patch, "providerPermissions")
    ? (patch.providerPermissions as ProviderPermissionMap | undefined)
    : undefined;
  const providerPermissions = patchPermissions
    ? { ...sourcePermissions, ...patchPermissions }
    : sourcePermissions;
  const sourceControls = source.selectedControls ?? {};
  const patchControls = hasOwn(patch, "selectedControls")
    ? providerSelectedControlsFromUnknown(patch.selectedControls)
    : undefined;
  const selectedControls = mergeSelectedControls(sourceControls, patchControls);
  const sourceOpenAiMetadata = getOpenAiProviderSessionMetadata(source);
  const codexThreadId = hasOwn(patch, "codexThreadId")
    ? (patch.codexThreadId as string | null)
    : sourceOpenAiMetadata?.codexThreadId;
  return createProviderState({
    provider,
    providerLocked,
    selectedModel,
    selectedEffort,
    seedTranscript,
    runtimeMetadata,
    providerMetadata,
    providerPermissions,
    selectedControls,
    codexThreadId,
  });
}

function createDefaultProviderState(provider: ProviderId, providerLocked: boolean): ProviderSessionState {
  return createProviderState({
    provider,
    providerLocked,
    selectedControls: defaultSelectedControlsForProvider(provider),
    runtimeMetadata: {},
    providerMetadata: {},
    providerPermissions: { [provider]: getProviderDefaultPermission(provider) },
    codexThreadId: provider === "openai" ? null : undefined,
    seedTranscript: null,
  });
}

// localStorage stores provider-session UI metadata. Messages and token/cost
// counters normally come from provider-owned history; providers without that
// history may store a bounded `localTranscript` here to survive reloads.
export interface PersistedSessionMeta {
  sessionId: string;
  name: string;
  cwd: string;
  draftPrompt: string;
  lastSeenAt: number;
  schemaVersion: number;
  providerState?: ProviderSessionState;
  runtimeMetadata?: ProviderSessionRuntimeMetadataMap;
  providerPermissions?: ProviderPermissionMap;
  selectedControls?: ProviderSelectedControlsMap;
  provider?: ProviderId;
  providerLocked?: boolean;
  codexThreadId?: string | null;
  // Pre-rendered transcript inherited from a parent session when native
  // provider fork is unavailable. Persisted so a reload before the first turn
  // doesn't lose the seed.
  seedTranscript?: ChatMessage[];
  // Per-session model + reasoning-effort, persisted so flipping models in
  // one chat doesn't bleed into other sessions and so a reload restores the
  // user's pick. Null/undefined falls back to settings-store defaults.
  // (Distinct from `ProviderSession.model` which is the runtime-reported value
  // from the provider's init/start event.)
  selectedModel?: string | null;
  selectedEffort?: string | null;
  // Legacy Codex sandbox/approval preset id. New saves write
  // providerPermissions.openai instead; this remains only for old metadata reads.
  selectedCodexPermission?: string | null;
  // Providers without durable provider-owned history can persist a bounded
  // local transcript so reload does not reopen an empty chat.
  localTranscript?: ChatMessage[];
}

// Bump when the shape of PersistedSessionMeta changes. Older clients preserve
// rows written by newer schemas, but they must still save current-schema rows.
const CURRENT_SCHEMA_VERSION = 8;

const newerSchemaMetaIds = new Set<string>();
let persistedMetaCache: Record<string, PersistedSessionMeta> | null = null;
let lastPersistedMetaJson: string | null = null;
let lastPersistedMetaIndexJson: string | null = null;

export interface ProviderTask {
  id: string;
  subject: string;
  description?: string;
  status: "pending" | "in_progress" | "completed" | "deleted";
}

/** @deprecated Use ProviderTask. */
export type ClaudeTask = ProviderTask;

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface PendingQuestionItem {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect?: boolean;
}

export interface PendingQuestions {
  toolUseId: string;
  items: PendingQuestionItem[];
  currentIndex: number;
  answers: string[];
}

export interface PendingPermission {
  requestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
}

export type QueuedPromptCommandKind =
  | "plain"
  | "slash"
  | "compact"
  | "codex-plan"
  | "plan-build"
  | "delegation-merge"
  | "delegation-forward"
  | "delegate-plan"
  | "skill"
  | "reload"
  | "loop";

export interface QueuedPromptCommandMetadata {
  kind: QueuedPromptCommandKind;
  name?: string | undefined;
  originalText?: string | undefined;
  sourceSessionId?: string | undefined;
  groupId?: string | undefined;
}

export interface QueuedPromptAttachmentState {
  expanded: boolean;
  files: string[];
}

export interface QueuedPromptInput {
  displayText: string;
  providerPrompt?: string | undefined;
  permissionOverride?: PermissionMode | undefined;
  codexCollaborationMode?: "plan" | "default" | undefined;
  attachmentState?: QueuedPromptAttachmentState | undefined;
  command?: QueuedPromptCommandMetadata | undefined;
}

export interface QueuedPrompt {
  id: string;
  displayText: string;
  providerPrompt: string;
  timestamp: number;
  permissionOverride?: PermissionMode | undefined;
  codexCollaborationMode?: "plan" | "default" | undefined;
  attachmentState?: QueuedPromptAttachmentState | undefined;
  command?: QueuedPromptCommandMetadata | undefined;
  /** @deprecated legacy in-memory queue entries used text-only payloads. */
  text?: string | undefined;
}

export function queuedPromptDisplayText(prompt: QueuedPrompt): string {
  const legacy = prompt as QueuedPrompt & {
    displayText?: string | undefined;
    providerPrompt?: string | undefined;
    text?: string | undefined;
  };
  return legacy.displayText ?? legacy.text ?? legacy.providerPrompt ?? "";
}

export function queuedPromptProviderPrompt(prompt: QueuedPrompt): string {
  const legacy = prompt as QueuedPrompt & {
    displayText?: string | undefined;
    providerPrompt?: string | undefined;
    text?: string | undefined;
  };
  return legacy.providerPrompt ?? legacy.text ?? legacy.displayText ?? "";
}

function createQueuedPrompt(input: string | QueuedPromptInput): QueuedPrompt {
  if (typeof input === "string") {
    return {
      id: uuidv4(),
      displayText: input,
      providerPrompt: input,
      timestamp: Date.now(),
    };
  }

  return {
    id: uuidv4(),
    displayText: input.displayText,
    providerPrompt: input.providerPrompt ?? input.displayText,
    timestamp: Date.now(),
    ...(input.permissionOverride !== undefined ? { permissionOverride: input.permissionOverride } : {}),
    ...(input.codexCollaborationMode !== undefined ? { codexCollaborationMode: input.codexCollaborationMode } : {}),
    ...(input.attachmentState !== undefined ? { attachmentState: input.attachmentState } : {}),
    ...(input.command !== undefined ? { command: input.command } : {}),
  };
}

export interface McpServerStatus {
  name: string;
  status: string;
  error?: string;
  transport?: string;
  scope?: string;
  tools?: McpTool[];
  toolCount?: number;
}

export interface ProviderSession {
  sessionId: string;
  messages: ChatMessage[];
  tasks: ProviderTask[];
  isStreaming: boolean;
  streamingText: string;
  streamingStartedAt: number | null;
  lastEventAt: number | null;
  model: string;
  totalCost: number;
  totalTokens: number;
  contextUsed: number;
  contextMax: number;
  error: string | null;
  promptCount: number;
  planModeActive: boolean;
  pendingQuestions: PendingQuestions | null;
  pendingPermission: PendingPermission | null;
  name: string;
  cwd: string;
  promptQueue: QueuedPrompt[];
  hasBeenStarted: boolean;
  draftPrompt: string;
  activeLoop: ActiveLoop | null;
  ephemeral: boolean;
  mcpServers: McpServerStatus[];
  modifiedFiles: string[];
  luauDiagnostics: LuauDiagnostic[];
  autoCompactStatus: "idle" | "compacting" | "done";
  autoCompactStartedAt: number | null;
  resumeAtUuid: string | null;
  forkParentSessionId: string | null;
  skipOpenwolf: boolean;
  toolUsageStats: Record<string, number>;
  compactionCount: number;
  subagentIds: string[];
  hookEventLog: HookEvent[];
  // Compatibility name: true once provider history has loaded (or load
  // attempted and failed).
  // UI uses this to know when it's safe to claim "no messages" vs "still loading".
  jsonlLoaded: boolean;
  // Canonical provider-owned metadata. New provider integrations should add
  // provider-specific state here instead of widening the flat session shape.
  providerState: ProviderSessionState;
  /** @deprecated Use providerState.runtimeMetadata. Kept as a compatibility mirror. */
  runtimeMetadata: ProviderSessionRuntimeMetadataMap;
  /** @deprecated Use providerState.providerPermissions. Kept as a compatibility mirror. */
  providerPermissions: ProviderPermissionMap;
  /** @deprecated Use providerState.selectedControls. Kept as a compatibility mirror. */
  selectedControls: ProviderSelectedControlsMap;
  // Which backend CLI this session is bound to. Existing sessions hydrated
  // from older metadata default to "anthropic" for backward compatibility.
  /** @deprecated Use providerState.provider. Kept as a compatibility mirror. */
  provider: ProviderId;
  // False only for blank user-created sessions before the first send. Once a
  // session has provider history, seed transcript, or an explicit lock, the UI
  // must not allow switching providers.
  /** @deprecated Use providerState.providerLocked. Kept as a compatibility mirror. */
  providerLocked: boolean;
  // Codex's CLI mints its own thread id on `thread.started`; we capture it
  // here so follow-up `codex exec resume <id>` calls can find the thread.
  // Always null for anthropic sessions.
  /** @deprecated Use getOpenAiProviderSessionMetadata(providerState)?.codexThreadId. */
  codexThreadId: string | null;
  // Fork-time prelude. When non-null, these messages were rendered into
  // `messages` at session-create time; the send path may also splice them
  // into the first prompt sent to a freshly-spawned Codex thread so the
  // model has the parent's context. Null for normal (non-forked) sessions.
  /** @deprecated Use providerState.seedTranscript. */
  seedTranscript: ChatMessage[] | null;
  // Legacy per-session model + reasoning effort mirrors. Null = no generic
  // provider control owns that legacy slot for this provider.
  /** @deprecated Use providerState.selectedModel. */
  selectedModel: string | null;
  /** @deprecated Use providerState.selectedEffort. */
  selectedEffort: string | null;
}

/** @deprecated Use ProviderSession. */
export type ClaudeSession = ProviderSession;

export interface ActiveLoop {
  prompt: string;
  intervalMs: number;
  lastFiredAt: number | null;
  iteration: number;
}

export interface ProviderSessionStoreState {
  sessions: Record<string, ProviderSession>;

  createSession: (
    sessionId: string,
    initialName?: string,
    ephemeral?: boolean,
    skipOpenwolf?: boolean,
    cwd?: string,
    provider?: ProviderId,
    providerLocked?: boolean,
  ) => void;
  switchProviderBeforeStart: (sessionId: string, provider: ProviderId) => boolean;
  setProviderRuntimeMetadata: (
    sessionId: string,
    provider: ProviderId,
    patch: ProviderSessionRuntimeMetadataPatch,
  ) => void;
  setProviderRuntimeResumeId: (sessionId: string, provider: ProviderId, resumeId: string | null) => void;
  setCodexThreadId: (sessionId: string, threadId: string | null) => void;
  setSeedTranscript: (sessionId: string, messages: ChatMessage[]) => void;
  clearSeedTranscript: (sessionId: string) => void;
  setProviderControl: (sessionId: string, provider: ProviderId, controlId: ProviderControlId, value: ProviderControlValue) => void;
  setSelectedModel: (sessionId: string, model: string | null) => void;
  setSelectedEffort: (sessionId: string, effort: string | null) => void;
  setProviderPermission: (sessionId: string, provider: ProviderId, permission: string | null) => void;
  removeSession: (sessionId: string) => void;
  addUserMessage: (sessionId: string, text: string) => void;
  appendStreamingText: (sessionId: string, text: string) => void;
  clearStreamingText: (sessionId: string) => void;
  finalizeAssistantMessage: (sessionId: string, text: string, toolCalls?: ToolCall[]) => void;
  updateToolCall: (sessionId: string, toolUseId: string, patch: Partial<ToolCall>) => void;
  updateToolResult: (sessionId: string, toolUseId: string, result: string, isError: boolean, patch?: Partial<ToolCall>) => void;
  setStreaming: (sessionId: string, streaming: boolean) => void;
  touchLastEvent: (sessionId: string) => void;
  setModel: (sessionId: string, model: string) => void;
  addCost: (sessionId: string, cost: number) => void;
  addTokens: (sessionId: string, tokens: number) => void;
  setContextUsage: (sessionId: string, used: number, max: number) => void;
  setError: (sessionId: string, error: string | null) => void;
  incrementPromptCount: (sessionId: string) => void;
  addTask: (sessionId: string, task: ProviderTask) => void;
  updateTask: (sessionId: string, taskId: string, update: Partial<ProviderTask>) => void;
  setPlanMode: (sessionId: string, active: boolean) => void;
  setPendingQuestions: (sessionId: string, questions: PendingQuestions | null) => void;
  setPendingPermission: (sessionId: string, permission: PendingPermission | null) => void;
  answerQuestion: (sessionId: string, answer: string) => void;
  setName: (sessionId: string, name: string) => void;
  setCwd: (sessionId: string, cwd: string) => void;
  setMcpServers: (sessionId: string, servers: McpServerStatus[]) => void;
  setLuauDiagnostics: (sessionId: string, diagnostics: LuauDiagnostic[]) => void;
  enqueuePrompt: (sessionId: string, prompt: string | QueuedPromptInput) => void;
  dequeuePrompt: (sessionId: string) => QueuedPrompt | undefined;
  removeQueuedPrompt: (sessionId: string, promptId: string) => void;
  clearQueue: (sessionId: string) => void;
  loadFromDisk: (sessionId: string, messages: ChatMessage[]) => void;
  replaceFromDisk: (sessionId: string, messages: ChatMessage[]) => void;
  refreshFromHistory: (sessionId: string, cwd: string) => Promise<void>;
  mergeFromDisk: (sessionId: string, messages: ChatMessage[]) => void;
  setDraftPrompt: (sessionId: string, text: string) => void;
  setLoop: (sessionId: string, loop: ActiveLoop | null) => void;
  tickLoop: (sessionId: string) => void;
  addModifiedFiles: (sessionId: string, paths: string[]) => void;
  resetModifiedFiles: (sessionId: string) => void;
  deleteSession: (sessionId: string) => void;
  setAutoCompactStatus: (sessionId: string, status: "idle" | "compacting" | "done") => void;
  setResumeAtUuid: (sessionId: string, uuid: string | null) => void;
  setForkParentSessionId: (sessionId: string, parentId: string | null) => void;
  truncateFromMessage: (sessionId: string, messageId: string) => void;
  addHookEvent: (sessionId: string, event: HookEvent) => void;
  recordToolUsage: (sessionId: string, toolName: string) => void;
  incrementCompactionCount: (sessionId: string) => void;
  addSubagent: (sessionId: string, subagentId: string) => void;
  removeSubagent: (sessionId: string, subagentId: string) => void;
}

/** @deprecated Use ProviderSessionStoreState. */
export type ClaudeState = ProviderSessionStoreState;

function updateSession(
  sessions: Record<string, ProviderSession>,
  sessionId: string,
  update: Partial<ProviderSession>
): Record<string, ProviderSession> {
  const session = sessions[sessionId];
  if (!session) return sessions;
  const baseProviderState = resolveSessionProviderState(session);
  const providerState = normalizeProviderState(baseProviderState, update);
  return {
    ...sessions,
    [sessionId]: {
      ...session,
      ...update,
      providerState,
      ...providerCompatibilityFields(providerState),
    },
  };
}

type IdleDeadlineLike = { didTimeout: boolean; timeRemaining: () => number };
type WindowWithIdleCallback = Window & typeof globalThis & {
  requestIdleCallback?: (callback: (deadline: IdleDeadlineLike) => void, options?: { timeout: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

function scheduleIdle(callback: () => void): number {
  const w = window as WindowWithIdleCallback;
  if (typeof w.requestIdleCallback === "function") {
    return w.requestIdleCallback(() => callback(), { timeout: 2000 });
  }
  return window.setTimeout(callback, 0);
}

function cancelIdle(handle: number) {
  const w = window as WindowWithIdleCallback;
  if (typeof w.cancelIdleCallback === "function") {
    w.cancelIdleCallback(handle);
  } else {
    window.clearTimeout(handle);
  }
}

function clonePersistedMeta(data: Record<string, PersistedSessionMeta>): Record<string, PersistedSessionMeta> {
  return { ...data };
}

function providerSessionMetaRowKey(sessionId: string): string {
  return `${PROVIDER_SESSION_META_ROW_PREFIX}${sessionId}`;
}

function readPersistedMetaRowIds(indexRaw: string | null): Set<string> {
  const ids = new Set<string>();
  if (indexRaw) {
    try {
      const parsed = JSON.parse(indexRaw) as unknown;
      const rawIds = Array.isArray(parsed)
        ? parsed
        : isRecord(parsed) && Array.isArray(parsed.ids)
          ? parsed.ids
          : [];
      for (const id of rawIds) {
        if (typeof id === "string" && id) ids.add(id);
      }
    } catch (e) {
      console.warn("[providerSessionStore] Failed to parse provider metadata row index:", e);
    }
  }

  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key?.startsWith(PROVIDER_SESSION_META_ROW_PREFIX)) continue;
      const id = key.slice(PROVIDER_SESSION_META_ROW_PREFIX.length);
      if (id) ids.add(id);
    }
  } catch (e) {
    console.warn("[providerSessionStore] Failed to scan provider metadata row keys:", e);
  }

  return ids;
}

function parsePersistedMetaBlob(
  raw: string | null,
  source: string,
): Record<string, PersistedSessionMeta> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return {};
    }
    return parsed as Record<string, PersistedSessionMeta>;
  } catch (e) {
    if (source === STORAGE_KEY) {
      // Parse failure: back up the raw bytes so a corrupted blob is still
      // recoverable (names, drafts). Row metadata can still hydrate below.
      try {
        const backup = { savedAt: new Date().toISOString(), raw };
        localStorage.setItem(`${STORAGE_KEY}.bak`, JSON.stringify(backup));
        console.warn(
          `[providerSessionStore] Corrupt metadata in localStorage — raw bytes backed up to "${STORAGE_KEY}.bak" before recovery.`,
          e,
        );
      } catch (backupErr) {
        console.warn("[providerSessionStore] Failed to back up corrupt metadata:", backupErr);
      }
    } else {
      console.warn(`[providerSessionStore] Failed to parse persisted metadata row "${source}":`, e);
    }
    return {};
  }
}

function readPersistedMetaRows(indexRaw: string | null): Record<string, PersistedSessionMeta> {
  const rows: Record<string, PersistedSessionMeta> = {};
  for (const id of readPersistedMetaRowIds(indexRaw)) {
    const key = providerSessionMetaRowKey(id);
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(key);
    } catch (e) {
      console.warn(`[providerSessionStore] Failed to read provider metadata row "${id}":`, e);
      continue;
    }
    const parsed = parsePersistedMetaBlob(raw, key);
    const row = parsed[id] ?? (isRecord(parsed) ? parsed as unknown as PersistedSessionMeta : undefined);
    if (row && isRecord(row)) {
      rows[id] = row as PersistedSessionMeta;
    }
  }
  return rows;
}

function trackPersistedMetaSchemas(data: Record<string, PersistedSessionMeta>) {
  newerSchemaMetaIds.clear();
  for (const [id, entry] of Object.entries(data)) {
    const v = (entry as { schemaVersion?: number })?.schemaVersion ?? 0;
    if (v > CURRENT_SCHEMA_VERSION) {
      console.warn(
        `[providerSessionStore] Persisted metadata schemaVersion ${v} for ${id} exceeds supported ${CURRENT_SCHEMA_VERSION}. ` +
          "Preserving that row without blocking current-session saves.",
      );
      newerSchemaMetaIds.add(id);
    }
  }
}

function readPersistedMeta(): Record<string, PersistedSessionMeta> {
  let raw: string | null = null;
  let indexRaw: string | null = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
    indexRaw = localStorage.getItem(PROVIDER_SESSION_META_INDEX_KEY);
    if (
      persistedMetaCache
      && raw === lastPersistedMetaJson
      && indexRaw === lastPersistedMetaIndexJson
    ) {
      return clonePersistedMeta(persistedMetaCache);
    }
    const aggregateData = parsePersistedMetaBlob(raw, STORAGE_KEY);
    const rowData = readPersistedMetaRows(indexRaw);
    const data = { ...aggregateData, ...rowData };
    trackPersistedMetaSchemas(data);
    persistedMetaCache = data;
    lastPersistedMetaJson = raw;
    lastPersistedMetaIndexJson = indexRaw;
    return data;
  } catch (e) {
    console.warn("[providerSessionStore] Failed to read persisted metadata:", e);
    persistedMetaCache = {};
    lastPersistedMetaJson = raw;
    lastPersistedMetaIndexJson = indexRaw;
    newerSchemaMetaIds.clear();
    return {};
  }
}

function writePersistedMetaRows(data: Record<string, PersistedSessionMeta>) {
  const nextIds = new Set(Object.keys(data));
  let rowWriteError: unknown = null;

  for (const [id, row] of Object.entries(data)) {
    const key = providerSessionMetaRowKey(id);
    const value = JSON.stringify(row);
    try {
      localStorage.setItem(key, value);
    } catch (e) {
      try {
        // The old aggregate blob is the largest item and is no longer
        // authoritative. Free it before retrying the per-session upsert.
        localStorage.removeItem(STORAGE_KEY);
        localStorage.setItem(key, value);
      } catch (retryErr) {
        rowWriteError ??= retryErr;
        console.warn(`[providerSessionStore] Failed to write provider metadata row "${id}":`, retryErr);
      }
    }
  }

  for (const id of readPersistedMetaRowIds(localStorage.getItem(PROVIDER_SESSION_META_INDEX_KEY))) {
    if (nextIds.has(id)) continue;
    try {
      localStorage.removeItem(providerSessionMetaRowKey(id));
    } catch (e) {
      console.warn(`[providerSessionStore] Failed to remove stale provider metadata row "${id}":`, e);
    }
  }

  try {
    localStorage.setItem(
      PROVIDER_SESSION_META_INDEX_KEY,
      JSON.stringify({
        schemaVersion: CURRENT_SCHEMA_VERSION,
        updatedAt: Date.now(),
        ids: [...nextIds],
      }),
    );
  } catch (e) {
    // Rows are discoverable by prefix scan, so a failed index write is noisy
    // but not data loss.
    console.warn("[providerSessionStore] Failed to write provider metadata row index:", e);
  }

  if (rowWriteError) throw rowWriteError;
}

function writePersistedMeta(data: Record<string, PersistedSessionMeta>) {
  const json = JSON.stringify(data);
  writePersistedMetaRows(data);
  try {
    if (json !== lastPersistedMetaJson) {
      localStorage.setItem(STORAGE_KEY, json);
    }
  } catch (e) {
    // Compatibility only: the row store above is the source of truth. Keeping
    // the legacy aggregate best-effort prevents one huge blob from deciding
    // whether a new Codex session survives restart.
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Ignore cleanup failure; row metadata has already been written.
    }
    console.warn("[providerSessionStore] Provider metadata rows saved; legacy aggregate write skipped:", e);
  }
  persistedMetaCache = data;
  lastPersistedMetaJson = localStorage.getItem(STORAGE_KEY);
  lastPersistedMetaIndexJson = localStorage.getItem(PROVIDER_SESSION_META_INDEX_KEY);
}

export function readProviderSessionMetadataSnapshot(): Record<string, PersistedSessionMeta> {
  return readPersistedMeta();
}

export function readProviderSessionMetadata(sessionId: string): PersistedSessionMeta | null {
  return readPersistedMeta()[sessionId] ?? null;
}

function deletePersistedMeta(sessionId: string) {
  const data = readPersistedMeta();
  if (!data[sessionId]) return;
  delete data[sessionId];
  writePersistedMeta(data);
}

function prunePersistedMeta(
  data: Record<string, PersistedSessionMeta>,
  activeSessionIds: Set<string>,
  now: number,
  aggressive: boolean,
): Record<string, PersistedSessionMeta> {
  for (const [id, row] of Object.entries(data)) {
    if (!row || row.name?.startsWith("[D] ")) {
      delete data[id];
      continue;
    }
    const isActive = activeSessionIds.has(id);
    const isUnnamed = !row.name?.trim();
    if (!isActive && isUnnamed && now - (row.lastSeenAt || 0) > STALE_UNNAMED_META_MS) {
      delete data[id];
    }
  }

  const entries = Object.entries(data);
  if (entries.length <= MAX_PERSISTED_META_ENTRIES && !aggressive) return data;

  const removable = entries
    .filter(([id]) => !activeSessionIds.has(id))
    .sort((a, b) => (a[1].lastSeenAt || 0) - (b[1].lastSeenAt || 0));
  let overage = Math.max(0, entries.length - MAX_PERSISTED_META_ENTRIES);
  for (const [id, row] of removable) {
    if (overage <= 0 && (!aggressive || row.name?.trim())) break;
    delete data[id];
    overage--;
  }
  return data;
}

function providerStateFromPersistedMeta(entry: PersistedSessionMeta): ProviderSessionState {
  const legacyProvider: ProviderId = isProviderId(entry.provider) ? entry.provider : "anthropic";
  const savedState = entry.providerState;
  const rawProvider: ProviderId = isProviderId(savedState?.provider) ? savedState.provider : legacyProvider;
  const providerLocked = typeof savedState?.providerLocked === "boolean"
    ? savedState.providerLocked
    : typeof entry.providerLocked === "boolean"
      ? entry.providerLocked
      : true;
  const savedOpenAiFields = legacyOpenAiFieldsFromProviderState(savedState);
  const selectedModel = typeof savedState?.selectedModel === "string"
    ? savedState.selectedModel
    : typeof entry.selectedModel === "string"
      ? entry.selectedModel
      : null;
  const selectedEffort = typeof savedState?.selectedEffort === "string"
    ? savedState.selectedEffort
    : typeof entry.selectedEffort === "string"
      ? entry.selectedEffort
      : null;
  const seedTranscript = Array.isArray(savedState?.seedTranscript)
    ? savedState.seedTranscript
    : Array.isArray(entry.seedTranscript)
      ? entry.seedTranscript
      : null;
  const runtimeMetadata = mergeRuntimeMetadata(
    providerRuntimeMetadataFromUnknown(entry.runtimeMetadata),
    providerRuntimeMetadataFromUnknown(savedState?.runtimeMetadata),
  );
  const runtimeOpenAiThreadId = openAiCodexThreadIdFromRuntime(runtimeMetadata.openai);
  const codexThreadId = runtimeOpenAiThreadId ?? savedOpenAiFields?.codexThreadId ?? entry.codexThreadId ?? null;
  const selectedCodexPermission =
    savedOpenAiFields?.selectedCodexPermission ??
    (typeof entry.selectedCodexPermission === "string" ? entry.selectedCodexPermission : null);
  const providerPermissions = {
    ...providerPermissionsFromUnknown(entry.providerPermissions),
    ...providerPermissionsFromUnknown(savedState?.providerPermissions),
  };
  const selectedControls = mergeSelectedControls(
    providerSelectedControlsFromUnknown(entry.selectedControls),
    providerSelectedControlsFromUnknown(savedState?.selectedControls),
  );
  const providerMetadata = providerMetadataFromUnknown(savedState?.providerMetadata);
  let provider = rawProvider;
  if (rawProvider === "anthropic") {
    if (codexThreadId) {
      provider = "openai";
    } else if (
      runtimeMetadata.cursor !== undefined
      || localTranscriptFromProviderRuntimeMetadata(runtimeMetadata.cursor) !== null
      || Array.isArray(entry.localTranscript)
      || selectedControls.cursor !== undefined
      || providerPermissions.cursor !== undefined
    ) {
      provider = "cursor";
    }
  }

  return createProviderState({
    provider,
    providerLocked,
    selectedModel,
    selectedEffort,
    seedTranscript,
    runtimeMetadata,
    providerMetadata,
    providerPermissions,
    selectedControls,
    codexThreadId,
    selectedCodexPermission,
  });
}

function shouldPersistLocalTranscript(provider: ProviderId): boolean {
  return providerPersistsLocalTranscript(provider);
}

function shouldPersistLocalTranscriptForState(providerState: ProviderSessionState): boolean {
  if (shouldPersistLocalTranscript(providerState.provider)) return true;
  // Codex normally hydrates from rollout JSONL via its external thread id, but
  // app-server sessions can restart before that rollout is readable. Persist a
  // bounded UI transcript as a fallback; provider history still wins when it
  // has messages.
  return providerState.provider === "openai";
}

function localTranscriptFromMessages(
  providerState: ProviderSessionState,
  messages: ChatMessage[],
  maxMessages = MAX_LOCAL_TRANSCRIPT_MESSAGES,
): ChatMessage[] | undefined {
  if (!shouldPersistLocalTranscriptForState(providerState) || messages.length === 0) return undefined;
  return messages.slice(-maxMessages);
}

function localTranscriptFromUnknown(value: unknown): ChatMessage[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((message): message is ChatMessage => {
    if (!isRecord(message)) return false;
    return (message.role === "user" || message.role === "assistant")
      && typeof message.content === "string"
      && typeof message.id === "string";
  }).map((message) => ({
    ...message,
    content: message.role === "user" ? stripSystemReminderBlocks(message.content) : message.content,
    ...(Array.isArray(message.toolCalls)
      ? { toolCalls: message.toolCalls.map((toolCall) => normalizeProviderToolCall(toolCall)) }
      : {}),
  })).slice(-MAX_LOCAL_TRANSCRIPT_MESSAGES);
}

function localTranscriptFromProviderRuntimeMetadata(
  metadata: ProviderSessionRuntimeMetadata | undefined,
): ChatMessage[] | null {
  return localTranscriptFromUnknown(metadata?.runtimePayload.localTranscript);
}

function sanitizeVisibleMessages(messages: ChatMessage[]): ChatMessage[] {
  let changed = false;
  const next = messages.map((message) => {
    if (message.role !== "user") return message;
    const content = stripSystemReminderBlocks(message.content);
    if (content === message.content) return message;
    changed = true;
    return { ...message, content };
  });
  return changed ? next : messages;
}

function withLocalTranscriptRuntimePayload(
  providerState: ProviderSessionState,
  provider: ProviderId,
  localTranscript: ChatMessage[] | undefined,
  shouldStoreLocalTranscript: boolean,
): ProviderSessionState {
  const existing = providerState.runtimeMetadata[provider];
  const runtimePayload = { ...(existing?.runtimePayload ?? {}) };
  if (shouldStoreLocalTranscript && localTranscript && localTranscript.length > 0) {
    runtimePayload.localTranscript = localTranscript;
  } else {
    delete runtimePayload.localTranscript;
  }
  if (
    !shouldStoreLocalTranscript
    && existing
    && localTranscriptFromProviderRuntimeMetadata(existing) === null
  ) {
    return providerState;
  }
  return createProviderState({
    ...providerState,
    runtimeMetadata: {
      ...providerState.runtimeMetadata,
      [provider]: createProviderRuntimeMetadata(provider, {
        historySource: existing?.historySource,
        resume: existing?.resume ?? null,
        runtimePayload,
      }),
    },
  });
}

function buildPersistedMeta(
  sessions: Record<string, ProviderSession>,
  dropSeedTranscripts: boolean,
  aggressivePrune: boolean,
  options: {
    includeExisting?: boolean;
    maxLocalTranscriptMessages?: number;
    dropLocalTranscripts?: boolean;
  } = {},
): Record<string, PersistedSessionMeta> {
  const existing = readPersistedMeta();
  const next = options.includeExisting === false ? {} : clonePersistedMeta(existing);
  const activeSessionIds = new Set<string>();
  const now = Date.now();

  for (const [id, s] of Object.entries(sessions)) {
    if (s.ephemeral) continue;
    activeSessionIds.add(id);
    if (newerSchemaMetaIds.has(id) && existing[id]) {
      continue;
    }
    const baseProviderState = resolveSessionProviderState(s);
    const providerState = normalizeProviderState(baseProviderState, s);
    const persistedProviderStateBase = dropSeedTranscripts
      ? { ...providerState, seedTranscript: null }
      : providerState;
    const shouldStoreLocalTranscript =
      !options.dropLocalTranscripts
      && shouldPersistLocalTranscriptForState(providerState);
    const maxLocalTranscriptMessages = options.maxLocalTranscriptMessages
      ?? (dropSeedTranscripts ? MAX_COMPACT_LOCAL_TRANSCRIPT_MESSAGES : MAX_LOCAL_TRANSCRIPT_MESSAGES);
    const localTranscript = options.dropLocalTranscripts
      ? undefined
      : localTranscriptFromMessages(providerState, s.messages, maxLocalTranscriptMessages);
    const persistedProviderState = withLocalTranscriptRuntimePayload(
      persistedProviderStateBase,
      providerState.provider,
      localTranscript,
      shouldStoreLocalTranscript,
    );
    const compat = providerCompatibilityFields(persistedProviderState);
    next[id] = {
      sessionId: s.sessionId,
      name: s.name,
      cwd: s.cwd,
      draftPrompt: s.draftPrompt || "",
      lastSeenAt: now,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      providerState: persistedProviderState,
      runtimeMetadata: persistedProviderState.runtimeMetadata,
      providerPermissions: persistedProviderState.providerPermissions,
      selectedControls: persistedProviderState.selectedControls,
      provider: compat.provider,
      providerLocked: compat.providerLocked,
      codexThreadId: compat.codexThreadId,
      ...(!dropSeedTranscripts && compat.seedTranscript ? { seedTranscript: compat.seedTranscript } : {}),
      ...(compat.selectedModel ? { selectedModel: compat.selectedModel } : {}),
      ...(compat.selectedEffort ? { selectedEffort: compat.selectedEffort } : {}),
    };
  }

  return prunePersistedMeta(next, activeSessionIds, now, aggressivePrune);
}

function loadMetadata(sessionId: string): PersistedSessionMeta | null {
  const data = readPersistedMeta();
  const entry = data[sessionId];
  if (!entry) return null;
  const providerState = providerStateFromPersistedMeta(entry);
  const compat = providerCompatibilityFields(providerState);
  const persistedLocalTranscript = localTranscriptFromProviderRuntimeMetadata(providerState.runtimeMetadata[compat.provider])
    ?? localTranscriptFromUnknown(entry.localTranscript);
  const localTranscript = shouldPersistLocalTranscript(compat.provider) || persistedLocalTranscript
    ? persistedLocalTranscript
    : null;
  const seedFromLocalTranscript = compat.provider === "openai"
    && !compat.codexThreadId
    && !!localTranscript?.length;
  return {
    sessionId: entry.sessionId || sessionId,
    name: entry.name || "",
    cwd: entry.cwd || "",
    draftPrompt: entry.draftPrompt || "",
    lastSeenAt: entry.lastSeenAt || 0,
    schemaVersion: (entry as { schemaVersion?: number }).schemaVersion ?? 0,
    providerState,
    runtimeMetadata: providerState.runtimeMetadata,
    providerPermissions: providerState.providerPermissions,
    selectedControls: providerState.selectedControls,
    provider: compat.provider,
    providerLocked: compat.providerLocked,
    codexThreadId: compat.codexThreadId,
    // v2 blobs lack seedTranscript — leave undefined so consumers treat the
    // session as un-seeded. Stored as ChatMessage[] when present.
    ...(seedFromLocalTranscript
      ? { seedTranscript: localTranscript }
      : compat.seedTranscript
        ? { seedTranscript: compat.seedTranscript }
        : {}),
    ...(localTranscript ? { localTranscript } : {}),
    // v3 and earlier didn't carry per-session model/effort; v4+ does.
    selectedModel: compat.selectedModel,
    selectedEffort: compat.selectedEffort,
  };
}

// Write lightweight metadata. Claude/Codex messages live in provider-owned
// history and are reloaded on demand; providers without durable history keep a
// bounded local transcript so reloads do not reopen an empty chat.
function saveToStorage(sessions: Record<string, ProviderSession>) {
  try {
    const data = buildPersistedMeta(sessions, false, false);
    writePersistedMeta(data);
  } catch (e) {
    try {
      // Quota fallback: preserve session rows and current choices, but drop
      // fork seed transcripts and prune old inactive rows before retrying.
      writePersistedMeta(buildPersistedMeta(sessions, true, true));
      console.warn("[providerSessionStore] Saved compact metadata after localStorage quota pressure:", e);
    } catch (retryErr) {
      try {
        writePersistedMeta(buildPersistedMeta(sessions, true, true, {
          includeExisting: false,
          maxLocalTranscriptMessages: 20,
        }));
        console.warn("[providerSessionStore] Saved active-session-only metadata after localStorage quota pressure:", retryErr);
      } catch (activeOnlyErr) {
        try {
          writePersistedMeta(buildPersistedMeta(sessions, true, true, {
            includeExisting: false,
            dropLocalTranscripts: true,
          }));
          console.warn("[providerSessionStore] Saved active metadata without local transcripts after localStorage quota pressure:", activeOnlyErr);
        } catch (metadataOnlyErr) {
          console.error("[providerSessionStore] Failed to save session metadata:", metadataOnlyErr);
        }
      }
    }
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let idleSaveHandle: number | null = null;
let savePending = false;

function scheduleIdleSave() {
  if (idleSaveHandle !== null) return;
  idleSaveHandle = scheduleIdle(() => {
    idleSaveHandle = null;
    if (!savePending) return;
    savePending = false;
    saveToStorage(useProviderSessionStore.getState().sessions);
    if (savePending) scheduleIdleSave();
  });
}

function debouncedSave() {
  savePending = true;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    scheduleIdleSave();
  }, 1000);
}

function sessionNeedsLocalTranscriptSave(session: ProviderSession | undefined): boolean {
  if (!session || session.ephemeral) return false;
  return shouldPersistLocalTranscriptForState(resolveSessionProviderState(session));
}

function patchSession(sessionId: string, patch: Partial<ProviderSession>) {
  useProviderSessionStore.setState((s) => ({ sessions: updateSession(s.sessions, sessionId, patch) }));
}

// In-memory hydration cache keyed by {mtime_ms, size}. Reloading the same
// session within one app session is common (switching chat tabs, re-opening a
// dialog) — if provider history hasn't changed, reuse the parsed messages
// instead of streaming 10k records over IPC + reparsing in Rust. Not persisted:
// a process restart will always do a fresh parse.
interface HydrationCacheEntry {
  mtimeMs: number;
  size: number;
  messages: ChatMessage[];
  lastUsedAt: number;
}
const hydrationCache = new Map<string, HydrationCacheEntry>();
const MAX_HYDRATION_CACHE_ENTRIES = 6;
const MAX_HYDRATION_CACHE_MESSAGES = 30000;

function trimHydrationCache() {
  let totalMessages = 0;
  for (const entry of hydrationCache.values()) totalMessages += entry.messages.length;
  if (hydrationCache.size <= MAX_HYDRATION_CACHE_ENTRIES && totalMessages <= MAX_HYDRATION_CACHE_MESSAGES) return;

  const oldest = [...hydrationCache.entries()].sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
  for (const [sessionId, entry] of oldest) {
    if (hydrationCache.size <= MAX_HYDRATION_CACHE_ENTRIES && totalMessages <= MAX_HYDRATION_CACHE_MESSAGES) break;
    hydrationCache.delete(sessionId);
    totalMessages -= entry.messages.length;
  }
}

function rememberHydration(sessionId: string, mtimeMs: number, size: number, messages: ChatMessage[]) {
  hydrationCache.set(sessionId, {
    mtimeMs,
    size,
    messages,
    lastUsedAt: Date.now(),
  });
  trimHydrationCache();
}

function buildProviderHydrateInput(sessionId: string, cwd: string): ProviderHydrateInput | null {
  const sess = useProviderSessionStore.getState().sessions[sessionId];
  if (!sess) return null;
  const providerState = resolveSessionProviderState(sess);
  const provider = providerState.provider;
  const input: ProviderHydrateInput = {
    provider,
    sessionId,
    cwd,
  };
  if (sess.resumeAtUuid) {
    input.resumeAtUuid = sess.resumeAtUuid;
  }
  const cached = hydrationCache.get(sessionId);
  if (cached) {
    cached.lastUsedAt = Date.now();
    input.cacheEntry = cached;
  }
  return input;
}

async function hydrateSessionHistory(
  sessionId: string,
  cwd: string,
  mode: "extend" | "replace",
): Promise<void> {
  const input = buildProviderHydrateInput(sessionId, cwd);
  if (!input) return;
  try {
    const { hydrateProviderHistory } = await import("../lib/providerRuntime");
    const result = await hydrateProviderHistory(input);
    if (result.clearCache) {
      hydrationCache.delete(sessionId);
    }
    if (result.status === "messages") {
      if (result.cacheWrite) {
        rememberHydration(
          sessionId,
          result.cacheWrite.mtimeMs,
          result.cacheWrite.size,
          result.cacheWrite.messages,
        );
      }
      if (mode === "replace") {
        useProviderSessionStore.getState().replaceFromDisk(sessionId, result.messages);
      } else {
        useProviderSessionStore.getState().loadFromDisk(sessionId, result.messages);
      }
    } else {
      patchSession(sessionId, { jsonlLoaded: true });
    }
  } catch (err) {
    const label = getProviderHistoryPolicy(input.provider).hydrateFailureLabel;
    console.warn(`[providerSessionStore] ${label} hydrate failed:`, sessionId, err);
    patchSession(sessionId, { jsonlLoaded: true });
    throw err;
  }
}

// Async provider history hydration. Fire-and-forget — errors are logged but
// non-fatal so the user can still interact with a session whose history hasn't
// loaded yet.
function hydrateFromProviderHistory(sessionId: string, cwd: string) {
  hydrateSessionHistory(sessionId, cwd, "extend").catch(() => {});
}


const providerSessionStore = create<ProviderSessionStoreState>((set, get) => ({
  sessions: {},

  createSession: (sessionId, initialName, ephemeral, skipOpenwolf, cwd, provider, providerLocked) => {
    const existing = get().sessions[sessionId];
    if (existing) {
      const explicitProvider = provider;
      const canAdoptExplicitProvider =
        !!explicitProvider
        && !existing.providerLocked
        && !existing.hasBeenStarted
        && existing.promptCount === 0
        && existing.messages.length === 0
        && existing.promptQueue.length === 0
        && !existing.isStreaming
        && !existing.forkParentSessionId
        && !existing.resumeAtUuid
        && !getProviderRuntimeResumeId(resolveSessionProviderState(existing), resolveSessionProviderState(existing).provider);
      if (canAdoptExplicitProvider && resolveSessionProviderState(existing).provider !== explicitProvider) {
        set((s) => {
          const current = s.sessions[sessionId];
          if (!current) return s;
          const updated = updateSession(s.sessions, sessionId, {
            provider: explicitProvider,
            ...(providerLocked !== undefined ? { providerLocked } : {}),
          });
          if (!current.ephemeral) saveToStorage(updated);
          return { sessions: updated };
        });
      }
      if (initialName && !existing.name) {
        set((s) => {
          const updated = updateSession(s.sessions, sessionId, { name: initialName });
          if (!existing.ephemeral) saveToStorage(updated);
          return { sessions: updated };
        });
      }
      // If caller supplied a cwd and we didn't have one, adopt it and hydrate.
      if (cwd && !existing.cwd && !existing.ephemeral) {
        set((s) => {
          const updated = updateSession(s.sessions, sessionId, { cwd });
          saveToStorage(updated);
          return { sessions: updated };
        });
        if (!existing.jsonlLoaded) hydrateFromProviderHistory(sessionId, cwd);
      }
      if (providerLocked === true && !existing.providerLocked) {
        set((s) => {
          const current = s.sessions[sessionId];
          if (!current) return s;
          const updated = updateSession(s.sessions, sessionId, { providerLocked: true });
          if (!current.ephemeral) saveToStorage(updated);
          return { sessions: updated };
        });
      }
      return;
    }

    const meta = ephemeral ? null : loadMetadata(sessionId);
    const seededName = initialName ?? meta?.name ?? "";
    const seededCwd = cwd ?? meta?.cwd ?? "";
    const seededDraft = meta?.draftPrompt ?? "";
    const metaProviderState = meta?.providerState;
    const seededProvider: ProviderId = metaProviderState?.provider ?? meta?.provider ?? provider ?? "anthropic";
    const metaOpenAiMetadata = getOpenAiProviderSessionMetadata(metaProviderState);
    const legacyOpenAiFields = legacyOpenAiFieldsFromProviderState(metaProviderState);
    const seededCodexThreadId = metaOpenAiMetadata?.codexThreadId ?? meta?.codexThreadId ?? null;
    // Fork plumbing: a parent session can stash a transcript in metadata
    // before the child is created. We pre-render those messages so the UI
    // shows the inherited history immediately; the actual model context for
    // a Codex thread gets restitched into the first prompt by the send path.
    const seededTranscript: ChatMessage[] | null = Array.isArray(metaProviderState?.seedTranscript) && metaProviderState.seedTranscript.length > 0
      ? metaProviderState.seedTranscript
      : Array.isArray(meta?.seedTranscript) && meta.seedTranscript.length > 0
        ? meta.seedTranscript
        : null;
    const localTranscript = localTranscriptFromUnknown(meta?.localTranscript);
    const seededMessages: ChatMessage[] = seededTranscript
      ? [...seededTranscript]
      : localTranscript
        ? [...localTranscript]
        : [];
    const seededPromptCount = seededMessages.filter((m) => m.role === "user").length;
    const seededProviderLocked = meta
      ? (metaProviderState?.providerLocked ?? meta.providerLocked ?? true) || seededPromptCount > 0
      : providerLocked !== undefined
        ? providerLocked || seededPromptCount > 0
        : seededPromptCount > 0;
    const seededSelectedModel = metaProviderState?.selectedModel ?? meta?.selectedModel ?? null;
    const seededSelectedEffort = metaProviderState?.selectedEffort ?? meta?.selectedEffort ?? null;
    const seededSelectedCodexPermission =
      legacyOpenAiFields?.selectedCodexPermission ?? meta?.selectedCodexPermission ?? null;
    const seededProviderPermissions = {
      ...providerPermissionsFromUnknown(meta?.providerPermissions),
      ...providerPermissionsFromUnknown(metaProviderState?.providerPermissions),
    };
    const seededSelectedControls = mergeSelectedControls(
      providerSelectedControlsFromUnknown(meta?.selectedControls),
      providerSelectedControlsFromUnknown(metaProviderState?.selectedControls),
    );
    const seededProviderState = createProviderState({
      provider: seededProvider,
      providerLocked: seededProviderLocked,
      selectedModel: seededSelectedModel,
      selectedEffort: seededSelectedEffort,
      seedTranscript: seededTranscript,
      runtimeMetadata: metaProviderState?.runtimeMetadata ?? meta?.runtimeMetadata,
      providerMetadata: metaProviderState?.providerMetadata,
      providerPermissions: seededProviderPermissions,
      selectedControls: seededSelectedControls,
      codexThreadId: seededCodexThreadId,
      selectedCodexPermission: seededSelectedCodexPermission,
    });
    const seededProviderCompat = providerCompatibilityFields(seededProviderState);

    set((s) => {
      const sessions = {
        ...s.sessions,
        [sessionId]: {
          sessionId,
          messages: seededMessages,
          tasks: [],
          isStreaming: false,
          streamingText: "",
          streamingStartedAt: null,
          lastEventAt: null,
          model: "",
          totalCost: 0,
          totalTokens: 0,
          contextUsed: 0,
          contextMax: 0,
          error: null,
          promptCount: seededPromptCount,
          planModeActive: false,
          pendingQuestions: null,
          pendingPermission: null,
          name: seededName,
          cwd: seededCwd,
          promptQueue: [],
          hasBeenStarted: seededPromptCount > 0,
          draftPrompt: seededDraft,
          activeLoop: null,
          ephemeral: !!ephemeral,
          mcpServers: [],
          modifiedFiles: [],
          luauDiagnostics: [],
          autoCompactStatus: "idle" as const,
          autoCompactStartedAt: null,
          resumeAtUuid: null,
          forkParentSessionId: null,
          skipOpenwolf: !!skipOpenwolf,
          toolUsageStats: {},
          compactionCount: 0,
          subagentIds: [],
          hookEventLog: [],
          jsonlLoaded: !!ephemeral, // ephemeral sessions never load from disk
          providerState: seededProviderState,
          ...seededProviderCompat,
        },
      };
      if (!ephemeral) {
        const shouldSaveImmediately =
          !!seededName.trim()
          || !!seededCwd
          || provider !== undefined
          || providerLocked !== undefined;
        if (shouldSaveImmediately) {
          saveToStorage(sessions);
        } else {
          debouncedSave();
        }
      }
      return { sessions };
    });

    // Kick off provider history hydration when we know where to look. Ephemeral and
    // cwd-less sessions skip this; the provider chat shell calls createSession
    // again with a cwd (or calls setCwd) once the panel mounts with its working dir.
    if (!ephemeral && seededCwd) {
      hydrateFromProviderHistory(sessionId, seededCwd);
    }
  },

  removeSession: (sessionId) => {
    hydrationCache.delete(sessionId);
    set((s) => {
      const removed = s.sessions[sessionId];
      const { [sessionId]: _, ...rest } = s.sessions;
      // Only unnamed or ephemeral sessions get purged from disk. Named sessions
      // remain in metadata so the provider-session dialog can reopen them with
      // history pulled back from the provider backend.
      if (!removed?.name || removed?.ephemeral) {
        try {
          deletePersistedMeta(sessionId);
        } catch (e) {
          console.warn("[providerSessionStore] Failed to prune metadata on remove:", e);
        }
      }
      return { sessions: rest };
    });
  },

  switchProviderBeforeStart: (sessionId, provider) => {
    let switched = false;
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;
      const hasUserTurn = session.messages.some((m) => m.role === "user");
      const hasSeedTranscript = (session.seedTranscript?.length ?? 0) > 0;
      const providerState = resolveSessionProviderState(session);
      const resumeId = getProviderRuntimeResumeId(providerState, providerState.provider);
      if (
        session.providerLocked ||
        session.hasBeenStarted ||
        session.promptCount > 0 ||
        hasUserTurn ||
        hasSeedTranscript ||
        !!resumeId ||
        !!session.forkParentSessionId
      ) {
        return s;
      }
      const currentProvider = providerState.provider;
      if (currentProvider === provider) {
        switched = true;
        return s;
      }
      const nextProviderState = createDefaultProviderState(provider, false);
      const updated = updateSession(s.sessions, sessionId, {
        providerState: nextProviderState,
        model: "",
        contextUsed: 0,
        contextMax: 0,
        error: null,
      });
      if (!session.ephemeral) debouncedSave();
      switched = true;
      return { sessions: updated };
    });
    return switched;
  },

  addUserMessage: (sessionId, text) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;
      const msg: ChatMessage = { id: uuidv4(), role: "user", content: stripSystemReminderBlocks(text), timestamp: Date.now() };
      const shouldLockProvider = !session.providerLocked;
      const updated = updateSession(s.sessions, sessionId, {
        messages: [...session.messages, msg],
        error: null,
        providerLocked: true,
      });
      if (sessionNeedsLocalTranscriptSave(session)) {
        saveToStorage(updated);
      } else if (shouldLockProvider && !session.ephemeral) {
        debouncedSave();
      }
      return { sessions: updated };
    });
  },

  appendStreamingText: (sessionId, text) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;
      return { sessions: updateSession(s.sessions, sessionId, { streamingText: session.streamingText + text }) };
    });
  },

  clearStreamingText: (sessionId) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session || session.streamingText === "") return s;
      return { sessions: updateSession(s.sessions, sessionId, { streamingText: "" }) };
    });
  },

  finalizeAssistantMessage: (sessionId, text, toolCalls) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;
      const normalizedToolCalls = toolCalls?.map((toolCall) => normalizeProviderToolCall(toolCall));
      const msg: ChatMessage = {
        id: uuidv4(),
        role: "assistant",
        content: text,
        timestamp: Date.now(),
        ...(normalizedToolCalls !== undefined && { toolCalls: normalizedToolCalls }),
      };
      const updated = updateSession(s.sessions, sessionId, { messages: [...session.messages, msg], streamingText: "" });
      if (sessionNeedsLocalTranscriptSave(session)) saveToStorage(updated);
      return { sessions: updated };
    });
  },

  updateToolCall: (sessionId, toolUseId, patch) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;
      const normalizedPatch = normalizeProviderToolPatch(patch);

      const msgs = session.messages;
      for (let i = msgs.length - 1; i >= 0; i--) {
        const msg = msgs[i];
        if (msg && msg.role === "assistant" && msg.toolCalls) {
          const tcIdx = msg.toolCalls.findIndex((t) => t.id === toolUseId);
          if (tcIdx >= 0) {
            const updatedToolCalls = msg.toolCalls.slice();
            const existing = updatedToolCalls[tcIdx]!;
            updatedToolCalls[tcIdx] = {
              ...existing,
              ...patch,
              ...normalizedPatch,
              input: normalizedPatch.input ? { ...existing.input, ...normalizedPatch.input } : existing.input,
            };
            updatedToolCalls[tcIdx] = normalizeProviderToolCall(updatedToolCalls[tcIdx]!);
            const messages = msgs.slice();
            messages[i] = { ...msg, toolCalls: updatedToolCalls };
            const updated = updateSession(s.sessions, sessionId, { messages });
            if (sessionNeedsLocalTranscriptSave(session)) saveToStorage(updated);
            return { sessions: updated };
          }
        }
      }
      return s;
    });
  },

  updateToolResult: (sessionId, toolUseId, result, isError, patch) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;
      const normalizedPatch = patch ? normalizeProviderToolPatch(patch) : undefined;

      const msgs = session.messages;
      for (let i = msgs.length - 1; i >= 0; i--) {
        const msg = msgs[i];
        if (msg && msg.role === "assistant" && msg.toolCalls) {
          const tcIdx = msg.toolCalls.findIndex((t) => t.id === toolUseId);
          if (tcIdx >= 0) {
            const updatedToolCalls = msg.toolCalls.slice();
            const existing = updatedToolCalls[tcIdx]!;
            updatedToolCalls[tcIdx] = {
              ...existing,
              ...normalizedPatch,
              input: normalizedPatch?.input ? { ...existing.input, ...normalizedPatch.input } : existing.input,
              result,
              isError,
            };
            updatedToolCalls[tcIdx] = normalizeProviderToolCall(updatedToolCalls[tcIdx]!);
            const messages = msgs.slice();
            messages[i] = { ...msg, toolCalls: updatedToolCalls };
            const updated = updateSession(s.sessions, sessionId, { messages });
            if (sessionNeedsLocalTranscriptSave(session)) saveToStorage(updated);
            return { sessions: updated };
          }
        }
      }
      return s;
    });
  },

  setStreaming: (sessionId, streaming) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session || session.isStreaming === streaming) return s;
      return { sessions: updateSession(s.sessions, sessionId, {
        isStreaming: streaming,
        streamingStartedAt: streaming ? Date.now() : null,
        lastEventAt: streaming ? Date.now() : null,
      }) };
    });
  },

  touchLastEvent: (sessionId) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;
      return { sessions: updateSession(s.sessions, sessionId, { lastEventAt: Date.now() }) };
    });
  },

  setModel: (sessionId, model) => {
    set((s) => ({ sessions: updateSession(s.sessions, sessionId, { model }) }));
  },

  addCost: (sessionId, cost) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;
      return { sessions: updateSession(s.sessions, sessionId, { totalCost: session.totalCost + cost }) };
    });
  },

  addTokens: (sessionId, tokens) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;
      return { sessions: updateSession(s.sessions, sessionId, { totalTokens: session.totalTokens + tokens }) };
    });
  },

  setContextUsage: (sessionId, used, max) => {
    const sess = get().sessions[sessionId];
    if (sess && sess.contextUsed === used && sess.contextMax === max) return;
    set((s) => ({ sessions: updateSession(s.sessions, sessionId, { contextUsed: used, contextMax: max }) }));
  },

  setError: (sessionId, error) => {
    set((s) => ({ sessions: updateSession(s.sessions, sessionId, { error }) }));
  },

  incrementPromptCount: (sessionId) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;
      const shouldLockProvider = !session.providerLocked;
      const updated = updateSession(s.sessions, sessionId, {
        promptCount: session.promptCount + 1,
        hasBeenStarted: true,
        providerLocked: true,
      });
      if (shouldLockProvider && !session.ephemeral) debouncedSave();
      return { sessions: updated };
    });
  },

  addTask: (sessionId, task) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;
      if (session.tasks.some((t) => t.id === task.id)) return s;
      return { sessions: updateSession(s.sessions, sessionId, { tasks: [...session.tasks, task] }) };
    });
  },

  updateTask: (sessionId, taskId, update) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;
      const tasks = session.tasks.map((t) => t.id === taskId ? { ...t, ...update } : t);
      return { sessions: updateSession(s.sessions, sessionId, { tasks }) };
    });
  },

  setPlanMode: (sessionId, active) => {
    set((s) => ({ sessions: updateSession(s.sessions, sessionId, { planModeActive: active }) }));
  },

  setPendingQuestions: (sessionId, questions) => {
    set((s) => ({ sessions: updateSession(s.sessions, sessionId, { pendingQuestions: questions }) }));
  },

  setPendingPermission: (sessionId, permission) => {
    set((s) => ({ sessions: updateSession(s.sessions, sessionId, { pendingPermission: permission }) }));
  },

  answerQuestion: (sessionId, answer) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session || !session.pendingQuestions) return s;
      const pq = session.pendingQuestions;
      const newAnswers = [...pq.answers, answer];
      const nextIdx = pq.currentIndex + 1;
      if (nextIdx >= pq.items.length) {
        return { sessions: updateSession(s.sessions, sessionId, { pendingQuestions: null }) };
      }
      return {
        sessions: updateSession(s.sessions, sessionId, {
          pendingQuestions: { ...pq, currentIndex: nextIdx, answers: newAnswers },
        }),
      };
    });
  },

  setName: (sessionId, name) => {
    set((s) => {
      const updated = updateSession(s.sessions, sessionId, { name });
      const session = s.sessions[sessionId];
      if (session && !session.ephemeral) saveToStorage(updated);
      return { sessions: updated };
    });
  },

  setCwd: (sessionId, cwd) => {
    const prev = get().sessions[sessionId];
    set((s) => {
      const updated = updateSession(s.sessions, sessionId, { cwd });
      debouncedSave();
      return { sessions: updated };
    });
    // Hydrate from provider history the first time we learn the cwd for a
    // non-ephemeral session that hasn't been loaded yet.
    if (prev && !prev.ephemeral && !prev.jsonlLoaded && cwd && cwd !== prev.cwd) {
      hydrateFromProviderHistory(sessionId, cwd);
    }
  },

  setMcpServers: (sessionId, servers) => {
    set((s) => ({ sessions: updateSession(s.sessions, sessionId, { mcpServers: servers }) }));
  },

  setLuauDiagnostics: (sessionId, diagnostics) => {
    set((s) => ({ sessions: updateSession(s.sessions, sessionId, { luauDiagnostics: diagnostics }) }));
  },

  setProviderRuntimeMetadata: (sessionId, provider, patch) => {
    let shouldHydrate = false;
    let hydrateCwd = "";
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;
      const providerState = resolveSessionProviderState(session);
      const current = providerState.runtimeMetadata[provider];
      const next = createProviderRuntimeMetadata(provider, {
        historySource: patch.historySource ?? current?.historySource,
        resume: patch.resume ?? current?.resume ?? null,
        runtimePayload: {
          ...(current?.runtimePayload ?? {}),
          ...(patch.runtimePayload ?? {}),
        },
      });
      const previousResumeId = runtimeResumeId(current);
      const nextResumeId = runtimeResumeId(next);
      if (
        current?.historySource === next.historySource
        && previousResumeId === nextResumeId
        && JSON.stringify(current?.runtimePayload ?? {}) === JSON.stringify(next.runtimePayload)
      ) {
        return s;
      }
      shouldHydrate = provider === "openai"
        && getProviderHistoryPolicy(provider).source === "codex-rollout"
        && previousResumeId !== nextResumeId
        && !!nextResumeId
        && !!session.cwd
        && session.jsonlLoaded
        && !session.isStreaming;
      hydrateCwd = session.cwd;
      const updated = updateSession(s.sessions, sessionId, {
        runtimeMetadata: { [provider]: next },
        ...(provider === "openai" ? { codexThreadId: nextResumeId } : {}),
      });
      if (!session.ephemeral) debouncedSave();
      return { sessions: updated };
    });
    if (shouldHydrate && hydrateCwd) {
      patchSession(sessionId, { jsonlLoaded: false });
      hydrateFromProviderHistory(sessionId, hydrateCwd);
    }
  },

  setProviderRuntimeResumeId: (sessionId, provider, resumeId) => {
    const runtimePayload = provider === "openai"
      ? { codexThreadId: resumeId }
      : provider === "cursor"
        ? { cursorChatId: resumeId }
        : {};
    get().setProviderRuntimeMetadata(sessionId, provider, {
      resume: { id: resumeId },
      runtimePayload,
    });
  },

  setCodexThreadId: (sessionId, threadId) => {
    get().setProviderRuntimeResumeId(sessionId, "openai", threadId);
  },

  setSeedTranscript: (sessionId, messages) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;
      const next = messages.length > 0 ? messages : null;
      const updated = updateSession(s.sessions, sessionId, { seedTranscript: next });
      if (!session.ephemeral) debouncedSave();
      return { sessions: updated };
    });
  },

  clearSeedTranscript: (sessionId) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session || session.seedTranscript === null) return s;
      const updated = updateSession(s.sessions, sessionId, { seedTranscript: null });
      if (!session.ephemeral) debouncedSave();
      return { sessions: updated };
    });
  },

  setProviderControl: (sessionId, provider, controlId, value) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session || !getProviderControl(provider, controlId)) return s;
      const current = resolveSessionProviderState(session).selectedControls[provider]?.[controlId];
      if (current === value) return s;
      const updated = updateSession(s.sessions, sessionId, {
        selectedControls: { [provider]: { [controlId]: value } },
      });
      if (!session.ephemeral) debouncedSave();
      return { sessions: updated };
    });
  },

  setSelectedModel: (sessionId, model) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session || session.selectedModel === model) return s;
      const updated = updateSession(s.sessions, sessionId, { selectedModel: model });
      if (!session.ephemeral) debouncedSave();
      return { sessions: updated };
    });
  },

  setSelectedEffort: (sessionId, effort) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session || session.selectedEffort === effort) return s;
      const updated = updateSession(s.sessions, sessionId, { selectedEffort: effort });
      if (!session.ephemeral) debouncedSave();
      return { sessions: updated };
    });
  },

  setProviderPermission: (sessionId, provider, permission) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;
      const providerState = resolveSessionProviderState(session);
      if (getProviderPermissionId(providerState, provider) === permission) return s;
      const updated = updateSession(s.sessions, sessionId, {
        providerPermissions: { [provider]: permission },
      });
      if (!session.ephemeral) debouncedSave();
      return { sessions: updated };
    });
  },

  enqueuePrompt: (sessionId, prompt) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;
      const item = createQueuedPrompt(prompt);
      return { sessions: updateSession(s.sessions, sessionId, { promptQueue: [...session.promptQueue, item] }) };
    });
  },

  dequeuePrompt: (sessionId) => {
    let dequeued: QueuedPrompt | undefined;
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session || session.promptQueue.length === 0) return s;
      const [first, ...rest] = session.promptQueue;
      dequeued = first;
      return { sessions: updateSession(s.sessions, sessionId, { promptQueue: rest }) };
    });
    return dequeued;
  },

  removeQueuedPrompt: (sessionId, promptId) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;
      return { sessions: updateSession(s.sessions, sessionId, { promptQueue: session.promptQueue.filter((p) => p.id !== promptId) }) };
    });
  },

  clearQueue: (sessionId) => {
    set((s) => ({ sessions: updateSession(s.sessions, sessionId, { promptQueue: [] }) }));
  },

  // Hydrate an empty/shorter session from the authoritative provider snapshot.
  // Refuses to shrink existing history so a stale load can't clobber a live
  // session that has already accumulated turns.
  loadFromDisk: (sessionId, messages) => {
    const visibleMessages = sanitizeVisibleMessages(messages);
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;
      if (session.messages.length >= visibleMessages.length) {
        // Still flip the loaded flag — callers rely on it to stop "loading" UI.
        const hasUserTurn = visibleMessages.some((m) => m.role === "user") || session.promptCount > 0;
        return { sessions: updateSession(s.sessions, sessionId, {
          jsonlLoaded: true,
          providerLocked: session.providerLocked || hasUserTurn,
        }) };
      }
      const promptCount = visibleMessages.filter((m) => m.role === "user").length;
      return { sessions: updateSession(s.sessions, sessionId, {
        messages: visibleMessages,
        promptCount,
        hasBeenStarted: promptCount > 0,
        providerLocked: session.providerLocked || promptCount > 0,
        jsonlLoaded: true,
      }) };
    });
  },

  // Explicit refresh treats non-empty provider history as authoritative and
  // may shrink the visible transcript after rewind/truncate. Empty or missing
  // history still preserves live in-memory messages.
  replaceFromDisk: (sessionId, messages) => {
    const visibleMessages = sanitizeVisibleMessages(messages);
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;
      if (visibleMessages.length === 0) {
        return { sessions: updateSession(s.sessions, sessionId, { jsonlLoaded: true }) };
      }
      const promptCount = visibleMessages.filter((m) => m.role === "user").length;
      return { sessions: updateSession(s.sessions, sessionId, {
        messages: visibleMessages,
        promptCount,
        hasBeenStarted: promptCount > 0,
        providerLocked: session.providerLocked || promptCount > 0,
        jsonlLoaded: true,
      }) };
    });
  },

  refreshFromHistory: (sessionId, cwd) => hydrateSessionHistory(sessionId, cwd, "replace"),

  mergeFromDisk: (sessionId, incoming) => {
    const visibleIncoming = sanitizeVisibleMessages(incoming);
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;
      if (visibleIncoming.length === 0) return s;
      const existingIds = new Set(session.messages.map((m) => m.id));
      const toAppend = visibleIncoming.filter((m) => !existingIds.has(m.id));
      if (toAppend.length === 0) return s;
      const merged = [...session.messages, ...toAppend];
      const promptCount = merged.filter((m) => m.role === "user").length;
      return { sessions: updateSession(s.sessions, sessionId, {
        messages: merged,
        promptCount,
        hasBeenStarted: promptCount > 0,
        providerLocked: session.providerLocked || promptCount > 0,
        jsonlLoaded: true,
      }) };
    });
  },

  setDraftPrompt: (sessionId, text) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session || session.draftPrompt === text) return s;
      debouncedSave();
      return { sessions: updateSession(s.sessions, sessionId, { draftPrompt: text }) };
    });
  },

  setLoop: (sessionId, loop) => {
    set((s) => ({ sessions: updateSession(s.sessions, sessionId, { activeLoop: loop }) }));
  },

  tickLoop: (sessionId) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session?.activeLoop) return s;
      return { sessions: updateSession(s.sessions, sessionId, {
        activeLoop: { ...session.activeLoop, lastFiredAt: Date.now(), iteration: session.activeLoop.iteration + 1 },
      }) };
    });
  },

  addModifiedFiles: (sessionId, paths) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;
      const existing = new Set(session.modifiedFiles);
      const newPaths = paths.filter((p) => !existing.has(p));
      if (newPaths.length === 0) return s;
      return { sessions: updateSession(s.sessions, sessionId, { modifiedFiles: [...session.modifiedFiles, ...newPaths] }) };
    });
  },

  resetModifiedFiles: (sessionId) => {
    set((s) => ({ sessions: updateSession(s.sessions, sessionId, { modifiedFiles: [] }) }));
  },

  deleteSession: (sessionId) => {
    hydrationCache.delete(sessionId);
    set((s) => {
      const { [sessionId]: _, ...rest } = s.sessions;
      try {
        deletePersistedMeta(sessionId);
      } catch (e) {
        console.warn("[providerSessionStore] Failed to delete metadata:", e);
      }
      return { sessions: rest };
    });
  },

  setAutoCompactStatus: (sessionId, status) => {
    set((s) => ({ sessions: updateSession(s.sessions, sessionId, {
      autoCompactStatus: status,
      autoCompactStartedAt: status === "compacting" ? Date.now() : s.sessions[sessionId]?.autoCompactStartedAt ?? null,
    }) }));
  },

  setResumeAtUuid: (sessionId, uuid) => {
    set((s) => ({ sessions: updateSession(s.sessions, sessionId, { resumeAtUuid: uuid }) }));
  },

  setForkParentSessionId: (sessionId, parentId) => {
    set((s) => ({ sessions: updateSession(s.sessions, sessionId, { forkParentSessionId: parentId }) }));
  },

  truncateFromMessage: (sessionId, messageId) => {
    hydrationCache.delete(sessionId);
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;
      const idx = session.messages.findIndex((m) => m.id === messageId);
      if (idx < 0) return s;
      const messages = session.messages.slice(0, idx);
      const promptCount = messages.filter((m) => m.role === "user").length;
      const updated = updateSession(s.sessions, sessionId, {
        messages, promptCount, hasBeenStarted: promptCount > 0, streamingText: "", isStreaming: false, error: null,
        pendingPermission: null, pendingQuestions: null, activeLoop: null, promptQueue: [],
      });
      if (sessionNeedsLocalTranscriptSave(session)) debouncedSave();
      return { sessions: updated };
    });
  },

  addHookEvent: (sessionId, event) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;
      const log = session.hookEventLog.length >= 500
        ? [...session.hookEventLog.slice(-499), event]
        : [...session.hookEventLog, event];
      return { sessions: updateSession(s.sessions, sessionId, { hookEventLog: log }) };
    });
  },

  recordToolUsage: (sessionId, toolName) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;
      const stats = { ...session.toolUsageStats };
      stats[toolName] = (stats[toolName] || 0) + 1;
      return { sessions: updateSession(s.sessions, sessionId, { toolUsageStats: stats }) };
    });
  },

  incrementCompactionCount: (sessionId) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;
      return { sessions: updateSession(s.sessions, sessionId, { compactionCount: session.compactionCount + 1 }) };
    });
  },

  addSubagent: (sessionId, subagentId) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session || session.subagentIds.includes(subagentId)) return s;
      return { sessions: updateSession(s.sessions, sessionId, { subagentIds: [...session.subagentIds, subagentId] }) };
    });
  },

  removeSubagent: (sessionId, subagentId) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;
      const filtered = session.subagentIds.filter((id) => id !== subagentId);
      if (filtered.length === session.subagentIds.length) return s;
      return { sessions: updateSession(s.sessions, sessionId, { subagentIds: filtered }) };
    });
  },
}));

export const useProviderSessionStore = providerSessionStore;

// Provider routing selector. Returns "anthropic" for any unknown / missing
// session so the legacy Claude path stays the safe default.
export function selectSessionProvider(sessionId: string): ProviderId {
  const session = useProviderSessionStore.getState().sessions[sessionId];
  return resolveSessionProviderState(session).provider;
}

export function selectSessionProviderState(sessionId: string): ProviderSessionState {
  const session = useProviderSessionStore.getState().sessions[sessionId];
  return resolveSessionProviderState(session);
}

export function selectSessionProviderMetadata<P extends ProviderId>(
  sessionId: string,
  provider: P,
): ProviderSessionMetadataFor<P> | undefined {
  return getProviderSessionMetadata(selectSessionProviderState(sessionId), provider);
}

// Lightweight selector for voice/fuzzy session matching.
export function getSessionsForVoiceMatch(): { id: string; name: string }[] {
  const sessions = useProviderSessionStore.getState().sessions;
  const out: { id: string; name: string }[] = [];
  for (const s of Object.values(sessions)) {
    if (s.name && s.name.trim()) out.push({ id: s.sessionId, name: s.name });
  }
  return out;
}

// Emergency metadata flush on tab hide / close. Usually cheap provider UI
// metadata; providers without history may also include a bounded transcript.
export function flushSave() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (idleSaveHandle !== null) {
    cancelIdle(idleSaveHandle);
    idleSaveHandle = null;
  }
  savePending = false;
  saveToStorage(useProviderSessionStore.getState().sessions);
}

const visibilityHandler = () => { if (document.visibilityState === "hidden") flushSave(); };
if (typeof window !== "undefined") {
  document.addEventListener("visibilitychange", visibilityHandler);
  window.addEventListener("beforeunload", flushSave);

  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      document.removeEventListener("visibilitychange", visibilityHandler);
      window.removeEventListener("beforeunload", flushSave);
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
      if (idleSaveHandle !== null) {
        cancelIdle(idleSaveHandle);
        idleSaveHandle = null;
      }
    });
  }
}
