import { useCallback } from "react";
import { createCheckpoint, readFile } from "../lib/tauriApi";
import { runProviderTurn } from "../lib/providerRuntime";
import { isAbsolutePath, joinPath } from "../lib/platform";
import { useClaudeStore } from "../stores/claudeStore";
import type { PermissionMode } from "../lib/types";
import type { ProviderTurnInput } from "../contracts/providerRuntime";

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
    async (
      prompt: string,
      permissionOverride?: PermissionMode,
      opts?: { codexCollaborationMode?: "plan" | "default" },
    ) => {
      const store = useClaudeStore.getState();
      const sess = store.sessions[sessionId];
      const started = sess?.hasBeenStarted ?? false;
      const provider = sess?.provider ?? "anthropic";
      try {
        if (sess && sess.modifiedFiles.length > 0) {
          const snapshotBase = sess.cwd || effectiveCwd;
          const resolveSnapshotPath = (fp: string) =>
            fp && !isAbsolutePath(fp) && snapshotBase ? joinPath(snapshotBase, fp) : fp;
          const results = await Promise.allSettled(
            sess.modifiedFiles.map(async (fp) => {
              const path = resolveSnapshotPath(fp);
              try { return { path, content: await readFile(path) }; }
              catch { return { path, content: "" }; }
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

        let providerPrompt = prompt;
        let codexCollaborationMode = opts?.codexCollaborationMode;
        if (provider === "openai" && !codexCollaborationMode) {
          const codexPlanMatch = prompt.match(/^\/plan(?:\s+([\s\S]*))?$/i);
          if (codexPlanMatch) {
            codexCollaborationMode = "plan";
            providerPrompt = codexPlanMatch[1]?.trim() || "Create a plan.";
          }
        }

        const turnInput: ProviderTurnInput = {
          provider,
          sessionId,
          cwd: effectiveCwd,
          prompt: providerPrompt,
          started,
          threadId: sess?.codexThreadId ?? null,
          selectedModel,
          selectedEffort,
          selectedCodexPermission,
          permissionMode,
          skipOpenwolf: sess?.skipOpenwolf || false,
          seedTranscript: sess?.seedTranscript ?? null,
          resumeAtUuid: sess?.resumeAtUuid ?? null,
          forkParentSessionId: sess?.forkParentSessionId ?? null,
          codexCollaborationMode,
        };
        if (permissionOverride !== undefined) {
          turnInput.permissionOverride = permissionOverride;
        }

        const result = await runProviderTurn(turnInput);

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
