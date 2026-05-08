import { useCallback } from "react";
import { v4 as uuidv4 } from "uuid";
import { getDelegationPort, getDelegationSecret } from "../lib/tauriApi";
import type { PermissionMode } from "../lib/types";
import type { ProviderId } from "../lib/providers";
import { runProviderTurn } from "../lib/providerRuntime";
import {
  buildDelegationChildRuntimeMetadata,
  prepareDelegationChildProviderTurnInput,
  resolveDelegationChildRuntimeSettings,
} from "../lib/delegationChildRuntime";
import {
  buildDelegationChildSpawnPlan,
  resolveDelegationChildCwd,
} from "../lib/delegationWorkflow";
import { useCanvasStore } from "../stores/canvasStore";
import { useProviderSessionStore } from "../stores/providerSessionStore";
import type { ProviderControlValueMap } from "../stores/providerSessionStore";
import { useDelegationStore } from "../stores/delegationStore";

interface UseDelegationSpawnOptions {
  sessionId: string;
  effectiveCwd: string;
  selectedProvider: ProviderId;
  permissionMode: PermissionMode;
  selectedControls: ProviderControlValueMap;
  selectedProviderPermissionId: string;
  addUserMessage: (sessionId: string, text: string) => void;
}

export function useDelegationSpawn({
  sessionId,
  effectiveCwd,
  selectedProvider,
  permissionMode,
  selectedControls,
  selectedProviderPermissionId,
  addUserMessage,
}: UseDelegationSpawnOptions) {
  return useCallback(
    async (tasks: { description: string; agentName?: string }[], sharedContext: string) => {
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

      const parentSess = useProviderSessionStore.getState().sessions[sessionId];
      const appDir = resolveDelegationChildCwd({
        effectiveCwd,
        sessionCwd: parentSess?.cwd,
      });
      const childRuntime = resolveDelegationChildRuntimeSettings({
        parentSession: parentSess,
        selectedProvider,
        selectedControls,
        selectedProviderPermissionId,
      });

      group.tasks.forEach((task, i) => {
        const childSessionId = uuidv4();
        const childSpawn = buildDelegationChildSpawnPlan({
          sharedContext,
          taskDescription: task.description,
          agentName: task.agentName,
          taskIndex: i,
          taskCount: tasks.length,
          teamChatEnabled: delegationPort > 0,
        });

        delStore.setTaskSessionId(
          group.id,
          task.id,
          childSessionId,
          buildDelegationChildRuntimeMetadata(childRuntime, appDir),
        );
        delStore.updateTaskStatus(group.id, task.id, "running");

        useProviderSessionStore.getState().createSession(
          childSessionId,
          childSpawn.childName,
          true,
          childRuntime.inheritSkipOpenwolf,
          appDir,
          childRuntime.provider,
          true,
        );
        for (const [controlId, value] of Object.entries(childRuntime.selectedControls)) {
          useProviderSessionStore.getState().setProviderControl(
            childSessionId,
            childRuntime.provider,
            controlId,
            value,
          );
        }
        useProviderSessionStore.getState().setProviderPermission(
          childSessionId,
          childRuntime.provider,
          childRuntime.selectedProviderPermissionId,
        );
        addUserMessage(childSessionId, childSpawn.initialPrompt);

        setTimeout(() => {
          const startChild = async () => {
            const turnInput = await prepareDelegationChildProviderTurnInput({
              ...childRuntime,
              sessionId: childSessionId,
              cwd: appDir,
              prompt: childSpawn.initialPrompt,
              mcp: {
                delegationPort,
                delegationSecret,
                groupId: group.id,
                agentLabel: childSpawn.agentLabel,
              },
            });
            const result = await runProviderTurn(turnInput);
            const store = useProviderSessionStore.getState();
            if (result.clearSeedTranscript) store.clearSeedTranscript(childSessionId);
            if (result.clearResumeAtUuid) store.setResumeAtUuid(childSessionId, null);
            if (result.clearForkParentSessionId) store.setForkParentSessionId(childSessionId, null);
            store.incrementPromptCount(childSessionId);
          };

          startChild().catch((err) => {
            console.warn(`[delegation] Failed to start child ${childSessionId}:`, err);
            delStore.updateTaskStatus(group.id, task.id, "failed", String(err));
          });
        }, i * 500);
      });
    },
    [
      sessionId,
      effectiveCwd,
      selectedProvider,
      permissionMode,
      selectedControls,
      selectedProviderPermissionId,
      addUserMessage,
    ],
  );
}
