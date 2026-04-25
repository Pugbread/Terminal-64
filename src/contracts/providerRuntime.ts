import type { ChatMessage, PermissionMode } from "../lib/types";
import type { ProviderId } from "../lib/providers";

export interface ProviderTurnInput {
  provider: ProviderId;
  sessionId: string;
  cwd: string;
  prompt: string;
  started: boolean;
  threadId?: string | null;
  selectedModel?: string | null;
  selectedEffort?: string | null;
  selectedCodexPermission?: string | null;
  permissionMode?: PermissionMode;
  permissionOverride?: PermissionMode;
  skipOpenwolf?: boolean;
  seedTranscript?: ChatMessage[] | null;
  resumeAtUuid?: string | null;
  forkParentSessionId?: string | null;
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
  codexThreadId?: string | null;
}

export interface ProviderHistoryTruncateResult {
  resumeAtUuid?: string | null;
}
