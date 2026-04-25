import { useCallback } from "react";
import { v4 as uuidv4 } from "uuid";
import { createClaudeSession, createCodexSession, createMcpConfigFile, ensureCodexMcp, ensureCodexSkills, getDelegationPort, getDelegationSecret } from "../lib/tauriApi";
import type { PermissionMode } from "../lib/types";
import type { ProviderId } from "../lib/providers";
import { useCanvasStore } from "../stores/canvasStore";
import { useClaudeStore } from "../stores/claudeStore";
import { useDelegationStore } from "../stores/delegationStore";

interface UseDelegationSpawnOptions {
  sessionId: string;
  effectiveCwd: string;
  selectedProvider: ProviderId;
  permissionMode: PermissionMode;
  addUserMessage: (sessionId: string, text: string) => void;
}

export function useDelegationSpawn({
  sessionId,
  effectiveCwd,
  selectedProvider,
  permissionMode,
  addUserMessage,
}: UseDelegationSpawnOptions) {
  return useCallback(
    async (tasks: { description: string }[], sharedContext: string) => {
      const delStore = useDelegationStore.getState();
      const group = delStore.createGroup(sessionId, tasks, "auto", sharedContext || undefined, permissionMode);

      const canvas = useCanvasStore.getState();
      const parentPanel = canvas.terminals.find((t) => t.terminalId === sessionId);
      const parentW = parentPanel?.width || 600;
      const parentH = parentPanel?.height || 400;
      canvas.addSharedChatPanel(
        group.id,
        parentPanel?.x || 80,
        (parentPanel?.y || 80) + parentH + 20,
        parentW,
        Math.min(300, parentH * 0.6),
      );

      let delegationPort = 0;
      let delegationSecret = "";
      try {
        delegationPort = await getDelegationPort();
        delegationSecret = await getDelegationSecret();
      } catch (err) {
        console.warn("[delegation] Failed to get port/secret:", err);
      }

      const parentSess = useClaudeStore.getState().sessions[sessionId];
      const sessCwd = parentSess?.cwd;
      const appDir = (effectiveCwd && effectiveCwd !== "." && effectiveCwd !== "/")
        ? effectiveCwd
        : (sessCwd && sessCwd !== "." && sessCwd !== "/")
          ? sessCwd
          : "";
      const inheritSkipOpenwolf = !!parentSess?.skipOpenwolf;
      const childProvider = parentSess?.provider ?? selectedProvider;

      let mcpConfigPath = "";
      if (childProvider === "anthropic" && delegationPort > 0 && delegationSecret) {
        try {
          mcpConfigPath = await createMcpConfigFile(delegationPort, delegationSecret, group.id, "Agent");
        } catch (err) {
          console.warn("[delegation] Failed to create MCP config:", err);
        }
      }

      group.tasks.forEach((task, i) => {
        const childSessionId = uuidv4();
        const childName = `[D] ${task.description.slice(0, 30)}`;

        delStore.setTaskSessionId(group.id, task.id, childSessionId);
        delStore.updateTaskStatus(group.id, task.id, "running");

        const channelNote = delegationPort > 0
          ? `\n\nIMPORTANT — Team Coordination via terminal-64 MCP:
You are part of a team of ${tasks.length} agents working in the same codebase. You MUST use the team chat to coordinate:

1. send_to_team — Post a message to the shared team chat. Do this:
   • At the START of your work (announce what you're about to do)
   • Before modifying any shared files (to avoid conflicts)
   • After completing major milestones
   • If you encounter issues or blockers
2. read_team — Check what other agents have posted. Do this BEFORE starting work and periodically during long tasks to stay aware of what others are doing.
3. report_done — When your task is fully complete, call this with a summary of what you did and what files you changed.

Coordinate actively. If another agent is working on a file you need, mention it in team chat and work around it. Communication prevents conflicts.`
          : "";

        const initialPrompt = `Context: ${sharedContext}\n\nYour task: ${task.description}\n\nYou are agent "Agent ${i + 1}" — one of ${tasks.length} parallel agents. Focus on YOUR specific task only.${channelNote}\n\nWhen done, call report_done (if available) or state your task is complete.`;

        const mcpEnv = delegationPort > 0 && delegationSecret
          ? {
            T64_DELEGATION_PORT: String(delegationPort),
            T64_DELEGATION_SECRET: delegationSecret,
            T64_GROUP_ID: group.id,
            T64_AGENT_LABEL: `Agent ${i + 1}`,
          }
          : undefined;

        useClaudeStore.getState().createSession(childSessionId, childName, true, inheritSkipOpenwolf, appDir, childProvider);
        addUserMessage(childSessionId, initialPrompt);

        setTimeout(() => {
          if (childProvider === "openai") {
            Promise.allSettled([ensureCodexMcp(appDir), ensureCodexSkills()])
              .then(() => createCodexSession({
                session_id: childSessionId,
                cwd: appDir,
                prompt: initialPrompt,
                yolo: true,
                skip_git_repo_check: true,
                ...(mcpEnv ? { mcp_env: mcpEnv } : {}),
              }, true))
              .catch((err) => {
                console.warn(`[delegation] Failed to start Codex child ${childSessionId}:`, err);
                delStore.updateTaskStatus(group.id, task.id, "failed", String(err));
              });
          } else {
            createClaudeSession({
              session_id: childSessionId,
              cwd: appDir,
              prompt: initialPrompt,
              permission_mode: "bypass_all",
              ...(mcpConfigPath ? { mcp_config: mcpConfigPath } : {}),
              no_session_persistence: true,
            }, inheritSkipOpenwolf).catch((err) => {
              console.warn(`[delegation] Failed to start child ${childSessionId}:`, err);
              delStore.updateTaskStatus(group.id, task.id, "failed", String(err));
            });
          }
        }, i * 500);
      });
    },
    [sessionId, effectiveCwd, selectedProvider, permissionMode, addUserMessage],
  );
}
