import { useEffect, useState } from "react";
import { useVoiceStore } from "../../stores/voiceStore";

// ASCII mascot frames per voice state. Each entry is an array of frames the
// renderer cycles through at a state-specific cadence. Lines are padded to a
// fixed width so the mascot doesn't wobble between frames.
//
// Shape: a little 3-row robot head. ___  brow, [eyes], /|_|\ body/arms.
const FRAMES: Record<string, { frames: string[]; interval: number }> = {
  // Idle = sleeping. Slow Zzz drift + closed eyes.
  off: {
    interval: 800,
    frames: [
      "  ___     \n [-_-]  z \n  |_|   Z ",
      "  ___   Z \n [-_-] z  \n  |_|    z",
      "  ___  z  \n [-_-]  Z \n  |_|   z ",
      "  ___    z\n [-_-] Z  \n  |_|  z  ",
    ],
  },
  idle: {
    interval: 700,
    frames: [
      "  ___     \n [-_-]  z \n  |_|   Z ",
      "  ___   Z \n [-_-] z  \n  |_|    z",
      "  ___  z  \n [-_-]  Z \n  |_|   z ",
      "  ___    z\n [-_-] Z  \n  |_|  z  ",
    ],
  },
  // Listening = wide eyes, ears up, looking side to side.
  listening: {
    interval: 260,
    frames: [
      "  ___     \n [O_O]    \n  |_|     ",
      "  ___     \n [O_O]>   \n  |_|     ",
      "  ___     \n<[O_O]    \n  |_|     ",
      "  ___     \n [O_O]    \n  |_|     ",
    ],
  },
  // Dictating = dancing! Arms swap sides, body shifts.
  dictating: {
    interval: 180,
    frames: [
      "  ___     \n [^_^]    \n /|_|\\    ",
      "  ___     \n [^_^]    \n \\|_|/    ",
      "  ___     \n [o_O]    \n  |_|~    ",
      "  ___     \n [O_o]    \n ~|_|     ",
      "  ___     \n [^_^]    \n /|_|\\    ",
      "  ___     \n [^o^]    \n  |_|\\~   ",
    ],
  },
  // Awaiting command = thinking. Head tilts, question marks drift in.
  awaitingCommand: {
    interval: 320,
    frames: [
      "  ___   ? \n [o.o]    \n  |_|     ",
      "  ___    ?\n [o.o]  ? \n  |_|     ",
      "  ___     \n [o.o]   ?\n  |_|    ?",
      "  ___   ? \n [-.o]  ? \n  |_|     ",
    ],
  },
};

// Hard error (mic permission denied, runtime crash) — red, shaky, dead eyes.
const HARD_ERROR_FRAMES: string[] = [
  "  ___     \n [x_x]    \n  |_|     ",
  "  ___     \n [X_x]    \n  |_|     ",
];

// Soft error ("no match", mishear) — confused, not dead. Orange, not red.
const SOFT_ERROR_FRAMES: string[] = [
  "  ___   ? \n [o.o]    \n  |_|    ?",
  "  ___    ?\n [O.o]  ? \n  |_|     ",
  "  ___   ? \n [o.O]   ?\n  |_|  ?  ",
];

/** Classify voice error strings so "no match" messages don't surface as the
 *  full red-death state that's reserved for real runtime/permission errors. */
function isSoftError(msg: string | null | undefined): boolean {
  if (!msg) return false;
  return msg.startsWith("Heard ")
    || msg.startsWith("No match")
    || msg.toLowerCase().includes("no matching");
}

function pickFrameSet(state: string, enabled: boolean, err: string | null | undefined):
  { frames: string[]; interval: number } {
  if (err && !isSoftError(err)) return { frames: HARD_ERROR_FRAMES, interval: 400 };
  if (err && isSoftError(err)) return { frames: SOFT_ERROR_FRAMES, interval: 320 };
  if (!enabled) return FRAMES.off!;
  return FRAMES[state] ?? FRAMES.idle!;
}

export default function VoiceMascot() {
  const enabled = useVoiceStore((s) => s.enabled);
  const state = useVoiceStore((s) => s.state);
  const error = useVoiceStore((s) => s.error);

  const { frames, interval } = pickFrameSet(state, enabled, error);
  const [tick, setTick] = useState(0);

  // Voice is opt-in — no mascot clutter for users who haven't enabled it.
  // Hiding here instead of returning null below the hooks so state changes
  // after re-enable still hydrate cleanly.
  const hidden = !enabled && !error;

  // Reset tick on state change so the new animation starts from frame 0
  // instead of an arbitrary index that was valid for the old frame set.
  useEffect(() => {
    setTick(0);
  }, [state, enabled, error]);

  useEffect(() => {
    if (frames.length <= 1) return;
    const id = setInterval(() => setTick((t) => t + 1), interval);
    return () => clearInterval(id);
  }, [frames, interval]);

  if (hidden) return null;

  const frame = frames[tick % frames.length];
  const mood = error
    ? (isSoftError(error) ? "confused" : "error")
    : !enabled ? "off" : state;

  return (
    <pre className={`cc-mascot cc-mascot--${mood}`} aria-hidden="true">
      <span className="cc-mascot-inner">{frame}</span>
    </pre>
  );
}
