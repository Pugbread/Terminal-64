import { useCallback } from "react";
import { useCanvasStore } from "../stores/canvasStore";
import { useClaudeStore } from "../stores/claudeStore";
import { prepareProviderFork } from "../lib/providerRuntime";
import { forkCodexThread } from "../lib/tauriApi";

interface UseChatForkOptions {
  sessionId: string;
  effectiveCwd: string;
}

export function useChatFork({ sessionId, effectiveCwd }: UseChatForkOptions) {
  return useCallback(async (messageId: string) => {
    const store = useClaudeStore.getState();
    const sess = store.sessions[sessionId];
    if (!sess) return;

    const msgIdx = sess.messages.findIndex((m) => m.id === messageId);
    if (msgIdx < 0) return;
    const forkedMessages = sess.messages.slice(0, msgIdx);

    const canvas = useCanvasStore.getState();
    const parentPanel = canvas.terminals.find((t) => t.terminalId === sessionId);
    const x = parentPanel?.x ?? 80;
    const y = (parentPanel?.y ?? 80) - (parentPanel?.height ?? 400) - 20;
    const w = parentPanel?.width;
    const h = parentPanel?.height;

    const newPanel = canvas.addClaudeTerminalAt(
      effectiveCwd, false, undefined, undefined, x, y, w, h,
    );

    let forkedCodexThreadId: string | null = null;
    let shouldSeedCodexTranscript = false;

    if (forkedMessages.length > 0 && sess.provider === "anthropic") {
      try {
        await prepareProviderFork(sess.provider, sessionId, newPanel.terminalId, effectiveCwd, msgIdx);
      } catch (err) {
        console.warn("[fork] provider fork preparation failed; falling back to first-turn fork handling:", err);
      }
    } else if (forkedMessages.length > 0 && sess.provider === "openai" && sess.codexThreadId) {
      const totalTurns = sess.messages.filter((m) => m.role === "user").length;
      const keepTurns = forkedMessages.filter((m) => m.role === "user").length;
      const dropTurns = Math.max(0, totalTurns - keepTurns);
      try {
        forkedCodexThreadId = await forkCodexThread(sess.codexThreadId, effectiveCwd, dropTurns);
      } catch (err) {
        console.warn("[fork] Codex app-server fork failed; falling back to seeded transcript:", err);
        shouldSeedCodexTranscript = true;
      }
    } else if (forkedMessages.length > 0 && sess.provider === "openai") {
      shouldSeedCodexTranscript = true;
    }

    store.createSession(newPanel.terminalId, undefined, false, undefined, sess.cwd, sess.provider);
    if (forkedCodexThreadId) {
      store.setCodexThreadId(newPanel.terminalId, forkedCodexThreadId);
    }
    if (forkedMessages.length > 0) {
      store.loadFromDisk(newPanel.terminalId, forkedMessages);
      if (sess.provider === "openai" && shouldSeedCodexTranscript) {
        store.setSeedTranscript(newPanel.terminalId, forkedMessages);
      }
    }
    store.setCwd(newPanel.terminalId, effectiveCwd);
  }, [sessionId, effectiveCwd]);
}
