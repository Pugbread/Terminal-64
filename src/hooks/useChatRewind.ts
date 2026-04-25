import { useCallback } from "react";
import { truncateProviderHistory } from "../lib/providerRuntime";
import { useClaudeStore } from "../stores/claudeStore";
import type { ProviderId } from "../lib/providers";
import type { ProviderHistoryTruncateInput } from "../contracts/providerRuntime";

interface RewindHistoryInput {
  provider: ProviderId;
  sessionId: string;
  cwd: string;
  keepMessages: number;
}

export function useChatRewind() {
  return useCallback(async ({
    provider,
    sessionId,
    cwd,
    keepMessages,
  }: RewindHistoryInput) => {
    const session = useClaudeStore.getState().sessions[sessionId];
    const input: ProviderHistoryTruncateInput = {
      provider,
      sessionId,
      cwd,
      keepMessages,
      preMessages: session?.messages ?? [],
    };
    if (session?.codexThreadId !== undefined) {
      input.codexThreadId = session.codexThreadId;
    }
    const result = await truncateProviderHistory(input);
    if (result.resumeAtUuid) {
      useClaudeStore.getState().setResumeAtUuid(sessionId, result.resumeAtUuid);
    }
  }, []);
}
