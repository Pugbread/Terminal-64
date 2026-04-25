import { useCallback } from "react";
import { truncateProviderHistory } from "../lib/providerRuntime";
import { useClaudeStore } from "../stores/claudeStore";
import type { ProviderId } from "../lib/providers";

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
    const result = await truncateProviderHistory({
      provider,
      sessionId,
      cwd,
      keepMessages,
      preMessages: session?.messages ?? [],
      codexThreadId: session?.codexThreadId,
    });
    if (result.resumeAtUuid) {
      useClaudeStore.getState().setResumeAtUuid(sessionId, result.resumeAtUuid);
    }
  }, []);
}
