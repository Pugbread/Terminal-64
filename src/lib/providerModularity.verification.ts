import {
  buildProviderToolCall,
  getProviderToolDiff,
  getProviderToolFilePath,
  getProviderToolPaths,
  isProviderRuntimeEvent,
  providerRuntimeEventToNormalized,
} from "../contracts/providerEvents";
import type {
  ProviderHistoryCapability,
  ProviderRuntime,
  ProviderSessionRuntimeMetadata,
  ProviderTurnInput,
} from "../contracts/providerRuntime";
import {
  claudeBlockToProviderToolCall,
  claudeBlockToProviderToolResult,
} from "./claudeEventDecoder";
import {
  buildDelegationChildRuntimeMetadata,
  buildDelegationChildProviderTurnInput,
  buildDelegationMcpEnv,
  getDelegationMcpTransport,
  resolveDelegationChildRuntimePermission,
  resolveDelegationChildRuntimeSettings,
} from "./delegationChildRuntime";
import {
  buildDelegationChildSpawnPlan,
  buildDelegationPlanRequest,
  parseDelegateCommand,
  parseDelegationStartFromMessage,
} from "./delegationWorkflow";
import {
  CODEX_MAX_TURN_PROMPT_CHARS,
  codexPermissionForOverride,
  codexDropTurnsForKeepMessages,
  buildCodexCreateRequest,
  buildCodexSendRequest,
  promptWithCodexSeed,
} from "./providerRuntimes/openai";
import { buildCursorRequest } from "./providerRuntimes/cursor";
import { CursorLiveEventDecoder } from "./cursorEventDecoder";
import {
  codexInputChangedPaths,
  codexItemChangedPaths,
  codexItemDisplayName,
  codexItemInput,
  codexItemToProviderToolCall,
  codexItemToProviderToolResult,
} from "./codexEventDecoder";
import {
  decodeCodexPermission,
  defineProviderManifest,
  getProviderDefaultControlValues,
  getProviderDefaultEffort,
  getProviderDefaultModel,
  getProviderDefaultPermission,
  getProviderEffortOptions,
  getProviderHistoryPolicy,
  getProviderManifest,
  getProviderModelOptions,
  getProviderPermissionOptions,
  isProviderId,
  listProviderControls,
  PROVIDER_IDS,
  providerControlOptionValue,
  providerPersistsLocalTranscript,
  providerSupports,
  type PermissionOption,
  type ProviderControlKind,
  type ProviderControlValue,
  type ProviderId,
  type ProviderManifest,
  type ProviderManifestDefinition,
} from "./providers";
import {
  cancelProviderSession,
  closeProviderSession,
  deleteProviderHistory,
  getProviderRuntime,
  hydrateProviderHistory,
  prepareProviderFork,
  prepareProviderTurnInput,
  providerHistorySource,
  providerHistorySupports,
  providerTurnOperation,
  runProviderTurn,
  truncateProviderHistory,
} from "./providerRuntime";
import {
  getDefaultProviderPermissionId,
  getNextProviderPermissionId,
  getProviderPermissionInputPresentation,
  getProviderPermissionOption,
  isProviderPermissionId,
  permissionModeFromProviderPermission,
} from "./providerPermissions";
import { buildSpawnProviderTurnInput, mapHistoryMessages } from "./tauriApi";
import {
  getProviderSessionMetadata,
  getProviderSessionRuntimeMetadata,
  getOpenAiProviderSessionMetadata,
  getProviderPermissionId,
  getProviderRuntimeResumeId,
  resolveSessionProviderState,
  resolveProviderRuntimeResumeId,
  resolveProviderSessionMetadata,
  PROVIDER_SESSION_META_INDEX_KEY,
  PROVIDER_SESSION_META_ROW_PREFIX,
  STORAGE_KEY,
  flushSave,
  useProviderSessionStore,
  type ProviderSessionState,
} from "../stores/providerSessionStore";
import {
  getDefaultAvailableProvider,
  listAvailableProviderIds,
  useSettingsStore,
} from "../stores/settingsStore";
import {
  isGroupableToolCall,
  toolGroupKey,
  toolGroupItem,
  toolGroupLabel,
  toolHeader,
} from "../components/provider-chat/toolPresentation";
import { buildChatVisualRows } from "../components/provider-chat/useChatRows";
import type { CreateCodexRequest, ProviderCreateRequest, ProviderSendRequest } from "../contracts/providerIpc";
import type { ChatMessage } from "./types";

type VerificationResult = {
  name: string;
  ok: true;
};

type FutureProviderId = ProviderId | "opencode";
type FutureProviderManifest = ProviderManifest<FutureProviderId>;
type FutureProviderManifestDefinition = ProviderManifestDefinition<FutureProviderId>;
type FutureProviderRuntime = {
  provider: FutureProviderId;
  create: unknown;
  send: unknown;
  prepareTurn?: unknown;
  cancel: unknown;
  close: unknown;
  history: ProviderRuntime<ProviderId>["history"];
};
type FutureProviderSessionState = Omit<
  ProviderSessionState,
  "provider" | "runtimeMetadata" | "providerMetadata" | "providerPermissions" | "selectedControls"
> & {
  provider: FutureProviderId;
  runtimeMetadata: ProviderSessionState["runtimeMetadata"] & {
    opencode?: {
      historySource: "none";
      resume: { id: string | null };
      runtimePayload: Record<string, unknown>;
    };
  };
  selectedControls: ProviderSessionState["selectedControls"] & {
    opencode?: Record<string, ProviderControlValue>;
  };
  providerMetadata: ProviderSessionState["providerMetadata"] & {
    opencode?: {
      threadId: string | null;
      permissionProfile: string | null;
    };
  };
  providerPermissions: ProviderSessionState["providerPermissions"] & {
    opencode?: string | null;
  };
};
type FutureProviderCreateRequest =
  | ProviderCreateRequest
  | {
    provider: "opencode";
    req: {
      session_id: string;
      cwd: string;
      prompt: string;
      client_profile: "stub";
    };
  };

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`[provider verification] ${message}`);
  }
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  assert(Object.is(actual, expected), `${message}: expected ${String(expected)}, got ${String(actual)}`);
}

function assertNoUndefinedOwnValues(value: Record<string, unknown>, label: string): void {
  for (const [key, entry] of Object.entries(value)) {
    assert(entry !== undefined, `${label}.${key} should be omitted instead of set to undefined`);
  }
}

function providerMetaRowKey(sessionId: string): string {
  return `${PROVIDER_SESSION_META_ROW_PREFIX}${sessionId}`;
}

function clearProviderMetaRowsForFixture(): void {
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (key?.startsWith(PROVIDER_SESSION_META_ROW_PREFIX) || key === PROVIDER_SESSION_META_INDEX_KEY) {
      keys.push(key);
    }
  }
  for (const key of keys) {
    localStorage.removeItem(key);
  }
}

function snapshotProviderMetaRowsForFixture(): Record<string, string> {
  const snapshot: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (!key?.startsWith(PROVIDER_SESSION_META_ROW_PREFIX) && key !== PROVIDER_SESSION_META_INDEX_KEY) {
      continue;
    }
    const value = localStorage.getItem(key);
    if (value !== null) snapshot[key] = value;
  }
  return snapshot;
}

function restoreProviderMetaRowsForFixture(snapshot: Record<string, string>): void {
  clearProviderMetaRowsForFixture();
  for (const [key, value] of Object.entries(snapshot)) {
    localStorage.setItem(key, value);
  }
}

function assertNoLegacyProviderTurnFields(input: ProviderTurnInput, label: string): void {
  assert(!Object.prototype.hasOwnProperty.call(input, "selectedModel"), `${label} omits legacy selectedModel`);
  assert(!Object.prototype.hasOwnProperty.call(input, "selectedEffort"), `${label} omits legacy selectedEffort`);
  assert(!Object.prototype.hasOwnProperty.call(input, "threadId"), `${label} omits legacy threadId`);
  assert(!Object.prototype.hasOwnProperty.call(input, "codexThreadId"), `${label} omits legacy codexThreadId`);
}

const transcriptFixture: ChatMessage[] = [
  { id: "u1", role: "user", content: "open src/App.tsx", timestamp: 1 },
  {
    id: "a1",
    role: "assistant",
    content: "Found it.",
    timestamp: 2,
    toolCalls: [{ id: "tc1", name: "Read", input: { file_path: "src/App.tsx" } }],
  },
  { id: "u2", role: "user", content: "now edit it", timestamp: 3 },
  { id: "a2", role: "assistant", content: "Edited.", timestamp: 4 },
];

const futureProviderStubPermissions = [
  { id: "stub", label: "Stub", color: "#89b4fa", desc: "Not implemented" },
] satisfies PermissionOption[];

const futureProviderStubManifestDefinition = {
  id: "opencode",
  ui: {
    label: "OpenCode",
    shortLabel: "OpenCode",
    brandTitle: "OpenCode",
    emptyStateLabel: "OpenCode",
    defaultSessionName: "OpenCode",
    modelMenuLabel: "Model",
    effortMenuLabel: "Effort",
    inputPermissionSuffix: "profile",
  },
  capabilities: {
    mcp: false,
    plan: false,
    fork: false,
    rewind: false,
    images: false,
    hookLog: false,
    nativeSlashCommands: false,
    compact: false,
  },
  delegation: {
    mcpTransport: "env",
    skipOpenwolf: "always",
    noSessionPersistence: false,
    skipGitRepoCheck: true,
    planner: {
      permissionOverride: "inherit",
    },
    childRuntime: {
      permissionPreset: "selected",
    },
  },
  permissionControl: {
    persistence: "provider-state",
  },
  history: {
    source: "none",
    hydrateFailureLabel: "OpenCode",
  },
  controls: [
      {
        id: "model",
        label: "Model",
        kind: "select",
        scope: "topbar",
        defaultValue: "stub-model",
        options: [{ id: "stub-model", label: "Stub Model" }],
        legacySlot: "model",
      },
      {
        id: "effort",
        label: "Effort",
        kind: "select",
        scope: "topbar",
        defaultValue: "stub-effort",
        options: [{ id: "stub-effort", label: "Stub Effort" }],
        legacySlot: "effort",
      },
      {
        id: "permission",
        label: "Profile",
        kind: "select",
        scope: "composer",
        defaultValue: "stub",
        options: futureProviderStubPermissions,
        inputSuffix: "profile",
        legacySlot: "permission",
      },
  ],
} satisfies FutureProviderManifestDefinition;

// @ts-expect-error provider manifest definitions derive compatibility fields from controls.
const duplicateFutureProviderManifestDefinition = { ...futureProviderStubManifestDefinition, defaultModel: "stub-model" } satisfies FutureProviderManifestDefinition;
void duplicateFutureProviderManifestDefinition;

const futureProviderStubManifest = defineProviderManifest(futureProviderStubManifestDefinition);

function unsupportedFutureProvider(provider: FutureProviderId, operation: string): Error {
  return new Error(`Provider ${provider} has no ${operation} runtime binding`);
}

function createUnsupportedFutureRuntime(provider: FutureProviderId): FutureProviderRuntime {
  return {
    provider,
    create: async () => {
      throw unsupportedFutureProvider(provider, "create");
    },
    send: async () => {
      throw unsupportedFutureProvider(provider, "send");
    },
    cancel: async () => {
      throw unsupportedFutureProvider(provider, "cancel");
    },
    close: async () => {
      throw unsupportedFutureProvider(provider, "close");
    },
    history: {
      source: "none",
      capabilities: {
        hydrate: false,
        fork: false,
        rewind: false,
        delete: false,
      },
    },
  };
}

function providerInput<TProvider extends ProviderId = "openai">(
  overrides: Partial<ProviderTurnInput<TProvider>> & { provider?: TProvider } = {},
): ProviderTurnInput<TProvider> {
  const provider = overrides.provider ?? ("openai" as TProvider);
  return {
    provider,
    sessionId: "session-1",
    cwd: "/repo",
    prompt: "hello",
    started: false,
    ...overrides,
  };
}

function providerTurnRuntimeMetadata(provider: ProviderId, resumeId: string | null): ProviderSessionRuntimeMetadata {
  return {
    historySource: getProviderHistoryPolicy(provider).source,
    resume: { id: resumeId },
    runtimePayload: {},
  };
}

const providerLifecycleOperations = ["create", "send", "cancel", "close"] as const;
const providerHistoryCapabilities: ProviderHistoryCapability[] = ["hydrate", "fork", "rewind", "delete"];
const providerControlKinds: readonly ProviderControlKind[] = ["select", "boolean", "text", "number"];
type ProviderHistoryHandlerName = "hydrate" | "fork" | "rewind" | "deleteHistory";
const providerHistoryHandlerNames = {
  hydrate: "hydrate",
  fork: "fork",
  rewind: "rewind",
  delete: "deleteHistory",
} satisfies Record<ProviderHistoryCapability, ProviderHistoryHandlerName>;

function assertProviderManifestCompatibilityFieldsAreDerived(provider: ProviderId): void {
  const manifest = getProviderManifest(provider);
  assert(manifest.models === getProviderModelOptions(provider), `${provider} compatibility models are derived from controls`);
  assert(manifest.efforts === getProviderEffortOptions(provider), `${provider} compatibility efforts are derived from controls`);
  assert(manifest.permissions === getProviderPermissionOptions(provider), `${provider} compatibility permissions are derived from controls`);
  assertEqual(manifest.defaultModel, getProviderDefaultModel(provider), `${provider} compatibility default model is derived`);
  assertEqual(manifest.defaultEffort, getProviderDefaultEffort(provider), `${provider} compatibility default effort is derived`);
  assertEqual(manifest.defaultPermission, getProviderDefaultPermission(provider), `${provider} compatibility default permission is derived`);
}

function assertProviderControlDescriptorsAreGeneric(provider: ProviderId): void {
  const controls = listProviderControls(provider);
  const defaults = getProviderDefaultControlValues(provider);
  assert(controls.length > 0, `${provider} exposes generic provider controls`);
  for (const control of controls) {
    assert(typeof control.id === "string" && control.id.length > 0, `${provider} control has an id`);
    assert(typeof control.label === "string" && control.label.length > 0, `${provider} control ${control.id} has a label`);
    assert(providerControlKinds.includes(control.kind), `${provider} control ${control.id} declares a generic kind`);
    assert(control.scope === "topbar" || control.scope === "composer", `${provider} control ${control.id} declares a generic scope`);
    assert(
      typeof control.defaultValue === "string"
        || typeof control.defaultValue === "boolean"
        || typeof control.defaultValue === "number",
      `${provider} control ${control.id} has a typed default value`,
    );
    assert(defaults[control.id] === control.defaultValue, `${provider} default control values derive from descriptors`);
    if (control.kind === "select") {
      assert(control.options.some((option) => providerControlOptionValue(option) === control.defaultValue), `${provider} control ${control.id} default is listed`);
    }
    for (const option of control.options) {
      assert(typeof option.id === "string" && option.id.length > 0, `${provider} control ${control.id} option has an id`);
      assert(typeof option.label === "string" && option.label.length > 0, `${provider} control ${control.id} option has a label`);
    }
  }
}

export function verifyProviderManifestDefaults(): VerificationResult {
  const anthropic = getProviderManifest("anthropic");
  const openai = getProviderManifest("openai");
  const cursor = getProviderManifest("cursor");

  assertProviderManifestCompatibilityFieldsAreDerived("anthropic");
  assertProviderControlDescriptorsAreGeneric("anthropic");
  assertEqual(getProviderDefaultModel("anthropic"), "sonnet", "Anthropic default model");
  assertEqual(getProviderDefaultEffort("anthropic"), "high", "Anthropic default effort");
  assertEqual(getProviderDefaultPermission("anthropic"), "default", "Anthropic default permission");
  assert(getProviderModelOptions("anthropic").some((model) => model.id === getProviderDefaultModel("anthropic")), "Anthropic default model is listed");
  assert(getProviderEffortOptions("anthropic").some((effort) => effort.id === getProviderDefaultEffort("anthropic")), "Anthropic default effort is listed");
  assert(isProviderPermissionId("anthropic", getProviderDefaultPermission("anthropic")), "Anthropic default permission is listed");
  assertEqual(anthropic.delegation.mcpTransport, "temp-config", "Anthropic delegation MCP transport is manifest-owned");
  assertEqual(anthropic.delegation.skipOpenwolf, "inherit", "Anthropic delegation inherits OpenWolf setting");
  assertEqual(anthropic.delegation.planner.permissionOverride, "inherit", "Anthropic delegation planner inherits explicit overrides");
  assertEqual(
    anthropic.delegation.childRuntime.permissionPreset,
    "bypass_all",
    "Anthropic delegation metadata records bypass permission",
  );
  assertEqual(anthropic.permissionControl.persistence, "provider-state", "Anthropic permission control uses provider state");
  assertEqual(
    anthropic.permissionControl.skipPermissionId,
    "bypass_all",
    "Anthropic skip-permissions preset is manifest-owned",
  );
  assertEqual(anthropic.history.source, "claude-jsonl", "Anthropic history source is manifest-owned");
  assertEqual(getProviderHistoryPolicy("anthropic").source, "claude-jsonl", "Anthropic history policy helper uses manifest source");
  assert(!providerPersistsLocalTranscript("anthropic"), "Anthropic does not persist local transcripts");

  assertProviderManifestCompatibilityFieldsAreDerived("openai");
  assertProviderControlDescriptorsAreGeneric("openai");
  assertEqual(getProviderDefaultModel("openai"), "gpt-5.5", "OpenAI default model");
  assertEqual(getProviderDefaultEffort("openai"), "medium", "OpenAI default effort");
  assertEqual(getProviderDefaultPermission("openai"), "workspace", "OpenAI default permission");
  assert(getProviderModelOptions("openai").some((model) => model.id === getProviderDefaultModel("openai")), "OpenAI default model is listed");
  assert(getProviderEffortOptions("openai").some((effort) => effort.id === getProviderDefaultEffort("openai")), "OpenAI default effort is listed");
  assert(isProviderPermissionId("openai", getProviderDefaultPermission("openai")), "OpenAI default permission is listed");
  assertEqual(openai.delegation.mcpTransport, "env", "OpenAI delegation MCP transport is manifest-owned");
  assertEqual(openai.delegation.skipOpenwolf, "always", "OpenAI delegation always skips OpenWolf bootstrap");
  assertEqual(openai.delegation.planner.permissionOverride, "inherit", "OpenAI delegation planner inherits explicit overrides");
  assertEqual(
    openai.delegation.childRuntime.permissionPreset,
    "selected",
    "OpenAI delegation metadata records selected permission preset",
  );
  assertEqual(openai.permissionControl.persistence, "provider-state", "OpenAI permission control uses provider state");
  assertEqual(openai.history.source, "codex-rollout", "OpenAI history source is manifest-owned");
  assert(!providerPersistsLocalTranscript("openai"), "OpenAI does not persist local transcripts");
  assert(providerSupports("openai", "fork"), "OpenAI manifest advertises fork support");
  assert(providerSupports("openai", "rewind"), "OpenAI manifest advertises rewind support");
  assert(!providerSupports("openai", "hookLog"), "OpenAI manifest does not expose Claude hook log");

  assertProviderManifestCompatibilityFieldsAreDerived("cursor");
  assertProviderControlDescriptorsAreGeneric("cursor");
  assertEqual(getProviderDefaultModel("cursor"), "composer-2-fast", "Cursor default model");
  assertEqual(getProviderDefaultEffort("cursor"), "default", "Cursor default effort");
  assertEqual(getProviderDefaultPermission("cursor"), "default", "Cursor default permission");
  assert(getProviderModelOptions("cursor").some((model) => model.id === getProviderDefaultModel("cursor")), "Cursor default model is listed");
  assert(getProviderEffortOptions("cursor").some((effort) => effort.id === getProviderDefaultEffort("cursor")), "Cursor default effort is listed");
  assert(isProviderPermissionId("cursor", getProviderDefaultPermission("cursor")), "Cursor default permission is listed");
  assertEqual(cursor.delegation.mcpTransport, "env", "Cursor delegation MCP transport is manifest-owned");
  assertEqual(cursor.delegation.skipOpenwolf, "always", "Cursor delegation skips OpenWolf bootstrap");
  assertEqual(cursor.delegation.planner.permissionOverride, "bypass_all", "Cursor delegation planner uses manifest-owned force mode");
  assertEqual(cursor.permissionControl.persistence, "provider-state", "Cursor permission control uses provider state");
  assertEqual(cursor.history.source, "local-transcript", "Cursor local transcript source is manifest-owned");
  assert(providerPersistsLocalTranscript("cursor"), "Cursor persists local transcript by manifest history source");
  assert(!providerSupports("cursor", "fork"), "Cursor manifest fails closed on fork until history support exists");
  assert(!providerSupports("cursor", "rewind"), "Cursor manifest fails closed on rewind until history support exists");

  return { name: "provider manifest defaults", ok: true };
}

export function verifyProviderStateMigrationFixture(): VerificationResult {
  assert(typeof localStorage !== "undefined", "providerState migration fixture requires browser localStorage");

  const sessionId = "provider-verification-legacy-openai";
  const stateSessionId = "provider-verification-state-openai";
  const cursorSessionId = "provider-verification-cursor-local";
  const recoveredOpenAiSessionId = "provider-verification-recovered-openai";
  const recoveredCursorSessionId = "provider-verification-recovered-cursor";
  const freshOpenAiFallbackSessionId = "provider-verification-fresh-openai-fallback";
  const futureSchemaSessionId = "provider-verification-future-schema";
  const currentAfterFutureSchemaId = "provider-verification-current-after-future";
  const previousStorage = localStorage.getItem(STORAGE_KEY);
  const previousRowStorage = snapshotProviderMetaRowsForFixture();
  const previousSessions = useProviderSessionStore.getState().sessions;

  try {
    clearProviderMetaRowsForFixture();
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      [sessionId]: {
        sessionId,
        name: "Legacy Codex",
        cwd: "",
        draftPrompt: "draft",
        lastSeenAt: 1,
        schemaVersion: 4,
        provider: "openai",
        codexThreadId: "thread-legacy",
        selectedModel: "gpt-5.4",
        selectedEffort: "high",
        selectedCodexPermission: "yolo",
        seedTranscript: transcriptFixture.slice(0, 2),
      },
      [stateSessionId]: {
        sessionId: stateSessionId,
        name: "Provider State Wins",
        cwd: "",
        draftPrompt: "",
        lastSeenAt: 2,
        schemaVersion: 5,
        providerState: {
          provider: "openai",
          providerLocked: true,
          selectedModel: "gpt-5.5",
          selectedEffort: "medium",
          seedTranscript: null,
          runtimeMetadata: {
            openai: {
              historySource: "codex-rollout",
              resume: { id: "thread-provider-runtime" },
              runtimePayload: {
                codexThreadId: "thread-provider-runtime",
              },
            },
          },
          providerMetadata: {
            openai: {
              codexThreadId: "thread-provider-state",
            },
          },
          providerPermissions: {
            openai: "workspace",
          },
        },
        provider: "anthropic",
        codexThreadId: "thread-legacy-mirror",
        selectedModel: "sonnet",
        selectedEffort: "high",
        selectedCodexPermission: "yolo",
      },
      [cursorSessionId]: {
        sessionId: cursorSessionId,
        name: "Cursor Local",
        cwd: "",
        draftPrompt: "",
        lastSeenAt: 3,
        schemaVersion: 6,
        providerState: {
          provider: "cursor",
          providerLocked: true,
          selectedModel: "composer-2-fast",
          selectedEffort: "default",
          seedTranscript: null,
          runtimeMetadata: {
            cursor: {
              historySource: "local-transcript",
              resume: { id: "cursor-chat-runtime" },
              runtimePayload: {
                cursorChatId: "cursor-chat-runtime",
                localTranscript: transcriptFixture.slice(0, 2),
              },
            },
          },
          providerMetadata: {},
        },
        provider: "cursor",
        providerLocked: true,
      },
      [recoveredOpenAiSessionId]: {
        sessionId: recoveredOpenAiSessionId,
        name: "Recovered OpenAI",
        cwd: "",
        draftPrompt: "",
        lastSeenAt: 4,
        schemaVersion: 6,
        providerState: {
          provider: "anthropic",
          providerLocked: true,
          selectedModel: "sonnet",
          selectedEffort: "high",
          seedTranscript: null,
          runtimeMetadata: {},
          providerMetadata: {
            openai: {
              codexThreadId: "thread-recovered",
            },
          },
          providerPermissions: {
            openai: "workspace",
          },
          selectedControls: {
            openai: {
              model: "gpt-5.5",
              effort: "medium",
              sandbox: "workspace",
            },
          },
        },
        provider: "anthropic",
      },
      [recoveredCursorSessionId]: {
        sessionId: recoveredCursorSessionId,
        name: "Recovered Cursor",
        cwd: "",
        draftPrompt: "",
        lastSeenAt: 5,
        schemaVersion: 6,
        providerState: {
          provider: "anthropic",
          providerLocked: true,
          selectedModel: "sonnet",
          selectedEffort: "high",
          seedTranscript: null,
          runtimeMetadata: {},
          providerMetadata: {},
          providerPermissions: {
            cursor: "default",
          },
          selectedControls: {
            cursor: {
              model: "composer-2-fast",
              mode: "ask",
              "apply-mode": "default",
            },
          },
        },
        provider: "anthropic",
        localTranscript: transcriptFixture.slice(0, 2),
      },
      [freshOpenAiFallbackSessionId]: {
        sessionId: freshOpenAiFallbackSessionId,
        name: "Fresh Codex Fallback",
        cwd: "",
        draftPrompt: "",
        lastSeenAt: 6,
        schemaVersion: 6,
        providerState: {
          provider: "openai",
          providerLocked: true,
          selectedModel: "gpt-5.5",
          selectedEffort: "medium",
          seedTranscript: null,
          runtimeMetadata: {
            openai: {
              historySource: "codex-rollout",
              resume: { id: null },
              runtimePayload: {
                localTranscript: transcriptFixture.slice(0, 2),
              },
            },
          },
          providerMetadata: {},
          providerPermissions: {
            openai: "workspace",
          },
          selectedControls: {
            openai: {
              model: "gpt-5.5",
              effort: "medium",
              sandbox: "workspace",
            },
          },
        },
        provider: "openai",
      },
      [futureSchemaSessionId]: {
        sessionId: futureSchemaSessionId,
        name: "Future Schema",
        cwd: "",
        draftPrompt: "",
        lastSeenAt: 7,
        schemaVersion: 999,
        provider: "anthropic",
        futureOnlyField: "preserve-me",
      },
    }));
    useProviderSessionStore.setState({ sessions: {} });
    useProviderSessionStore.getState().createSession(sessionId);
    useProviderSessionStore.getState().createSession(stateSessionId, undefined, false, undefined, undefined, "anthropic", false);
    useProviderSessionStore.getState().createSession(cursorSessionId, undefined, false, undefined, undefined, "anthropic", false);
    useProviderSessionStore.getState().createSession(recoveredOpenAiSessionId);
    useProviderSessionStore.getState().createSession(recoveredCursorSessionId);
    useProviderSessionStore.getState().createSession(freshOpenAiFallbackSessionId);
    useProviderSessionStore.getState().createSession(currentAfterFutureSchemaId, "Current After Future", false, undefined, undefined, "openai", false);
    const immediateSavedAfterCreate = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") as Record<string, {
      name?: string;
      provider?: ProviderId;
    }>;
    assertEqual(
      immediateSavedAfterCreate[currentAfterFutureSchemaId]?.name,
      "Current After Future",
      "explicit named provider sessions save synchronously on create",
    );
    assertEqual(
      immediateSavedAfterCreate[currentAfterFutureSchemaId]?.provider,
      "openai",
      "explicit provider sessions persist selected provider immediately",
    );
    const immediateSavedRowAfterCreate = JSON.parse(localStorage.getItem(providerMetaRowKey(currentAfterFutureSchemaId)) || "{}") as {
      name?: string;
      provider?: ProviderId;
    };
    assertEqual(
      immediateSavedRowAfterCreate.name,
      "Current After Future",
      "explicit named provider sessions write a row-level metadata upsert",
    );
    assertEqual(
      immediateSavedRowAfterCreate.provider,
      "openai",
      "explicit provider sessions persist selected provider in row-level metadata",
    );
    const migrated = useProviderSessionStore.getState().sessions[sessionId];
    const stateBacked = useProviderSessionStore.getState().sessions[stateSessionId];
    const cursorBacked = useProviderSessionStore.getState().sessions[cursorSessionId];
    const recoveredOpenAi = useProviderSessionStore.getState().sessions[recoveredOpenAiSessionId];
    const recoveredCursor = useProviderSessionStore.getState().sessions[recoveredCursorSessionId];
    const freshOpenAiFallback = useProviderSessionStore.getState().sessions[freshOpenAiFallbackSessionId];

    assert(migrated, "legacy OpenAI metadata creates a session");
    assertEqual(migrated.providerState.provider, "openai", "legacy provider migrates into providerState");
    assertEqual(migrated.providerState.providerLocked, true, "legacy saved metadata locks migrated provider");
    assertEqual(migrated.providerLocked, true, "legacy provider lock mirror migrates");
    const migratedOpenAi = getOpenAiProviderSessionMetadata(migrated.providerState);
    assertEqual(migratedOpenAi?.codexThreadId, "thread-legacy", "legacy Codex thread id migrates");
    assertEqual(getProviderPermissionId(migrated.providerState, "openai"), "yolo", "legacy Codex permission migrates");
    assertEqual(migrated.providerState.selectedModel, "gpt-5.4", "legacy selected model migrates");
    assertEqual(migrated.providerState.selectedEffort, "high", "legacy selected effort migrates");
    assertEqual(migrated.providerState.selectedControls.openai?.model, "gpt-5.4", "legacy selected model seeds OpenAI control value");
    assertEqual(migrated.providerState.selectedControls.openai?.effort, "high", "legacy selected effort seeds OpenAI control value");
    assertEqual(migrated.providerState.selectedControls.openai?.sandbox, "yolo", "legacy Codex permission seeds OpenAI permission control");
    assertEqual(migrated.messages.length, 2, "legacy seed transcript hydrates into visible messages");
    assertEqual(migrated.codexThreadId, migratedOpenAi?.codexThreadId ?? null, "compat thread mirror matches providerState");

    assert(stateBacked, "schema v5 metadata creates a providerState-backed session");
    assertEqual(stateBacked.providerState.provider, "openai", "providerState provider wins over stale flat provider");
    assertEqual(stateBacked.provider, "openai", "persisted provider wins over mount-time default provider");
    assertEqual(stateBacked.providerState.providerLocked, true, "providerState lock flag wins over saved metadata");
    assertEqual(stateBacked.providerLocked, true, "provider lock mirror follows providerState");
    const stateBackedOpenAi = getOpenAiProviderSessionMetadata(stateBacked.providerState);
    assertEqual(stateBackedOpenAi?.codexThreadId, "thread-provider-runtime", "runtime metadata thread id wins over stale flat mirror");
    assertEqual(getProviderRuntimeResumeId(stateBacked.providerState, "openai"), "thread-provider-runtime", "OpenAI runtime metadata stores resume id");
    assertEqual(getProviderPermissionId(stateBacked.providerState, "openai"), "workspace", "providerState permission wins from providerPermissions over stale flat mirror");
    assertEqual(stateBacked.providerState.selectedModel, "gpt-5.5", "providerState selected model wins over stale flat mirror");

    assert(cursorBacked, "Cursor local transcript metadata creates a session");
    assertEqual(cursorBacked.providerState.provider, "cursor", "Cursor provider state hydrates from metadata");
    assertEqual(cursorBacked.provider, "cursor", "Cursor provider survives mount-time default provider after refresh");
    assertEqual(getProviderRuntimeResumeId(cursorBacked.providerState, "cursor"), "cursor-chat-runtime", "Cursor runtime metadata stores chat resume id");
    assertEqual(cursorBacked.providerState.selectedControls.cursor?.mode, "default", "legacy Cursor selected effort migrates to provider-owned mode control");
    assertEqual(cursorBacked.providerState.selectedEffort, null, "Cursor mode is not mirrored as selectedEffort");
    assertEqual(cursorBacked.messages.length, 2, "Cursor runtime local transcript hydrates into visible messages");

    assert(recoveredOpenAi, "corrupted OpenAI metadata creates a session");
    assertEqual(recoveredOpenAi.providerState.provider, "openai", "OpenAI thread metadata recovers provider after bad Anthropic refresh save");
    assertEqual(
      getOpenAiProviderSessionMetadata(recoveredOpenAi.providerState)?.codexThreadId,
      "thread-recovered",
      "recovered OpenAI metadata keeps Codex thread id",
    );

    assert(recoveredCursor, "corrupted Cursor metadata creates a session");
    assertEqual(recoveredCursor.providerState.provider, "cursor", "Cursor local transcript/control metadata recovers provider after bad Anthropic refresh save");
    assertEqual(recoveredCursor.providerState.selectedControls.cursor?.mode, "ask", "recovered Cursor keeps provider-owned mode control");

    assert(freshOpenAiFallback, "fresh OpenAI local fallback metadata creates a session");
    assertEqual(freshOpenAiFallback.providerState.provider, "openai", "fresh OpenAI fallback keeps provider");
    assertEqual(freshOpenAiFallback.messages.length, 2, "fresh OpenAI fallback transcript hydrates into visible messages");
    assertEqual(freshOpenAiFallback.providerState.seedTranscript?.length, 2, "fresh OpenAI fallback seeds next fresh thread");
    assertEqual(freshOpenAiFallback.hasBeenStarted, true, "fresh OpenAI fallback opens as a started conversation");

    flushSave();
    const savedAfterFutureSchema = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") as Record<string, {
      schemaVersion?: number;
      futureOnlyField?: string;
    }>;
    assert(savedAfterFutureSchema[currentAfterFutureSchemaId], "new current-schema sessions still save when a future-schema row exists");
    assertEqual(savedAfterFutureSchema[futureSchemaSessionId]?.schemaVersion, 999, "future-schema row stays preserved");
    assertEqual(savedAfterFutureSchema[futureSchemaSessionId]?.futureOnlyField, "preserve-me", "future-schema row unknown fields survive save");

    useProviderSessionStore.getState().addUserMessage(cursorSessionId, "persist this");
    useProviderSessionStore.getState().finalizeAssistantMessage(cursorSessionId, "persisted");
    flushSave();
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") as Record<string, {
      localTranscript?: ChatMessage[];
      selectedCodexPermission?: string | null;
      providerPermissions?: Record<string, string | null>;
      providerState?: {
        runtimeMetadata?: {
          openai?: { resume?: { id?: string | null }; runtimePayload?: { codexThreadId?: string | null; localTranscript?: ChatMessage[] } };
          cursor?: { resume?: { id?: string | null }; runtimePayload?: { localTranscript?: ChatMessage[] } };
        };
        providerMetadata?: {
          openai?: { selectedCodexPermission?: string | null };
        };
      };
    }>;
    const savedCursorTranscript =
      saved[cursorSessionId]?.providerState?.runtimeMetadata?.cursor?.runtimePayload?.localTranscript ?? [];
    const savedOpenAiTranscript =
      saved[sessionId]?.providerState?.runtimeMetadata?.openai?.runtimePayload?.localTranscript ?? [];
    assertEqual(savedCursorTranscript.length, 4, "Cursor transcript writes back to metadata");
    assertEqual(savedCursorTranscript[3]?.content, "persisted", "Cursor assistant message persists locally");
    assertEqual(savedOpenAiTranscript.length, 2, "OpenAI saves a bounded fallback transcript with provider runtime metadata");
    assertEqual(saved[cursorSessionId]?.localTranscript, undefined, "Cursor save drops legacy flat local transcript");
    assertEqual(saved[sessionId]?.localTranscript, undefined, "OpenAI save drops legacy flat local transcript");
    assertEqual(saved[stateSessionId]?.localTranscript, undefined, "Provider-state OpenAI transcript stays out of local metadata");
    assertEqual(
      saved[stateSessionId]?.providerState?.runtimeMetadata?.openai?.runtimePayload?.codexThreadId,
      "thread-provider-runtime",
      "OpenAI save keeps Codex thread id in runtime payload",
    );
    assertEqual(saved[sessionId]?.providerPermissions?.openai, "yolo", "OpenAI permission writes through providerPermissions");
    assertEqual(saved[sessionId]?.selectedCodexPermission, undefined, "OpenAI save drops legacy flat Codex permission");
    assertEqual(
      saved[sessionId]?.providerState?.providerMetadata?.openai?.selectedCodexPermission,
      undefined,
      "OpenAI provider metadata no longer stores permission ids",
    );

    const originalSetItem = Storage.prototype.setItem;
    let quotaThrowRemaining = 2;
    Storage.prototype.setItem = function setItemWithQuotaOnce(this: Storage, key: string, value: string): void {
      if (key === STORAGE_KEY && quotaThrowRemaining > 0) {
        quotaThrowRemaining -= 1;
        throw new DOMException("quota fixture", "QuotaExceededError");
      }
      originalSetItem.call(this, key, value);
    };
    try {
      useProviderSessionStore.getState().addUserMessage(sessionId, "quota compact save keeps Codex fallback");
    } finally {
      Storage.prototype.setItem = originalSetItem;
    }
    const compactSaved = JSON.parse(localStorage.getItem(providerMetaRowKey(sessionId)) || "{}") as {
      providerState?: {
        runtimeMetadata?: {
          openai?: { runtimePayload?: { localTranscript?: ChatMessage[] } };
        };
      };
    };
    const compactOpenAiTranscript =
      compactSaved.providerState?.runtimeMetadata?.openai?.runtimePayload?.localTranscript ?? [];
    assert(
      compactOpenAiTranscript.some((message) => message.content === "quota compact save keeps Codex fallback"),
      "row-level metadata preserves active OpenAI local transcript when the legacy aggregate write fails",
    );

    const hotReloadFallback = resolveSessionProviderState({
      provider: "openai",
      providerLocked: true,
      codexThreadId: "thread-hot-reload",
      selectedModel: "gpt-5.4-mini",
      selectedEffort: "low",
      selectedCodexPermission: "full-auto",
      seedTranscript: transcriptFixture.slice(0, 1),
    });
    assertEqual(hotReloadFallback.provider, "openai", "hot-reloaded flat provider falls back into providerState");
    assertEqual(hotReloadFallback.providerLocked, true, "hot-reloaded flat provider lock falls back into providerState");
    const hotReloadFallbackOpenAi = getOpenAiProviderSessionMetadata(hotReloadFallback);
    assertEqual(hotReloadFallbackOpenAi?.codexThreadId, "thread-hot-reload", "hot-reloaded flat thread id falls back into providerState");
    assertEqual(getProviderRuntimeResumeId(hotReloadFallback, "openai"), "thread-hot-reload", "hot-reloaded flat thread id migrates into runtime metadata");
    assertEqual(getProviderPermissionId(hotReloadFallback, "openai"), "full-auto", "hot-reloaded flat permission falls back into providerState");

    return { name: "providerState legacy migration", ok: true };
  } finally {
    useProviderSessionStore.setState({ sessions: previousSessions });
    if (previousStorage === null) {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, previousStorage);
    }
    restoreProviderMetaRowsForFixture(previousRowStorage);
  }
}

export function verifyProviderPickerLockFixtures(): VerificationResult {
  assert(typeof localStorage !== "undefined", "provider picker fixture requires browser localStorage");

  const previousStorage = localStorage.getItem(STORAGE_KEY);
  const previousRowStorage = snapshotProviderMetaRowsForFixture();
  const previousSessions = useProviderSessionStore.getState().sessions;
  const store = useProviderSessionStore.getState();

  try {
    clearProviderMetaRowsForFixture();
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      "picker-cache-prime": {
        sessionId: "picker-cache-prime",
        name: "Cache Prime",
        cwd: "",
        draftPrompt: "",
        lastSeenAt: 0,
        schemaVersion: 4,
        provider: "anthropic",
      },
    }));
    useProviderSessionStore.setState({ sessions: {} });
    store.createSession("picker-cache-prime");

    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      "picker-legacy-openai": {
        sessionId: "picker-legacy-openai",
        name: "Legacy OpenAI",
        cwd: "",
        draftPrompt: "",
        lastSeenAt: 1,
        schemaVersion: 4,
        provider: "openai",
        codexThreadId: "thread-legacy-picker",
        selectedModel: "gpt-5.4",
        selectedEffort: "high",
        selectedCodexPermission: "workspace",
      },
      "picker-saved-openai": {
        sessionId: "picker-saved-openai",
        name: "Saved OpenAI",
        cwd: "",
        draftPrompt: "",
        lastSeenAt: 2,
        schemaVersion: 5,
        providerState: {
          provider: "openai",
          providerLocked: true,
          selectedModel: "gpt-5.5",
          selectedEffort: "medium",
          seedTranscript: null,
          providerMetadata: {
            openai: {
              codexThreadId: "thread-saved-picker",
            },
          },
          providerPermissions: {
            openai: "full-auto",
          },
        },
      },
    }));
    useProviderSessionStore.setState({ sessions: {} });

    store.createSession("picker-blank", undefined, true);
    let blank = useProviderSessionStore.getState().sessions["picker-blank"];
    assert(blank, "blank user-created session exists");
    assertEqual(blank.providerState.provider, "anthropic", "blank user-created session defaults to Claude");
    assertEqual(blank.providerState.providerLocked, false, "blank user-created session starts provider-unlocked");

    assertEqual(store.switchProviderBeforeStart("picker-blank", "openai"), true, "blank session can switch to OpenAI before first send");
    blank = useProviderSessionStore.getState().sessions["picker-blank"];
    assert(blank, "switched blank session still exists");
    assertEqual(blank.providerState.provider, "openai", "pre-send provider picker writes providerState provider");
    assertEqual(blank.provider, "openai", "pre-send provider picker writes compatibility provider mirror");
    assertEqual(blank.providerState.providerLocked, false, "pre-send provider switch keeps session unlocked");
    assertEqual(blank.providerState.selectedModel, getProviderDefaultModel("openai"), "pre-send provider switch resets default model");
    assertEqual(blank.providerState.selectedEffort, getProviderDefaultEffort("openai"), "pre-send provider switch resets default effort");
    assertEqual(blank.providerState.selectedControls.openai?.model, getProviderDefaultModel("openai"), "pre-send provider switch seeds model control");
    assertEqual(blank.providerState.selectedControls.openai?.effort, getProviderDefaultEffort("openai"), "pre-send provider switch seeds effort control");
    assertEqual(getProviderPermissionId(blank.providerState, "openai"), getProviderDefaultPermission("openai"), "pre-send provider switch resets provider permission");
    assertEqual(
      providerTurnOperation(providerInput({
        provider: blank.providerState.provider,
        started: blank.hasBeenStarted && blank.promptCount > 0,
        selectedModel: blank.providerState.selectedModel,
        selectedEffort: blank.providerState.selectedEffort,
        selectedControls: blank.providerState.selectedControls.openai,
        providerPermissionId: getProviderPermissionId(blank.providerState, "openai"),
      })),
      "create",
      "first send from provider-picked blank session routes through create for selected provider",
    );

    store.addUserMessage("picker-blank", "hello");
    blank = useProviderSessionStore.getState().sessions["picker-blank"];
    assert(blank, "blank session survives first user message");
    assertEqual(blank.providerState.providerLocked, true, "first user message locks selected provider");
    assertEqual(store.switchProviderBeforeStart("picker-blank", "anthropic"), false, "first-send-locked session rejects later provider switch");
    assertEqual(useProviderSessionStore.getState().sessions["picker-blank"]?.providerState.provider, "openai", "rejected provider switch preserves selected provider");

    store.createSession("picker-count-lock", undefined, true);
    assertEqual(store.switchProviderBeforeStart("picker-count-lock", "openai"), true, "second blank session can switch before prompt count increments");
    store.incrementPromptCount("picker-count-lock");
    const counted = useProviderSessionStore.getState().sessions["picker-count-lock"];
    assert(counted, "prompt-count lock fixture exists");
    assertEqual(counted.hasBeenStarted, true, "prompt-count increment marks session started");
    assertEqual(counted.providerState.providerLocked, true, "prompt-count increment locks provider");
    assertEqual(store.switchProviderBeforeStart("picker-count-lock", "anthropic"), false, "started session cannot switch provider");

    store.createSession("picker-explicit-locked", "Explicit OpenAI", true, false, "", "openai", true);
    const explicitLocked = useProviderSessionStore.getState().sessions["picker-explicit-locked"];
    assert(explicitLocked, "explicitly locked session exists");
    assertEqual(explicitLocked.providerState.provider, "openai", "explicit provider survives createSession");
    assertEqual(explicitLocked.providerState.providerLocked, true, "explicit provider lock survives createSession");
    assertEqual(store.switchProviderBeforeStart("picker-explicit-locked", "anthropic"), false, "explicitly locked saved/forked session rejects provider switch");

    store.createSession("picker-legacy-openai");
    const legacy = useProviderSessionStore.getState().sessions["picker-legacy-openai"];
    assert(legacy, "legacy saved session reopens");
    assertEqual(legacy.providerState.provider, "openai", "legacy saved session reopens with known provider");
    assertEqual(legacy.providerState.providerLocked, true, "legacy saved session reopens provider-locked");
    assertEqual(store.switchProviderBeforeStart("picker-legacy-openai", "anthropic"), false, "legacy saved session rejects provider switch");

    store.createSession("picker-saved-openai");
    const saved = useProviderSessionStore.getState().sessions["picker-saved-openai"];
    assert(saved, "providerState saved session reopens");
    assertEqual(saved.providerState.provider, "openai", "providerState saved session reopens with known provider");
    assertEqual(saved.providerState.providerLocked, true, "providerState saved session reopens provider-locked");

    store.createSession("picker-disk-hydrated", undefined, true);
    store.loadFromDisk("picker-disk-hydrated", transcriptFixture.slice(0, 2));
    const diskHydrated = useProviderSessionStore.getState().sessions["picker-disk-hydrated"];
    assert(diskHydrated, "disk-hydrated session exists");
    assertEqual(diskHydrated.promptCount, 1, "disk hydration restores prompt count");
    assertEqual(diskHydrated.hasBeenStarted, true, "disk hydration marks session started when user turns exist");
    assertEqual(diskHydrated.providerState.providerLocked, true, "disk hydration locks sessions with provider history");
    assertEqual(store.switchProviderBeforeStart("picker-disk-hydrated", "openai"), false, "disk-hydrated session rejects provider switch");

    return { name: "empty-chat provider picker lock fixtures", ok: true };
  } finally {
    useProviderSessionStore.setState({ sessions: previousSessions });
    if (previousStorage === null) {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, previousStorage);
    }
    restoreProviderMetaRowsForFixture(previousRowStorage);
  }
}

export function verifyProviderRuntimeFixtures(): VerificationResult {
  assertEqual(providerTurnOperation(providerInput()), "create", "fresh provider turn creates");
  assertEqual(providerTurnOperation(providerInput({ started: true })), "send", "started provider turn sends");
  assertEqual(
    providerTurnOperation(providerInput({ runtimeMetadata: providerTurnRuntimeMetadata("openai", "thread-1") })),
    "send",
    "runtime-metadata-backed provider turn sends",
  );
  assertEqual(providerTurnOperation(providerInput({ threadId: "thread-legacy" })), "send", "legacy thread-backed provider turn sends");
  assertEqual(
    providerTurnOperation(providerInput({ forkParentSessionId: "parent-1" })),
    "send",
    "forked provider turn sends through runtime fork path",
  );

  const controlsOnlyCodexInput = providerInput({
    runtimeMetadata: providerTurnRuntimeMetadata("openai", "thread-1"),
    selectedControls: {
      model: "gpt-5.4",
      effort: "xhigh",
    },
    providerPermissionId: "workspace",
    providerOptions: { openai: { collaborationMode: "plan" } },
  });
  assertNoLegacyProviderTurnFields(controlsOnlyCodexInput, "controls-only Codex turn input");
  const createReq = buildCodexCreateRequest(controlsOnlyCodexInput);
  assertEqual(createReq.session_id, "session-1", "Codex create keeps local session id");
  assertEqual(createReq.model, "gpt-5.4", "Codex create includes selected model");
  assertEqual(createReq.effort, "xhigh", "Codex create includes selected effort");
  assertEqual(createReq.sandbox_mode, "workspace-write", "Codex workspace preset maps to sandbox");
  assertEqual(createReq.approval_policy, "never", "Codex workspace preset maps to approval policy");
  assertEqual(createReq.collaboration_mode, "plan", "Codex create carries app-server collaboration mode");
  assertNoUndefinedOwnValues(createReq as unknown as Record<string, unknown>, "createReq");

  const buildAfterPlanReq = buildCodexCreateRequest(providerInput({
    providerOptions: { openai: { collaborationMode: "default" } },
  }));
  assertEqual(
    buildAfterPlanReq.collaboration_mode,
    "default",
    "Codex build-after-plan requests explicitly exit plan collaboration mode",
  );

  const cursorReviewReq = buildCursorRequest(providerInput({
    provider: "cursor",
    selectedControls: { model: "auto", mode: "default" },
    providerPermissionId: "default",
  }));
  assertEqual(cursorReviewReq.session_id, "session-1", "Cursor request keeps local session id");
  assertEqual(cursorReviewReq.permission_mode, "default", "Cursor request carries selected permission mode");
  assert(!Object.prototype.hasOwnProperty.call(cursorReviewReq, "model"), "Cursor auto model omits --model");
  assert(!Object.prototype.hasOwnProperty.call(cursorReviewReq, "force"), "Cursor review mode does not force writes");

  const cursorForceReq = buildCursorRequest(providerInput({
    provider: "cursor",
    runtimeMetadata: providerTurnRuntimeMetadata("cursor", "cursor-thread"),
    selectedControls: { model: "gpt-5.3-codex", mode: "ask" },
    providerPermissionId: "bypass_all",
  }));
  assertEqual(cursorForceReq.thread_id, "cursor-thread", "Cursor request can carry resume thread id");
  assertEqual(cursorForceReq.model, "gpt-5.3-codex", "Cursor explicit model is included");
  assertEqual(cursorForceReq.mode, "ask", "Cursor mode control maps to CLI mode");
  assertEqual(cursorForceReq.force, true, "Cursor bypass permission maps to --force");
  assertNoUndefinedOwnValues(cursorForceReq as unknown as Record<string, unknown>, "cursorForceReq");

  const sendReq = buildCodexSendRequest(
    controlsOnlyCodexInput,
    createReq,
  );
  assertEqual(sendReq.thread_id, "thread-1", "Codex send includes external app-server thread id");
  assertNoUndefinedOwnValues(sendReq as unknown as Record<string, unknown>, "sendReq");

  const legacyFallbackSendReq = buildCodexSendRequest(
    providerInput({ started: true }),
    createReq,
  );
  assert(
    !Object.prototype.hasOwnProperty.call(legacyFallbackSendReq, "thread_id"),
    "legacy Codex resume fallback does not invent a thread_id",
  );
  assertEqual(
    codexPermissionForOverride("workspace", "plan").sandbox_mode,
    "read-only",
    "plan override downgrades Codex runtime permissions to read-only",
  );

  const yoloReq = buildCodexCreateRequest(providerInput({
    providerPermissionId: "workspace",
    permissionOverride: "bypass_all",
  }));
  assertEqual(yoloReq.yolo, true, "Claude bypass override maps to Codex yolo request");
  assert(!Object.prototype.hasOwnProperty.call(yoloReq, "sandbox_mode"), "yolo request omits sandbox_mode");
  assert(!Object.prototype.hasOwnProperty.call(yoloReq, "approval_policy"), "yolo request omits approval_policy");

  const seededPrompt = promptWithCodexSeed("continue", transcriptFixture.slice(0, 2));
  assert(seededPrompt.includes("Prior transcript"), "Codex fork prompt includes transcript heading");
  assert(seededPrompt.includes("Tool: Read"), "Codex fork prompt includes tool call context");
  const oversizedSeed: ChatMessage[] = transcriptFixture.concat(Array.from({ length: 80 }, (_, index): ChatMessage => {
    const base: ChatMessage = {
      id: `huge-${index}`,
      role: index % 2 === 0 ? "user" : "assistant",
      content: `message ${index} ${"x".repeat(40_000)}`,
      timestamp: index + 10,
    };
    if (index % 2 === 0) return base;
    return {
      ...base,
      toolCalls: [{ id: `tool-${index}`, name: "Bash", input: { command: "x".repeat(40_000) }, result: "y".repeat(40_000) }],
    };
  }));
  const cappedSeededPrompt = promptWithCodexSeed("continue", oversizedSeed);
  assert(
    cappedSeededPrompt.length <= CODEX_MAX_TURN_PROMPT_CHARS,
    "Codex fork prompt is capped below app-server input limit",
  );
  assertEqual(codexDropTurnsForKeepMessages(transcriptFixture, 2), 1, "Codex rewind/fork drops trailing user turns");
  assertEqual(codexDropTurnsForKeepMessages(transcriptFixture, 10), 0, "Codex drop-turn calculation never goes negative");

  return { name: "provider runtime create/send/fork/rewind fixtures", ok: true };
}

export function verifyProviderLifecycleAndHistorySurfaceFixtures(): VerificationResult {
  const providerRuntimeHelpers = {
    runProviderTurn,
    prepareProviderTurnInput,
    cancelProviderSession,
    closeProviderSession,
    truncateProviderHistory,
    prepareProviderFork,
    hydrateProviderHistory,
    deleteProviderHistory,
  } satisfies {
    runProviderTurn: typeof runProviderTurn;
    prepareProviderTurnInput: typeof prepareProviderTurnInput;
    cancelProviderSession: typeof cancelProviderSession;
    closeProviderSession: typeof closeProviderSession;
    truncateProviderHistory: typeof truncateProviderHistory;
    prepareProviderFork: typeof prepareProviderFork;
    hydrateProviderHistory: typeof hydrateProviderHistory;
    deleteProviderHistory: typeof deleteProviderHistory;
  };
  void providerRuntimeHelpers;

  for (const provider of PROVIDER_IDS) {
    assert(isProviderId(provider), `${provider} is a supported provider id`);
    const runtime = getProviderRuntime(provider);
    assertEqual(runtime.provider, provider, `${provider} runtime keeps its provider id`);
    assertEqual(
      providerHistorySource(provider),
      getProviderManifest(provider).history.source,
      `${provider} runtime history source matches manifest`,
    );

    for (const operation of providerLifecycleOperations) {
      assertEqual(typeof runtime[operation], "function", `${provider} runtime exposes ${operation}`);
    }

    for (const capability of providerHistoryCapabilities) {
      assertEqual(
        providerHistorySupports(provider, capability),
        runtime.history.capabilities[capability],
        `${provider} history ${capability} helper matches runtime capability`,
      );
      const handler = runtime.history[providerHistoryHandlerNames[capability]];
      if (runtime.history.capabilities[capability]) {
        assertEqual(typeof handler, "function", `${provider} history ${capability} has a handler when enabled`);
      }
    }
  }

  assertEqual(typeof getProviderRuntime("anthropic").prepareTurn, "function", "Anthropic runtime owns temp MCP setup hook");
  assertEqual(typeof getProviderRuntime("openai").prepareTurn, "function", "OpenAI runtime owns frontend turn setup hook");

  const futureUnsupported = createUnsupportedFutureRuntime("opencode");
  assertEqual(futureUnsupported.provider, "opencode", "unsupported future runtime keeps provider id");
  assertEqual(futureUnsupported.history.source, "none", "unsupported future runtime starts with no history source");
  for (const capability of providerHistoryCapabilities) {
    assertEqual(
      futureUnsupported.history.capabilities[capability],
      false,
      `unsupported future runtime history ${capability} fails closed`,
    );
  }
  assert(
    unsupportedFutureProvider("opencode", "send").message.includes("no send runtime binding"),
    "unsupported future runtime lifecycle operations fail closed",
  );

  return { name: "provider lifecycle/history conformance fixtures", ok: true };
}

export function verifyProviderPermissionHelperFixtures(): VerificationResult {
  for (const provider of PROVIDER_IDS) {
    const defaultPermission = getDefaultProviderPermissionId(provider);
    assertEqual(defaultPermission, getProviderDefaultPermission(provider), `${provider} default permission is manifest-owned`);
    assert(isProviderPermissionId(provider, defaultPermission), `${provider} default permission is listed`);
    assertEqual(
      getProviderPermissionOption(provider, "missing").id,
      defaultPermission,
      `${provider} missing permission falls back to default`,
    );
  }

  assertEqual(getNextProviderPermissionId("openai", "workspace"), "full-auto", "OpenAI permission cycling follows manifest order");
  assertEqual(
    getNextProviderPermissionId("openai", "missing"),
    "read-only",
    "OpenAI unknown current permission cycles to the first manifest option",
  );
  assertEqual(
    getProviderPermissionInputPresentation("anthropic", "default").label,
    "ask permissions on",
    "Anthropic input permission label uses manifest input label and suffix",
  );
  assertEqual(
    getProviderPermissionInputPresentation("openai", "workspace").label,
    "workspace sandbox",
    "OpenAI input permission label uses manifest suffix",
  );
  assertEqual(
    permissionModeFromProviderPermission("workspace", "plan"),
    "plan",
    "Codex permission ids do not masquerade as Claude permission modes",
  );
  assertEqual(
    permissionModeFromProviderPermission("accept_edits"),
    "accept_edits",
    "Claude permission ids round-trip to permission modes",
  );

  return { name: "provider permission helper conformance fixtures", ok: true };
}

export function verifyProviderPromptSpawnFixtures(): VerificationResult {
  const anthropicSpawn = buildSpawnProviderTurnInput({
    provider: "anthropic",
    sessionId: "spawn-anthropic",
    cwd: "/repo",
    prompt: "hello",
  });
  assertEqual(anthropicSpawn.providerPermissionId, "default", "Anthropic prompt spawn uses manifest default permission");
  assertEqual(anthropicSpawn.permissionMode, "default", "Anthropic prompt spawn passes Claude-shaped permission mode");
  assertEqual(
    anthropicSpawn.selectedControls?.["tool-permission"],
    "default",
    "Anthropic prompt spawn seeds manifest-declared permission control",
  );

  const openaiSpawn = buildSpawnProviderTurnInput({
    provider: "openai",
    sessionId: "spawn-openai",
    cwd: "/repo",
    prompt: "hello",
  });
  assertEqual(openaiSpawn.providerPermissionId, "workspace", "OpenAI prompt spawn uses manifest default permission");
  assertEqual(openaiSpawn.selectedControls?.sandbox, "workspace", "OpenAI prompt spawn seeds sandbox control");
  assert(
    !Object.prototype.hasOwnProperty.call(openaiSpawn, "permissionMode"),
    "OpenAI prompt spawn omits Claude-shaped permissionMode",
  );
  assert(
    !Object.prototype.hasOwnProperty.call(openaiSpawn, "skipOpenwolf"),
    "prompt spawn omits undefined skipOpenwolf",
  );
  assertNoLegacyProviderTurnFields(openaiSpawn, "OpenAI prompt spawn");

  const cursorSpawn = buildSpawnProviderTurnInput({
    provider: "cursor",
    sessionId: "spawn-cursor",
    cwd: "/repo",
    prompt: "hello",
    skipOpenwolf: true,
  });
  assertEqual(cursorSpawn.providerPermissionId, "default", "Cursor prompt spawn uses manifest default permission");
  assertEqual(cursorSpawn.selectedControls?.["apply-mode"], "default", "Cursor prompt spawn seeds apply-mode control");
  assertEqual(cursorSpawn.skipOpenwolf, true, "prompt spawn preserves explicit skipOpenwolf");
  assert(
    !Object.prototype.hasOwnProperty.call(cursorSpawn, "permissionMode"),
    "Cursor prompt spawn omits permissionMode even when the provider default id overlaps Claude",
  );
  assertNoLegacyProviderTurnFields(cursorSpawn, "Cursor prompt spawn");
  assertNoUndefinedOwnValues(openaiSpawn as unknown as Record<string, unknown>, "openaiSpawn");
  assertNoUndefinedOwnValues(cursorSpawn as unknown as Record<string, unknown>, "cursorSpawn");

  return { name: "provider prompt spawn fixtures", ok: true };
}

export function verifyProviderMetadataHelperFixtures(): VerificationResult {
  const openaiState = resolveSessionProviderState({
    provider: "openai",
    runtimeMetadata: {
      openai: {
        historySource: "codex-rollout",
        resume: { id: "thread-runtime-metadata" },
        runtimePayload: {
          codexThreadId: "thread-runtime-metadata",
        },
      },
    },
    providerMetadata: {
      openai: {
        codexThreadId: "thread-provider-metadata",
      },
    },
    providerPermissions: {
      openai: "workspace",
    },
    selectedModel: "gpt-5.5",
    selectedEffort: "medium",
  });
  assertEqual(openaiState.provider, "openai", "metadata helper fixture resolves OpenAI provider");
  assertEqual(
    getProviderSessionRuntimeMetadata(openaiState, "openai")?.runtimePayload.codexThreadId,
    "thread-runtime-metadata",
    "generic runtime metadata helper reads provider-owned OpenAI payload",
  );
  assertEqual(
    resolveProviderRuntimeResumeId({ providerState: openaiState }, "openai"),
    "thread-runtime-metadata",
    "runtime metadata resume helper resolves provider-owned thread id",
  );
  assertEqual(
    getProviderSessionMetadata(openaiState, "openai")?.codexThreadId,
    "thread-runtime-metadata",
    "legacy metadata helper reads OpenAI thread id through runtime metadata",
  );
  assertEqual(
    getProviderPermissionId(resolveSessionProviderState({
      provider: "openai",
      codexThreadId: "thread-flat-compat",
      selectedCodexPermission: "full-auto",
    }), "openai"),
    "full-auto",
    "OpenAI permission helper keeps flat compatibility fallback",
  );
  assertEqual(
    resolveProviderSessionMetadata({ provider: "anthropic" }, "anthropic"),
    undefined,
    "Anthropic metadata helper stays empty until provider-owned metadata exists",
  );
  assertEqual(
    getOpenAiProviderSessionMetadata(resolveSessionProviderState({ provider: "anthropic" })),
    undefined,
    "OpenAI metadata helper does not invent metadata for Anthropic sessions",
  );

  return { name: "provider metadata helper conformance fixtures", ok: true };
}

export function verifyDelegationChildSpawnFixtures(): VerificationResult {
  const mcpEnv = buildDelegationMcpEnv({
    delegationPort: 49152,
    delegationSecret: "secret",
    groupId: "group-1",
    agentLabel: "Agent 1",
  });
  assert(mcpEnv, "delegation MCP env is built when port and secret are available");
  assertEqual(getDelegationMcpTransport("anthropic"), "temp-config", "Anthropic delegation uses a temp MCP config");
  assertEqual(getDelegationMcpTransport("openai"), "env", "OpenAI delegation uses runtime MCP env");
  assertEqual(getDelegationMcpTransport("cursor"), "env", "Cursor delegation uses runtime MCP env");

  const inheritedRuntime = resolveDelegationChildRuntimeSettings({
    parentSession: {
      providerState: {
        provider: "openai",
        providerLocked: true,
        selectedModel: "gpt-5.4",
        selectedEffort: "medium",
        selectedControls: {
          openai: {
            model: "gpt-5.4",
            effort: "medium",
          },
        },
        providerPermissions: {
          openai: "full-auto",
        },
        seedTranscript: null,
        runtimeMetadata: {
          openai: {
            historySource: "codex-rollout",
            resume: { id: "thread-parent" },
            runtimePayload: {
              codexThreadId: "thread-parent",
            },
          },
        },
        providerMetadata: {
          openai: {
            codexThreadId: "thread-parent",
          },
        },
      },
      skipOpenwolf: true,
    },
    selectedProvider: "anthropic",
    selectedControls: { model: "sonnet", effort: "high" },
    selectedProviderPermissionId: "workspace",
  });
  assertEqual(inheritedRuntime.provider, "openai", "delegation child inherits parent provider");
  assertEqual(inheritedRuntime.selectedControls.model, "gpt-5.4", "delegation child inherits parent model control");
  assertEqual(inheritedRuntime.selectedControls.effort, "medium", "delegation child inherits parent effort control");
  assertEqual(inheritedRuntime.selectedProviderPermissionId, "full-auto", "delegation child inherits parent provider permission");
  assertEqual(inheritedRuntime.inheritSkipOpenwolf, true, "delegation child inherits parent OpenWolf skip preference");
  const inheritedMetadata = buildDelegationChildRuntimeMetadata(inheritedRuntime, "/repo");
  assertEqual(inheritedMetadata.model, "gpt-5.4", "delegation child metadata derives model from selected controls");
  assertEqual(inheritedMetadata.effort, "medium", "delegation child metadata derives effort from selected controls");
  assertEqual(inheritedMetadata.providerPermissionId, "full-auto", "delegation child metadata stores provider permission id");
  assert(!Object.prototype.hasOwnProperty.call(inheritedMetadata, "permissionPreset"), "delegation child metadata omits legacy permissionPreset");

  const selectedOpenAiPermission = resolveDelegationChildRuntimePermission("openai", "workspace");
  assertEqual(selectedOpenAiPermission.providerPermissionId, "workspace", "OpenAI child selected permission preserves workspace");
  assert(!Object.prototype.hasOwnProperty.call(selectedOpenAiPermission, "permissionOverride"), "OpenAI selected child permission omits bypass override");
  const forcedAnthropicPermission = resolveDelegationChildRuntimePermission("anthropic", "default");
  assertEqual(forcedAnthropicPermission.providerPermissionId, "bypass_all", "Anthropic bypass child permission stores provider bypass id");
  assertEqual(forcedAnthropicPermission.permissionOverride, "bypass_all", "Anthropic bypass child permission forces runtime override");

  const openaiChild = buildDelegationChildProviderTurnInput({
    provider: "openai",
    sessionId: "child-openai",
    cwd: "/repo",
    prompt: "do the task",
    selectedControls: { model: "gpt-5.5", effort: "high" },
    selectedProviderPermissionId: "workspace",
    inheritSkipOpenwolf: false,
    mcpEnv,
  });

  assertEqual(openaiChild.provider, "openai", "delegation OpenAI child keeps provider");
  assertEqual(openaiChild.started, false, "delegation child starts as a first turn");
  assertEqual(openaiChild.providerPermissionId, "workspace", "delegation OpenAI child keeps selected permission id");
  assert(!Object.prototype.hasOwnProperty.call(openaiChild, "permissionOverride"), "delegation OpenAI child selected policy does not force bypass override");
  assertEqual(openaiChild.skipOpenwolf, true, "delegation OpenAI child skips OpenWolf bootstrap");
  assertEqual(openaiChild.providerOptions?.openai?.skipGitRepoCheck, true, "delegation OpenAI child skips git repo check");
  assertEqual(openaiChild.providerOptions?.openai?.mcpEnv?.T64_AGENT_LABEL, "Agent 1", "delegation OpenAI child receives MCP env");
  assertNoLegacyProviderTurnFields(openaiChild, "delegation OpenAI child turn");
  assert(!Object.prototype.hasOwnProperty.call(openaiChild.providerOptions ?? {}, "anthropic"), "delegation OpenAI child does not receive Anthropic options");
  assert(!Object.prototype.hasOwnProperty.call(openaiChild.providerOptions ?? {}, "cursor"), "delegation OpenAI child does not receive Cursor options");
  const openaiChildReq = buildCodexCreateRequest(openaiChild as ProviderTurnInput<"openai">);
  assertEqual(openaiChildReq.sandbox_mode, "workspace-write", "delegation OpenAI selected permission reaches Codex request");
  assert(!Object.prototype.hasOwnProperty.call(openaiChildReq, "yolo"), "delegation OpenAI selected policy does not map to yolo");
  assertNoUndefinedOwnValues(openaiChild as unknown as Record<string, unknown>, "openaiChild");

  const cursorChild = buildDelegationChildProviderTurnInput({
    provider: "cursor",
    sessionId: "child-cursor",
    cwd: "/repo",
    prompt: "do the task",
    selectedControls: { model: "auto", mode: "ask" },
    selectedProviderPermissionId: "default",
    inheritSkipOpenwolf: false,
    mcpEnv,
  });

  assertEqual(cursorChild.provider, "cursor", "delegation Cursor child keeps provider");
  assertEqual(cursorChild.selectedControls?.mode, "ask", "delegation Cursor child carries mode control without selectedEffort");
  assertEqual(cursorChild.providerPermissionId, "default", "delegation Cursor child keeps selected permission id");
  assert(!Object.prototype.hasOwnProperty.call(cursorChild, "permissionOverride"), "delegation Cursor child selected policy does not force bypass override");
  assertEqual(cursorChild.skipOpenwolf, true, "delegation Cursor child skips OpenWolf bootstrap");
  assertEqual(cursorChild.providerOptions?.cursor?.mcpEnv?.T64_AGENT_LABEL, "Agent 1", "delegation Cursor child receives MCP env");
  assert(!Object.prototype.hasOwnProperty.call(cursorChild.providerOptions ?? {}, "anthropic"), "delegation Cursor child does not receive Anthropic options");
  assert(!Object.prototype.hasOwnProperty.call(cursorChild.providerOptions ?? {}, "openai"), "delegation Cursor child does not receive OpenAI options");
  assertNoLegacyProviderTurnFields(cursorChild, "delegation Cursor child turn");
  const cursorChildReq = buildCursorRequest(cursorChild as ProviderTurnInput<"cursor">);
  assert(!Object.prototype.hasOwnProperty.call(cursorChildReq, "force"), "delegation Cursor selected default permission does not force writes");
  assertNoUndefinedOwnValues(cursorChild as unknown as Record<string, unknown>, "cursorChild");

  const anthropicChild = buildDelegationChildProviderTurnInput({
    provider: "anthropic",
    sessionId: "child-anthropic",
    cwd: "/repo",
    prompt: "do the task",
    selectedControls: { model: "sonnet", effort: "high" },
    selectedProviderPermissionId: "workspace",
    inheritSkipOpenwolf: true,
    mcpEnv,
  });

  assertEqual(anthropicChild.provider, "anthropic", "delegation Anthropic child keeps provider");
  assertEqual(anthropicChild.providerPermissionId, "bypass_all", "delegation Anthropic child manifest policy stores bypass permission");
  assertEqual(anthropicChild.permissionOverride, "bypass_all", "delegation Anthropic child manifest policy forces bypass override");
  assertEqual(anthropicChild.skipOpenwolf, true, "delegation Anthropic child inherits OpenWolf preference");
  assertEqual(anthropicChild.providerOptions?.anthropic?.mcpEnv?.T64_AGENT_LABEL, "Agent 1", "delegation Anthropic child carries MCP env for runtime temp config");
  assertEqual(anthropicChild.providerOptions?.anthropic?.noSessionPersistence, true, "delegation Anthropic child disables session persistence");
  assert(!Object.prototype.hasOwnProperty.call(anthropicChild.providerOptions?.anthropic ?? {}, "mcpConfig"), "delegation Anthropic child defers temp MCP config creation to runtime prep");
  assert(!Object.prototype.hasOwnProperty.call(anthropicChild.providerOptions ?? {}, "openai"), "delegation Anthropic child does not receive OpenAI options");
  assert(!Object.prototype.hasOwnProperty.call(anthropicChild.providerOptions ?? {}, "cursor"), "delegation Anthropic child does not receive Cursor options");
  assertNoLegacyProviderTurnFields(anthropicChild, "delegation Anthropic child turn");
  assertNoUndefinedOwnValues(anthropicChild as unknown as Record<string, unknown>, "anthropicChild");

  return { name: "delegation child provider turn fixtures", ok: true };
}

export function verifyDelegationWorkflowFixtures(): VerificationResult {
  assertEqual(parseDelegateCommand("/delegate split this safely"), "split this safely", "/delegate command parser extracts the user goal");
  assertEqual(parseDelegateCommand("/delegate   "), null, "empty /delegate command does not build a planner turn");

  const openAiPlan = buildDelegationPlanRequest({
    provider: "openai",
    userGoal: "split frontend and backend work",
  });
  assertEqual(openAiPlan.displayText, "/delegate split frontend and backend work", "delegation plan keeps user-facing command text");
  assert(openAiPlan.providerPrompt.includes("StartDelegation"), "delegation planner prompt asks for the MCP StartDelegation tool");
  assert(openAiPlan.providerPrompt.includes("<T64_START_DELEGATION>"), "delegation planner prompt includes provider-neutral fallback tag");
  assert(openAiPlan.providerPrompt.includes("Do not try to load deferred tool schemas"), "delegation planner prompt avoids deferred-tool stalls");
  assert(!Object.prototype.hasOwnProperty.call(openAiPlan, "permissionOverride"), "OpenAI delegation planner does not invent an override");

  const cursorPlan = buildDelegationPlanRequest({
    provider: "cursor",
    userGoal: "split the work",
  });
  assertEqual(cursorPlan.permissionOverride, "bypass_all", "Cursor delegation planner permission comes from manifest policy");

  const explicitPlan = buildDelegationPlanRequest({
    provider: "cursor",
    userGoal: "plan only",
    permissionOverride: "plan",
  });
  assertEqual(explicitPlan.permissionOverride, "plan", "explicit delegation permission override wins over manifest default");

  const parsedTool = parseDelegationStartFromMessage({
    content: "",
    toolCalls: [{
      id: "tool-1",
      name: "terminal-64-StartDelegation",
      input: {
        context: "shared context",
        tasks: [{ agentName: "Builder", description: "task one" }, { description: "task two" }],
      },
    }],
  });
  assert(parsedTool, "StartDelegation tool call parses into a delegation plan");
  assertEqual(parsedTool.tasks.length, 2, "StartDelegation parser keeps task objects");
  assertEqual(parsedTool.tasks[0]?.agentName, "Builder", "StartDelegation parser keeps optional agent names");

  const parsedFallback = parseDelegationStartFromMessage({
    content: `<T64_START_DELEGATION>{"context":"fallback context","tasks":["task one","task two"]}</T64_START_DELEGATION>`,
  });
  assertEqual(parsedFallback?.context, "fallback context", "fallback JSON tag parses shared context");
  assertEqual(parsedFallback?.tasks[0]?.description, "task one", "fallback JSON parser accepts string tasks");

  const parsedLegacy = parseDelegationStartFromMessage({
    content: "[DELEGATION_START]\n[CONTEXT] legacy context\n[TASK] task one\n[TASK] task two\n[DELEGATION_END]",
  });
  assertEqual(parsedLegacy?.context, "legacy context", "legacy delegation block remains supported");

  const childSpawn = buildDelegationChildSpawnPlan({
    sharedContext: "shared",
    taskDescription: "write tests",
    agentName: "Verifier",
    taskIndex: 1,
    taskCount: 3,
    teamChatEnabled: true,
  });
  assertEqual(childSpawn.agentLabel, "Verifier", "child spawn helper uses provided agent names");
  assert(childSpawn.initialPrompt.includes("read_team"), "child spawn prompt includes team chat instructions when available");
  assert(childSpawn.initialPrompt.includes("ReadTeam"), "child spawn prompt names provider-displayed ReadTeam tool");
  assert(childSpawn.initialPrompt.includes("SendToTeam"), "child spawn prompt names provider-displayed SendToTeam tool");
  assert(childSpawn.initialPrompt.includes("ReportDone"), "child spawn prompt names provider-displayed ReportDone tool");

  assertNoUndefinedOwnValues(openAiPlan as unknown as Record<string, unknown>, "openAiPlan");
  assertNoUndefinedOwnValues(cursorPlan as unknown as Record<string, unknown>, "cursorPlan");

  return { name: "delegation workflow fixtures", ok: true };
}

export function verifyProviderIpcRequestTypingFixtures(): VerificationResult {
  const openaiCreate = {
    provider: "openai",
    req: buildCodexCreateRequest(providerInput()),
  } satisfies ProviderCreateRequest<"openai">;
  const openaiSend = {
    provider: "openai",
    req: buildCodexSendRequest(
      providerInput({ runtimeMetadata: providerTurnRuntimeMetadata("openai", "thread-1") }),
      openaiCreate.req,
    ),
  } satisfies ProviderSendRequest<"openai">;
  const anthropicCreate = {
    provider: "anthropic",
    req: {
      session_id: "claude-1",
      cwd: "/repo",
      prompt: "hello",
      permission_mode: "default",
    },
  } satisfies ProviderCreateRequest<"anthropic">;
  const cursorCreate = {
    provider: "cursor",
    req: buildCursorRequest(providerInput({ provider: "cursor" })),
  } satisfies ProviderCreateRequest<"cursor">;

  // @ts-expect-error provider ids are intentionally closed until a runtime is implemented.
  const unsupportedProvider = { provider: "opencode", req: openaiCreate.req } satisfies ProviderCreateRequest;
  // @ts-expect-error OpenAI create requests must include a prompt at the generic IPC boundary.
  const missingPrompt = { provider: "openai", req: { session_id: "codex-1", cwd: "/repo" } } satisfies ProviderCreateRequest<"openai">;
  // @ts-expect-error exactOptionalPropertyTypes requires callers to omit optional values instead of passing undefined.
  const undefinedOptional = { session_id: "codex-1", cwd: "/repo", prompt: "hello", model: undefined } satisfies CreateCodexRequest;
  void unsupportedProvider;
  void missingPrompt;
  void undefinedOptional;

  assertEqual(openaiCreate.provider, "openai", "generic provider_create carries OpenAI discriminator");
  assertEqual(openaiSend.req.thread_id, "thread-1", "generic provider_send carries OpenAI thread id");
  assertEqual(anthropicCreate.req.permission_mode, "default", "generic provider_create carries Anthropic request shape");
  assertEqual(cursorCreate.req.permission_mode, "default", "generic provider_create carries Cursor request shape");

  return { name: "generic provider IPC request typing fixtures", ok: true };
}

export function verifyFutureProviderStubFixtures(): VerificationResult {
  assert(!isProviderId("opencode"), "future provider ids fail closed until added to the manifest registry");

  const currentProviderRegistry = {
    anthropic: getProviderManifest("anthropic"),
    openai: getProviderManifest("openai"),
    cursor: getProviderManifest("cursor"),
  };
  // @ts-expect-error adding a ProviderId must also add a manifest entry.
  const missingFutureManifestRegistry: Record<FutureProviderId, FutureProviderManifest> = currentProviderRegistry;
  void missingFutureManifestRegistry;

  const futureProviderRegistry = {
    ...currentProviderRegistry,
    opencode: futureProviderStubManifest,
  } satisfies Record<FutureProviderId, FutureProviderManifest>;

  assertEqual(futureProviderRegistry.opencode.id, "opencode", "future stub manifest keeps provider id");
  assert(
    futureProviderRegistry.opencode.models.some((model) => model.id === futureProviderRegistry.opencode.defaultModel),
    "future stub manifest default model is listed",
  );
  assert(
    !futureProviderRegistry.opencode.capabilities.fork,
    "future stub manifest starts with unsupported capabilities fail-closed",
  );
  assertEqual(
    futureProviderRegistry.opencode.history.source,
    "none",
    "future stub manifest starts with explicit no-history source",
  );
  assertEqual(
    futureProviderRegistry.opencode.delegation.mcpTransport,
    "env",
    "future stub manifest declares delegation MCP transport",
  );

  const currentRuntimeRegistry = {
    anthropic: getProviderRuntime("anthropic"),
    openai: getProviderRuntime("openai"),
    cursor: getProviderRuntime("cursor"),
  };
  // @ts-expect-error adding a ProviderId must also add a runtime entry.
  const missingFutureRuntimeRegistry: Record<FutureProviderId, FutureProviderRuntime> = currentRuntimeRegistry;
  void missingFutureRuntimeRegistry;

  const futureRuntimeRegistry = {
    ...currentRuntimeRegistry,
    opencode: createUnsupportedFutureRuntime("opencode"),
  } satisfies Record<FutureProviderId, FutureProviderRuntime>;
  assertEqual(futureRuntimeRegistry.opencode.provider, "opencode", "future stub runtime keeps provider id");
  assert(
    unsupportedFutureProvider("opencode", "create").message.includes("no create runtime binding"),
    "future stub runtime fails closed before implementation",
  );

  const currentProviderStateCannotUseOpenCode = {
    // @ts-expect-error current providerState is closed until the ProviderId and providerState shapes are extended.
    provider: "opencode",
    providerLocked: false,
    selectedModel: null,
    selectedEffort: null,
    selectedControls: {},
    seedTranscript: null,
    providerMetadata: {},
    providerPermissions: {},
  } satisfies ProviderSessionState;
  void currentProviderStateCannotUseOpenCode;

  const futureProviderState = {
    provider: "opencode",
    providerLocked: false,
    selectedModel: "stub-model",
    selectedEffort: "stub-effort",
    selectedControls: {
      opencode: {
        model: "stub-model",
        profile: "stub",
      },
    },
    seedTranscript: null,
    runtimeMetadata: {
      opencode: {
        historySource: "none",
        resume: { id: null },
        runtimePayload: {
          threadId: null,
        },
      },
    },
    providerMetadata: {
      opencode: {
        threadId: null,
        permissionProfile: "stub",
      },
    },
    providerPermissions: {
      opencode: "stub",
    },
  } satisfies FutureProviderSessionState;
  assertEqual(
    futureProviderState.providerMetadata.opencode?.permissionProfile,
    "stub",
    "future providerState keeps provider-owned metadata",
  );

  const currentProviderCreateCannotUseOpenCode = {
    // @ts-expect-error current generic IPC is closed until a provider-owned request binding is added.
    provider: "opencode",
    req: buildCodexCreateRequest(providerInput()),
  } satisfies ProviderCreateRequest;
  void currentProviderCreateCannotUseOpenCode;

  const futureCreateRequest = {
    provider: "opencode",
    req: {
      session_id: "opencode-1",
      cwd: "/repo",
      prompt: "hello",
      client_profile: "stub",
    },
  } satisfies FutureProviderCreateRequest;
  assertEqual(futureCreateRequest.req.client_profile, "stub", "future provider IPC keeps provider-owned request shape");

  return { name: "future provider stub extension fixtures", ok: true };
}

export function verifyCodexPermissionFixtures(): VerificationResult {
  assertEqual(decodeCodexPermission("read-only").sandbox_mode, "read-only", "read-only sandbox maps directly");
  assertEqual(decodeCodexPermission("workspace").sandbox_mode, "workspace-write", "workspace sandbox maps directly");
  assertEqual(decodeCodexPermission("workspace").approval_policy, "never", "workspace never asks");
  assertEqual(decodeCodexPermission("full-auto").full_auto, true, "full-auto maps to full_auto");
  assertEqual(decodeCodexPermission("yolo").yolo, true, "yolo maps to bypass flag");
  assertEqual(decodeCodexPermission("unknown").sandbox_mode, "workspace-write", "unknown preset falls back to workspace");
  return { name: "Codex permission request params", ok: true };
}

export function verifyProviderAvailabilityFixtures(): VerificationResult {
  assert(typeof localStorage !== "undefined", "provider availability fixture requires browser localStorage");

  const previousStorage = localStorage.getItem(STORAGE_KEY);
  const previousRowStorage = snapshotProviderMetaRowsForFixture();
  const previousSessions = useProviderSessionStore.getState().sessions;
  const previousAvailability = useSettingsStore.getState().providerAvailability;
  const store = useProviderSessionStore.getState();

  try {
    clearProviderMetaRowsForFixture();
    const openAiDisabled = {
      ...previousAvailability,
      anthropic: true,
      openai: false,
      cursor: false,
    };
    useSettingsStore.setState({ providerAvailability: openAiDisabled });

    const enabledProviders = listAvailableProviderIds(openAiDisabled);
    assertEqual(enabledProviders.includes("openai"), false, "disabled OpenAI is excluded from provider picker options");
    assertEqual(getDefaultAvailableProvider(openAiDisabled), "anthropic", "provider availability falls back to enabled Claude");

    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      "availability-legacy-openai": {
        sessionId: "availability-legacy-openai",
        name: "Disabled Legacy OpenAI",
        cwd: "",
        draftPrompt: "",
        lastSeenAt: 1,
        schemaVersion: 4,
        provider: "openai",
        providerLocked: true,
        codexThreadId: "thread-disabled-legacy",
        selectedModel: "gpt-5.4",
        selectedEffort: "high",
        selectedCodexPermission: "workspace",
      },
    }));
    useProviderSessionStore.setState({ sessions: {} });

    store.createSession("availability-legacy-openai");
    const legacy = useProviderSessionStore.getState().sessions["availability-legacy-openai"];
    assert(legacy, "disabled provider legacy session still loads");
    assertEqual(legacy.providerState.provider, "openai", "disabled provider does not rewrite legacy session provider");
    assertEqual(legacy.providerState.providerLocked, true, "disabled provider legacy session stays provider-locked");
    assertEqual(
      getProviderPermissionId(legacy.providerState, "openai"),
      "workspace",
      "disabled provider legacy permission still migrates",
    );

    return { name: "provider availability fixtures", ok: true };
  } finally {
    useProviderSessionStore.setState({ sessions: previousSessions });
    useSettingsStore.setState({ providerAvailability: previousAvailability });
    if (previousStorage === null) {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, previousStorage);
    }
    restoreProviderMetaRowsForFixture(previousRowStorage);
  }
}

export function verifyProviderEventNormalizationFixtures(): VerificationResult {
  const toolCall = buildProviderToolCall({ id: "tool-1", name: "Edit", input: { file_path: "src/a.ts" } });
  assertEqual(getProviderToolFilePath(toolCall.input), "src/a.ts", "provider tool path reads file_path");

  const aliasedToolCall = buildProviderToolCall({ id: "tool-alias", name: "read_file", input: { file: "src/alias.ts" } });
  assertEqual(aliasedToolCall.name, "Read", "provider tool aliases normalize to Claude tool names");
  assertEqual(getProviderToolFilePath(aliasedToolCall.input), "src/alias.ts", "provider tool alias input normalizes file path");

  const fileChangeItem = {
    id: "codex-file",
    item_type: "file_change",
    changes: [
      { filePath: "src/a.ts", unifiedDiff: "--- a\n+++ b", kind: { type: "modify" } },
      { path: "src/b.ts", diff: "--- c\n+++ d", kind: "create" },
    ],
  };
  const codexFileCall = codexItemToProviderToolCall(fileChangeItem);
  assert(codexFileCall, "Codex file change normalizes into a provider tool call");
  assertEqual(codexItemDisplayName(fileChangeItem), "MultiEdit", "multi-path Codex file change displays as MultiEdit");
  assertEqual(codexFileCall.name, "MultiEdit", "Codex file tool call uses normalized display name");
  assertEqual(getProviderToolPaths(codexFileCall.input).length, 2, "Codex file tool call exposes both changed paths");
  assert(getProviderToolDiff(codexFileCall.input).includes("+++ b"), "Codex unifiedDiff normalizes into provider diff");

  const shellItem = {
    id: "codex-shell",
    item_type: "custom_tool_call",
    name: "exec_command",
    arguments: { cmd: "npm run typecheck" },
    output: "ok",
    exit_code: 0,
  };
  const shellCall = codexItemToProviderToolCall(shellItem);
  assert(shellCall, "Codex exec_command normalizes into a provider tool call");
  assertEqual(shellCall.name, "Bash", "Codex raw shell tool displays as Bash");
  assertEqual(codexItemInput(shellItem).command, "npm run typecheck", "Codex shell command maps to command input");

  const codexMcpCall = codexItemToProviderToolCall({
    id: "codex-mcp",
    item_type: "mcp_tool_call",
    server: "terminal-64",
    tool_name: "send_to_team",
    arguments: { message: "heads up" },
  });
  assert(codexMcpCall, "Codex MCP tool call normalizes into a provider tool call");
  assertEqual(codexMcpCall.name, "mcp__terminal-64__send_to_team", "Codex MCP tool call uses Claude MCP naming");
  const codexMcpPresentation = toolHeader(codexMcpCall);
  assertEqual(codexMcpPresentation.title, "send_to_team", "MCP presentation shows the concrete tool as the title");
  assert(codexMcpPresentation.detail.includes("MCP terminal-64"), "MCP presentation keeps the server in secondary detail");

  const failedResult = codexItemToProviderToolResult({
    id: "codex-failed",
    item_type: "command_execution",
    command: "false",
    output: "failed",
    exit_code: 1,
  });
  assert(failedResult, "Codex failed command normalizes into a provider tool result");
  assertEqual(failedResult.isError, true, "Codex non-zero exit becomes provider error result");

  assert(codexItemChangedPaths(fileChangeItem).includes("src/a.ts"), "Codex item changed paths include filePath shape");
  assert(codexInputChangedPaths({ changes: [{ path: "src/c.ts", diff: "diff" }] }).includes("src/c.ts"), "provider input paths include normalized changes");

  const claudeTool = claudeBlockToProviderToolCall({
    type: "tool_use",
    id: "claude-tool",
    name: "Read",
    input: { file_path: "src/App.tsx" },
  });
  assert(claudeTool, "Claude tool_use normalizes into a provider tool call");
  assertEqual(claudeTool.name, "Read", "Claude tool_use keeps tool name");

  const claudeResult = claudeBlockToProviderToolResult({
    type: "tool_result",
    tool_use_id: "claude-tool",
    content: [{ type: "text", text: "done" }],
    is_error: false,
  });
  assert(claudeResult, "Claude tool_result normalizes into a provider tool result");
  assertEqual(claudeResult.result, "done", "Claude text result extracts content");

  const cursorDecoder = new CursorLiveEventDecoder();
  const cursorToolEvents = cursorDecoder.decode("cursor-session", JSON.stringify({
    type: "tool_call",
    subtype: "started",
    call_id: "cursor-tool",
    tool_call: {
      mcpToolCall: {
        args: {
          name: "terminal-64-StartDelegation",
          args: {
            context: "shared context",
            tasks: [{ description: "task one" }, { description: "task two" }],
          },
          toolName: "StartDelegation",
        },
      },
    },
  }));
  const cursorToolEvent = cursorToolEvents.find((event) => event.kind === "tool_call");
  assert(cursorToolEvent?.kind === "tool_call", "Cursor MCP tool_call normalizes into a provider tool call");
  assertEqual(cursorToolEvent.toolCall.name, "mcp__terminal-64__StartDelegation", "Cursor MCP tool name normalizes to Claude MCP naming");
  assertEqual(cursorToolEvent.toolCall.input.context, "shared context", "Cursor MCP nested args unwrap into provider input");
  assert(Array.isArray(cursorToolEvent.toolCall.input.tasks), "Cursor MCP nested task array is visible to delegation parser");
  assertEqual(toolHeader(cursorToolEvent.toolCall).title, "StartDelegation", "Cursor MCP presentation uses the normalized tool name");

  const cursorRuntimeToolEnvelope = {
    type: "provider.tool",
    provider: "cursor",
    sessionId: "cursor-session",
    eventId: "cursor-runtime-tool",
    createdAt: "2026-04-30T00:00:00Z",
    itemId: "cursor-runtime-tool-id",
    nativeType: "tool_call:started",
    phase: "started",
    id: "cursor-runtime-tool-id",
    name: "terminal-64-StartDelegation",
    input: { context: "runtime context", tasks: [{ description: "runtime task" }] },
  };
  assert(isProviderRuntimeEvent(cursorRuntimeToolEnvelope), "canonical Cursor provider.tool envelope is recognized");
  const cursorRuntimeNormalized = providerRuntimeEventToNormalized(cursorRuntimeToolEnvelope);
  const cursorRuntimeTool = cursorRuntimeNormalized.find((event) => event.kind === "tool_call");
  assert(cursorRuntimeTool?.kind === "tool_call", "canonical Cursor provider.tool envelope normalizes into a tool call");
  assertEqual(cursorRuntimeTool.toolCall.name, "mcp__terminal-64__StartDelegation", "canonical Cursor tool envelope keeps normalized MCP naming");
  assertEqual(cursorRuntimeTool.toolCall.input.context, "runtime context", "canonical Cursor tool envelope preserves input");

  const cursorRuntimeContent = cursorDecoder.decode("cursor-session", JSON.stringify({
    type: "provider.content",
    provider: "cursor",
    sessionId: "cursor-session",
    eventId: "cursor-runtime-content",
    createdAt: "2026-04-30T00:00:01Z",
    phase: "delta",
    text: "streamed",
  }));
  assertEqual(cursorRuntimeContent[0]?.kind, "assistant_delta", "Cursor decoder ingests canonical provider.content envelopes");

  const cursorRuntimeTurn = cursorDecoder.decode("cursor-runtime-fallback", JSON.stringify({
    type: "provider.turn",
    provider: "cursor",
    sessionId: "cursor-runtime-fallback",
    eventId: "cursor-runtime-turn",
    createdAt: "2026-04-30T00:00:02Z",
    phase: "completed",
    result: "final fallback",
    isError: false,
  }));
  assertEqual(cursorRuntimeTurn[0]?.kind, "assistant_message", "Cursor canonical turn result still backfills assistant text when no content streamed");
  assertEqual(cursorRuntimeTurn[1]?.kind, "turn_completed", "Cursor canonical turn result still completes the turn");

  const sanitizedHistoryMessages = mapHistoryMessages([{
    id: "history-user-reminder",
    role: "user",
    content: "<system-reminder>\nInjected skill text\n</system-reminder>\n\nvisible prompt",
    timestamp: 0,
  }]);
  assertEqual(
    sanitizedHistoryMessages[0]?.content,
    "visible prompt",
    "history user messages strip injected system-reminder blocks from visible chat",
  );

  const historyMessages = mapHistoryMessages([{
    id: "history-message",
    role: "assistant",
    content: "",
    timestamp: 1,
    tool_calls: [
      { id: "history-read", name: "read_file", input: { filePath: "src/history.ts" } },
      { id: "history-search", name: "web_search", input: { q: "Terminal 64" } },
      { id: "history-mcp", name: "terminal-64/report_done", input: { summary: "done" } },
    ],
  }]);
  const historyTools = historyMessages[0]?.toolCalls ?? [];
  assertEqual(historyTools[0]?.name, "Read", "history tool aliases normalize to Claude tool names");
  assertEqual(getProviderToolFilePath(historyTools[0]?.input ?? {}), "src/history.ts", "history tool input normalizes filePath");
  assertEqual(historyTools[1]?.name, "WebSearch", "history web search aliases normalize to Claude tool names");
  assertEqual(historyTools[1]?.input.query, "Terminal 64", "history web search query normalizes");
  assertEqual(historyTools[2]?.name, "mcp__terminal-64__report_done", "history MCP slash names normalize to Claude MCP names");

  const lsTool = buildProviderToolCall({ id: "presentation-ls", name: "list_dir", input: { directory: "src/components/provider-chat" } });
  assertEqual(lsTool.name, "LS", "presentation fixture uses normalized Claude LS tool name");
  assert(isGroupableToolCall(lsTool), "presentation grouping is centralized for normalized LS tools");
  assertEqual(toolHeader(lsTool).title, "LS", "presentation headers come from centralized tool metadata");
  const lsGroup = toolGroupLabel([
    lsTool,
    buildProviderToolCall({ id: "presentation-ls-2", name: "ls", input: { path: "src/lib" } }),
  ]);
  assertEqual(lsGroup.name, "Listed 2 dirs", "presentation group labels come from centralized tool metadata");
  const shellPresentation = toolGroupItem(shellCall);
  assertEqual(shellPresentation.status, "done", "presentation expanded group items expose tool status metadata");
  assertEqual(shellPresentation.resultSummary, "2 chars", "presentation expanded group items expose output summary metadata");
  assertEqual(toolGroupKey(shellCall), "tool:Bash", "presentation grouping key uses normalized tool identity");
  assertEqual(toolGroupKey(codexMcpCall), "mcp:terminal-64:send_to_team", "MCP grouping key uses server and concrete tool identity");

  const groupedRows = buildChatVisualRows({
    messages: [
      { id: "user-grouping", role: "user", content: "inspect", timestamp: 1 },
      { id: "read-one", role: "assistant", content: "", timestamp: 2, toolCalls: [
        buildProviderToolCall({ id: "read-a", name: "read_file", input: { file: "src/a.ts" } }),
      ] },
      { id: "grep-one", role: "assistant", content: "", timestamp: 3, toolCalls: [
        buildProviderToolCall({ id: "grep-a", name: "grep", input: { pattern: "alpha" } }),
      ] },
      { id: "grep-two", role: "assistant", content: "", timestamp: 4, toolCalls: [
        buildProviderToolCall({ id: "grep-b", name: "grep", input: { pattern: "beta" } }),
      ] },
      { id: "bash-one", role: "assistant", content: "", timestamp: 5, toolCalls: [
        buildProviderToolCall({ id: "bash-a", name: "exec_command", input: { cmd: "npm test" } }),
      ] },
    ] satisfies ChatMessage[],
    autoCompactStatus: "idle",
    autoCompactStartedAt: null,
    isStreaming: false,
  }, false, false);
  const toolRows = groupedRows.filter((row) => row.kind === "tool" || row.kind === "group");
  assertEqual(toolRows.length, 3, "mixed tool-only bursts split into ordered same-identity rows");
  assert(toolRows[0]?.kind === "tool", "single Read remains its own tool row");
  assert(toolRows[1]?.kind === "group", "consecutive Grep calls collapse together");
  if (toolRows[1]?.kind === "group") {
    assert(toolRows[1].tcs.every((tc) => tc.name === "Grep"), "grouped row contains only matching tool identities");
  }
  assert(toolRows[2]?.kind === "tool", "Bash does not merge into the Grep group");

  const cursorMcpStatus = cursorDecoder.decode("cursor-session", JSON.stringify({
    type: "mcp_status",
    servers: [{
      name: "terminal-64",
      status: "ready",
      transport: "stdio",
      tools: [{ name: "StartDelegation" }],
    }],
  }));
  const cursorMcpEvent = cursorMcpStatus.find((event) => event.kind === "mcp_status");
  assert(cursorMcpEvent?.kind === "mcp_status", "Cursor synthetic MCP status normalizes into provider event");
  assertEqual(cursorMcpEvent.servers.length, 1, "Cursor MCP status keeps server list");

  return { name: "provider event/tool normalization fixtures", ok: true };
}

export function runProviderModularityVerification(): VerificationResult[] {
  return [
    verifyProviderManifestDefaults(),
    verifyProviderRuntimeFixtures(),
    verifyProviderLifecycleAndHistorySurfaceFixtures(),
    verifyProviderPermissionHelperFixtures(),
    verifyProviderPromptSpawnFixtures(),
    verifyProviderMetadataHelperFixtures(),
    verifyDelegationChildSpawnFixtures(),
    verifyDelegationWorkflowFixtures(),
    verifyProviderIpcRequestTypingFixtures(),
    verifyFutureProviderStubFixtures(),
    verifyCodexPermissionFixtures(),
    verifyProviderEventNormalizationFixtures(),
    verifyProviderStateMigrationFixture(),
    verifyProviderPickerLockFixtures(),
    verifyProviderAvailabilityFixtures(),
  ];
}
