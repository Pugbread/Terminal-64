import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

type PendingEvent =
  | { type: "chunk"; id: string; text: string }
  | { type: "done"; id: string };

export async function rewritePromptStream(
  prompt: string,
  onChunk: (text: string) => void,
  opts?: { isVoice?: boolean },
): Promise<void> {
  let resolveDone!: () => void;
  const donePromise = new Promise<void>((r) => { resolveDone = r; });

  // Set up listeners BEFORE invoke to avoid races with fast CLI responses.
  let rewriteId: string | null = null;
  const pending: PendingEvent[] = [];

  const unChunk = await listen<{ id: string; text: string }>("rewrite-chunk", (event) => {
    if (rewriteId && event.payload.id === rewriteId) {
      onChunk(event.payload.text);
    } else if (!rewriteId) {
      pending.push({ type: "chunk", id: event.payload.id, text: event.payload.text });
    }
  });

  const unDone = await listen<{ id: string }>("rewrite-done", (event) => {
    if (rewriteId && event.payload.id === rewriteId) resolveDone();
    else if (!rewriteId) {
      pending.push({ type: "done", id: event.payload.id });
    }
  });

  // Now start the rewrite
  try {
    rewriteId = await invoke("rewrite_prompt", { prompt, isVoice: opts?.isVoice ?? false });
  } catch (e) {
    unChunk();
    unDone();
    throw e;
  }

  // Replay any events that arrived before we had the ID
  for (const evt of pending) {
    if (evt.id === rewriteId) {
      if (evt.type === "done") resolveDone();
      else onChunk(evt.text);
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      donePromise,
      new Promise<void>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Rewrite timed out")), 120000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    unChunk();
    unDone();
  }
}
