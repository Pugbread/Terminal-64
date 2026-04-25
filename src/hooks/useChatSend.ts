import { useCallback } from "react";
import { createCheckpoint, readFile } from "../lib/tauriApi";
import { runProviderTurn } from "../lib/providerRuntime";
import { useClaudeStore } from "../stores/claudeStore";
import type { PermissionMode } from "../lib/types";

interface UseChatSendOptions {
  sessionId: string;
  effectiveCwd: string;
  permissionMode: PermissionMode;
  selectedModel: string;
  selectedEffort: string;
  selectedCodexPermission: string;
  incrementPromptCount: (sessionId: string) => void;
}

export function useChatSend({
  sessionId,
  effectiveCwd,
  permissionMode,
  selectedModel,
  selectedEffort,
  selectedCodexPermission,
  incrementPromptCount,
}: UseChatSendOptions) {
  return useCallback(
    async (prompt: string, permissionOverride?: PermissionMode) => {
      const store = useClaudeStore.getState();
      const sess = store.sessions[sessionId];
      const started = sess?.hasBeenStarted ?? false;
      const provider = sess?.provider ?? "anthropic";
      try {
        if (sess && sess.modifiedFiles.length > 0) {
          const results = await Promise.allSettled(
            sess.modifiedFiles.map(async (fp) => {
              try { return { path: fp, content: await readFile(fp) }; }
              catch { return { path: fp, content: "" }; }
            }),
          );
          const snapshots = results.map((r) => (r as PromiseFulfilledResult<{ path: string; content: string }>).value);
          createCheckpoint(sessionId, sess.promptCount + 1, snapshots).catch(() => {});
        }
        if (!started && (!effectiveCwd || effectiveCwd === ".")) {
          store.setError(sessionId, "No working directory set. Create a new session.");
          return;
        }
        if (effectiveCwd && effectiveCwd !== "." && (!sess?.cwd || sess.cwd !== effectiveCwd)) {
          store.setCwd(sessionId, effectiveCwd);
        }

        const result = await runProviderTurn({
          provider,
          sessionId,
          cwd: effectiveCwd,
          prompt,
          started,
          threadId: sess?.codexThreadId ?? null,
          selectedModel,
          selectedEffort,
          selectedCodexPermission,
          permissionMode,
          permissionOverride,
          skipOpenwolf: sess?.skipOpenwolf || false,
          seedTranscript: sess?.seedTranscript ?? null,
          resumeAtUuid: sess?.resumeAtUuid ?? null,
          forkParentSessionId: sess?.forkParentSessionId ?? null,
        });

        if (result.clearSeedTranscript) store.clearSeedTranscript(sessionId);
        if (result.clearResumeAtUuid) store.setResumeAtUuid(sessionId, null);
        if (result.clearForkParentSessionId) store.setForkParentSessionId(sessionId, null);
        incrementPromptCount(sessionId);
      } catch (err) {
        useClaudeStore.getState().setError(sessionId, String(err));
      }
    },
    [sessionId, effectiveCwd, permissionMode, selectedModel, selectedEffort, selectedCodexPermission, incrementPromptCount],
  );
}
