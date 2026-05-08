import { useMemo } from "react";
import type { ChatMessage as ChatMessageData, ToolCall } from "../../lib/types";
import { isGroupableToolCall, toolGroupKey } from "./toolPresentation";

export type VisualRow =
  | { kind: "turnDivider"; key: string; dur: number }
  | { kind: "group"; key: string; msgId: string; tcs: ToolCall[] }
  | { kind: "tool"; key: string; msgId: string; tc: ToolCall }
  | { kind: "message"; key: string; msg: ChatMessageData }
  | { kind: "streaming"; key: string }
  | {
      kind: "compact";
      key: string;
      status: "compacting" | "done";
      startedAt: number | null;
    }
  | { kind: "finishedTail"; key: string; dur: number };

export interface UserPromptRow {
  id: string;
  idx: number;
  content: string;
  timestamp: number;
  isCmd: boolean;
}

interface ChatRowsSession {
  messages: ChatMessageData[];
  autoCompactStatus: "idle" | "compacting" | "done";
  autoCompactStartedAt: number | null;
  isStreaming: boolean;
}

function toolLayoutSignature(toolCalls: ToolCall[] | undefined): string {
  if (!toolCalls?.length) return "0";
  return toolCalls
    .map((tc) => {
      const resultLen = typeof tc.result === "string" ? tc.result.length : 0;
      const inputLen = JSON.stringify(tc.input ?? {}).length;
      return `${tc.id}:${tc.name}:${resultLen}:${inputLen}:${tc.isError ? 1 : 0}`;
    })
    .join("|");
}

function messageLayoutKey(msg: ChatMessageData): string {
  if (msg.role === "assistant") {
    return `${msg.id}:${msg.content?.length ?? 0}:${toolLayoutSignature(msg.toolCalls)}`;
  }
  return msg.id;
}

export function findPromptVisualRowIndex(rows: VisualRow[], msgId: string): number {
  return rows.findIndex(
    (row) =>
      (row.kind === "message" && row.msg.id === msgId)
      || ((row.kind === "group" || row.kind === "tool") && row.msgId === msgId),
  );
}

type ToolRunItem = {
  msgId: string;
  tc: ToolCall;
};

function pushToolRunRows(rows: VisualRow[], run: ToolRunItem[]): void {
  if (!run.length) return;
  const msgId = run[0]!.msgId;
  const tcs = run.map((item) => item.tc);
  if (run.length === 1) {
    rows.push({ kind: "tool", key: `rt-${msgId}:${toolLayoutSignature(tcs)}`, msgId, tc: tcs[0]! });
    return;
  }
  rows.push({ kind: "group", key: `rg-${msgId}:${toolGroupKey(tcs[0]!)}:${toolLayoutSignature(tcs)}`, msgId, tcs });
}

function pushToolOnlyRows(rows: VisualRow[], items: ToolRunItem[]): void {
  let run: ToolRunItem[] = [];
  let runKey = "";
  for (const item of items) {
    const key = toolGroupKey(item.tc);
    if (run.length > 0 && key !== runKey) {
      pushToolRunRows(rows, run);
      run = [];
    }
    run.push(item);
    runKey = key;
  }
  pushToolRunRows(rows, run);
}

export function buildChatVisualRows(
  session: ChatRowsSession | undefined,
  hasStreamingText: boolean,
  supportsCompact: boolean,
): VisualRow[] {
  if (!session) return [];
  const rows: VisualRow[] = [];
  const msgs = session.messages;
  let lastCompactUserIndex = -1;
  if (supportsCompact) {
    for (let idx = msgs.length - 1; idx >= 0; idx--) {
      const m = msgs[idx];
      if (m?.role === "user" && /^\/compact\b/i.test(m.content || "")) {
        lastCompactUserIndex = idx;
        break;
      }
    }
  }
  let i = 0;
  let lastUserTs: number | null = null;
  while (i < msgs.length) {
    const msg = msgs[i]!;
    const prevMsg = msgs[i - 1];
    if (
      msg.role === "user" &&
      lastUserTs !== null &&
      i > 0 &&
      prevMsg &&
      prevMsg.role === "assistant"
    ) {
      const dur = prevMsg.timestamp - lastUserTs;
      if (dur > 2000) {
        rows.push({ kind: "turnDivider", key: `fin-${msg.id}`, dur });
      }
    }
    if (msg.role === "user") lastUserTs = msg.timestamp;
    if (
      msg.role === "assistant" &&
      !msg.content &&
      msg.toolCalls?.length &&
      msg.toolCalls.every(isGroupableToolCall)
    ) {
      const toolItems: ToolRunItem[] = msg.toolCalls.map((tc) => ({ msgId: msg.id, tc }));
      let j = i + 1;
      while (j < msgs.length) {
        const next = msgs[j];
        if (
          next &&
          next.role === "assistant" &&
          !next.content &&
          next.toolCalls?.length &&
          next.toolCalls.every(isGroupableToolCall)
        ) {
          toolItems.push(...next.toolCalls.map((tc) => ({ msgId: next.id, tc })));
          j++;
        } else break;
      }
      pushToolOnlyRows(rows, toolItems);
      i = j;
      continue;
    }
    rows.push({ kind: "message", key: messageLayoutKey(msg), msg });
    if (supportsCompact && msg.role === "user" && /^\/compact\b/i.test(msg.content || "")) {
      const isLastCompact = i === lastCompactUserIndex;
      if (isLastCompact && session.autoCompactStatus !== "idle") {
        rows.push({
          kind: "compact",
          key: `compact-${msg.id}`,
          status: session.autoCompactStatus,
          startedAt: session.autoCompactStartedAt,
        });
      } else {
        rows.push({ kind: "compact", key: `compact-${msg.id}`, status: "done", startedAt: null });
      }
    }
    i++;
  }
  const lastMsg = msgs[msgs.length - 1];
  if (
    !session.isStreaming &&
    lastUserTs !== null &&
    lastMsg &&
    lastMsg.role === "assistant"
  ) {
    const dur = lastMsg.timestamp - lastUserTs;
    if (dur > 2000) {
      rows.push({ kind: "finishedTail", key: `fin-tail-${messageLayoutKey(lastMsg)}`, dur });
    }
  }
  if (hasStreamingText) {
    rows.push({ kind: "streaming", key: "__streaming__" });
  }
  return rows;
}

export function useChatRows(session: ChatRowsSession | undefined, hasStreamingText: boolean, supportsCompact: boolean) {
  const visualRows = useMemo<VisualRow[]>(() => buildChatVisualRows(session, hasStreamingText, supportsCompact), [
    session?.messages,
    session?.autoCompactStatus,
    session?.autoCompactStartedAt,
    session?.isStreaming,
    hasStreamingText,
    supportsCompact,
  ]);

  const visualLayoutSignature = useMemo(
    () => visualRows.map((row) => row.key).join("\n"),
    [visualRows],
  );

  const userPrompts = useMemo<UserPromptRow[]>(() => {
    const out: UserPromptRow[] = [];
    const msgs = session?.messages ?? [];
    let promptIdx = 0;
    for (const msg of msgs) {
      if (msg.role !== "user") continue;
      if (!msg.content) continue;
      if (msg.content.startsWith("All delegated tasks have finished")) continue;
      promptIdx += 1;
      out.push({
        id: msg.id,
        idx: promptIdx,
        content: msg.content,
        timestamp: msg.timestamp,
        isCmd: /^\//.test(msg.content.trim()),
      });
    }
    return out;
  }, [session?.messages]);

  return { visualRows, visualLayoutSignature, userPrompts };
}
