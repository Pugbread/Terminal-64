import {
  cancelClaude,
  cancelCodex,
  closeClaudeSession,
  closeCodexSession,
  createClaudeSession,
  createCodexSession,
  ensureCodexMcp,
  ensureCodexSkills,
  ensureT64Mcp,
  findRewindUuid,
  forkSessionJsonl,
  rollbackCodexThread,
  sendClaudePrompt,
  sendCodexPrompt,
  truncateCodexRollout,
  truncateSessionJsonlByMessages,
} from "./tauriApi";
import type { PermissionMode, ChatMessage } from "./types";
import type { CreateCodexRequest, SendCodexPromptRequest } from "../contracts/providerIpc";
import { decodeCodexPermission, type ProviderId } from "./providers";
import type {
  ProviderHistoryTruncateInput,
  ProviderHistoryTruncateResult,
  ProviderTurnInput,
  ProviderTurnResult,
} from "../contracts/providerRuntime";

export async function cancelProviderSession(sessionId: string, provider: ProviderId): Promise<void> {
  return provider === "openai" ? cancelCodex(sessionId) : cancelClaude(sessionId);
}

export async function closeProviderSession(sessionId: string, provider: ProviderId): Promise<void> {
  return provider === "openai" ? closeCodexSession(sessionId) : closeClaudeSession(sessionId);
}

export function codexPermissionForOverride(current: string, override?: PermissionMode) {
  if (override === "bypass_all") return decodeCodexPermission("yolo");
  if (override === "accept_edits" || override === "auto") return decodeCodexPermission("full-auto");
  if (override === "plan") return decodeCodexPermission("read-only");
  return decodeCodexPermission(current);
}

function renderSeedTranscript(messages: ChatMessage[]): string {
  return messages.map((m) => {
    const who = m.role === "user" ? "User" : "Assistant";
    const text = (m.content || "").trim();
    const tools = m.toolCalls?.length
      ? "\n" + m.toolCalls.map((tc) => {
        const args = Object.keys(tc.input || {}).length ? ` ${JSON.stringify(tc.input)}` : "";
        return `Tool: ${tc.name}${args}`;
      }).join("\n")
      : "";
    return `${who}: ${text}${tools}`.trim();
  }).join("\n\n");
}

export function promptWithCodexSeed(prompt: string, seedTranscript: ChatMessage[] | null | undefined): string {
  if (!seedTranscript?.length) return prompt;
  return `You are continuing from a forked Terminal 64 conversation. Prior transcript:\n\n${renderSeedTranscript(seedTranscript)}\n\nContinue from there and answer this new user message:\n\n${prompt}`;
}

export async function runProviderTurn(input: ProviderTurnInput): Promise<ProviderTurnResult> {
  if (input.provider === "openai") {
    await Promise.allSettled([ensureCodexMcp(input.cwd), ensureCodexSkills()]);
    const prompt = promptWithCodexSeed(input.prompt, input.seedTranscript);
    const codexPerm = codexPermissionForOverride(
      input.selectedCodexPermission || "workspace",
      input.permissionOverride,
    );
    const codexCreate: CreateCodexRequest = {
      session_id: input.sessionId,
      cwd: input.cwd,
      prompt,
      ...(input.selectedModel ? { model: input.selectedModel } : {}),
      ...(input.selectedEffort ? { effort: input.selectedEffort } : {}),
      ...codexPerm,
    };
    const codexSend: SendCodexPromptRequest = {
      ...codexCreate,
      ...(input.threadId ? { thread_id: input.threadId } : {}),
    };
    if (input.threadId) {
      try {
        await sendCodexPrompt(codexSend, input.skipOpenwolf);
      } catch {
        await createCodexSession(codexCreate, input.skipOpenwolf);
      }
    } else {
      try {
        await createCodexSession(codexCreate, input.skipOpenwolf);
      } catch {
        await sendCodexPrompt(codexSend, input.skipOpenwolf);
      }
    }
    return { clearSeedTranscript: !!input.seedTranscript?.length };
  }

  const req = {
    session_id: input.sessionId,
    cwd: input.cwd,
    prompt: input.prompt,
    permission_mode: input.permissionOverride || input.permissionMode || "default",
    ...(input.selectedModel ? { model: input.selectedModel } : {}),
    ...(input.selectedEffort ? { effort: input.selectedEffort } : {}),
  };

  if (!input.started) {
    await ensureT64Mcp(input.cwd).catch(() => {});
  }
  if (input.forkParentSessionId) {
    await sendClaudePrompt({ ...req, cwd: input.cwd, fork_session: input.forkParentSessionId }, input.skipOpenwolf);
    return { clearForkParentSessionId: true };
  }
  if (input.resumeAtUuid) {
    try {
      await sendClaudePrompt({ ...req, cwd: input.cwd, resume_session_at: input.resumeAtUuid }, input.skipOpenwolf);
      return { clearResumeAtUuid: true };
    } catch (err) {
      console.log("[providerRuntime] Claude resume_at failed, falling back to create:", err);
      await createClaudeSession(req, input.skipOpenwolf);
      return { clearResumeAtUuid: true };
    }
  }
  if (input.started) {
    try {
      await sendClaudePrompt({ ...req, cwd: input.cwd }, input.skipOpenwolf);
    } catch {
      await createClaudeSession(req, input.skipOpenwolf);
    }
  } else {
    try {
      await createClaudeSession(req, input.skipOpenwolf);
    } catch {
      await sendClaudePrompt({ ...req, cwd: input.cwd }, input.skipOpenwolf);
    }
  }
  return {};
}

export async function truncateProviderHistory(input: ProviderHistoryTruncateInput): Promise<ProviderHistoryTruncateResult> {
  if (input.provider === "openai") {
    if (input.codexThreadId) {
      const totalTurns = input.preMessages.filter((m) => m.role === "user").length;
      const keepTurns = input.preMessages.slice(0, input.keepMessages).filter((m) => m.role === "user").length;
      const dropTurns = Math.max(0, totalTurns - keepTurns);
      try {
        await rollbackCodexThread(input.codexThreadId, input.cwd, dropTurns);
      } catch (err) {
        console.warn("[providerRuntime] Codex app-server rollback failed, falling back to rollout truncation:", err);
        await truncateCodexRollout(input.codexThreadId, dropTurns);
      }
    }
    return {};
  }

  await truncateSessionJsonlByMessages(input.sessionId, input.cwd, input.keepMessages);
  const resumeAtUuid = await findRewindUuid(input.sessionId, input.cwd, input.keepMessages);
  return { resumeAtUuid };
}

export async function prepareProviderFork(
  provider: ProviderId,
  parentSessionId: string,
  newSessionId: string,
  cwd: string,
  keepMessages: number,
): Promise<void> {
  if (provider === "anthropic") {
    await forkSessionJsonl(parentSessionId, newSessionId, cwd, keepMessages);
  }
}
