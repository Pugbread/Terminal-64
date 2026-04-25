import type { ChatMessage, PermissionMode } from "../lib/types";
import type { ProviderId } from "../lib/providers";

export interface ProviderTurnInput {
  provider: ProviderId;
  sessionId: string;
  cwd: string;
  prompt: string;
  started: boolean;
  threadId?: string | null;
  selectedModel?: string | null | undefined;
  selectedEffort?: string | null | undefined;
  selectedCodexPermission?: string | null | undefined;
  permissionMode?: PermissionMode | undefined;
  permissionOverride?: PermissionMode | undefined;
  skipOpenwolf?: boolean | undefined;
  seedTranscript?: ChatMessage[] | null | undefined;
  resumeAtUuid?: string | null | undefined;
  forkParentSessionId?: string | null | undefined;
}

export interface ProviderTurnResult {
  clearSeedTranscript?: boolean;
  clearResumeAtUuid?: boolean;
  clearForkParentSessionId?: boolean;
}

export interface ProviderHistoryTruncateInput {
  provider: ProviderId;
  sessionId: string;
  cwd: string;
  keepMessages: number;
  preMessages: ChatMessage[];
  codexThreadId?: string | null | undefined;
}

export interface ProviderHistoryTruncateResult {
  resumeAtUuid?: string | null;
}
