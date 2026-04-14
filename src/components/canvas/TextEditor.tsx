import { useState, useRef, useEffect, useCallback } from "react";
import { rewritePromptStream } from "../../lib/ai";
import "./TextEditor.css";

interface TextEditorProps {
  onSend: (text: string) => void;
  onClose: () => void;
}

export default function TextEditor({ onSend, onClose }: TextEditorProps) {
  const [text, setText] = useState("");
  const [rewriting, setRewriting] = useState(false);
  const [error, setError] = useState("");

  // Version history
  const [history, setHistory] = useState<string[]>([""]);
  const [historyIdx, setHistoryIdx] = useState(0);

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // Protect textarea from garbage character injection on arrow keys
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    const arrowKeys = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"]);
    const captureArrows = (e: KeyboardEvent) => {
      if (arrowKeys.has(e.key)) e.stopPropagation();
    };
    const blockGarbage = (e: InputEvent) => {
      if (e.data && /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(e.data)) e.preventDefault();
    };
    el.addEventListener("keydown", captureArrows, true);
    el.addEventListener("beforeinput", blockGarbage as EventListener, true);
    return () => {
      el.removeEventListener("keydown", captureArrows, true);
      el.removeEventListener("beforeinput", blockGarbage as EventListener, true);
    };
  }, []);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "0";
    ta.style.height = Math.max(36, ta.scrollHeight) + "px";
  }, [text]);

  // Save a snapshot to history (uses functional updaters to avoid stale closures)
  const pushVersion = useCallback(
    (newText: string) => {
      setHistoryIdx((idx) => {
        setHistory((h) => [...h.slice(0, idx + 1), newText]);
        return idx + 1;
      });
    },
    []
  );

  const canUndo = historyIdx > 0;
  const canRedo = historyIdx < history.length - 1;

  const handleUndo = useCallback(() => {
    if (!canUndo) return;
    const newIdx = historyIdx - 1;
    setHistoryIdx(newIdx);
    setText(history[newIdx]);
  }, [canUndo, historyIdx, history]);

  const handleRedo = useCallback(() => {
    if (!canRedo) return;
    const newIdx = historyIdx + 1;
    setHistoryIdx(newIdx);
    setText(history[newIdx]);
  }, [canRedo, historyIdx, history]);

  const handleSend = useCallback(() => {
    if (text.trim()) {
      onSend(text);
    }
    onClose();
  }, [text, onSend, onClose]);

  const handleRewrite = useCallback(async () => {
    if (!text.trim() || rewriting) return;
    setError("");
    setRewriting(true);
    const original = text;
    // Save current text as a version before rewriting
    pushVersion(original);
    setText("");
    let result = "";
    try {
      await rewritePromptStream(original, (chunk) => {
        result += chunk;
        setText(result);
      });
      // Save the rewritten result as the latest version
      setHistoryIdx((idx) => {
        setHistory((h) => [...h.slice(0, idx + 1), result]);
        return idx + 1;
      });
    } catch (err: any) {
      setError(err.message || "Rewrite failed");
      setText(original);
    } finally {
      setRewriting(false);
      textareaRef.current?.focus();
    }
  }, [text, rewriting, pushVersion]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        handleSend();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === "R") {
        e.preventDefault();
        handleRewrite();
        return;
      }
      // Ctrl+Z → undo to previous version
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === "z") {
        if (canUndo) {
          e.preventDefault();
          handleUndo();
          return;
        }
      }
      // Ctrl+Shift+Z or Ctrl+Y → redo
      if (
        ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === "Z") ||
        ((e.ctrlKey || e.metaKey) && e.key === "y")
      ) {
        if (canRedo) {
          e.preventDefault();
          handleRedo();
          return;
        }
      }
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        const ta = textareaRef.current;
        if (!ta) return;
        const start = ta.selectionStart;
        const end = ta.selectionEnd;
        const newText = text.substring(0, start) + "  " + text.substring(end);
        setText(newText);
        requestAnimationFrame(() => {
          ta.selectionStart = ta.selectionEnd = start + 2;
        });
      }
    },
    [handleSend, handleRewrite, handleUndo, handleRedo, canUndo, canRedo, onClose, text]
  );

  const lineCount = text.split("\n").length;
  const versionLabel =
    history.length > 1 ? `v${historyIdx + 1}/${history.length}` : "";

  return (
    <div className="text-editor">
      <div className="text-editor-header">
        <span className="text-editor-hint">
          Ctrl+Enter send · Ctrl+Shift+R rewrite · Esc cancel
        </span>

        {/* Version navigation */}
        {history.length > 1 && (
          <div className="text-editor-versions">
            <button
              className="text-editor-btn text-editor-btn--sm"
              onClick={handleUndo}
              disabled={!canUndo || rewriting}
              title="Previous version (Ctrl+Z)"
            >
              ←
            </button>
            <span className="text-editor-version-label">{versionLabel}</span>
            <button
              className="text-editor-btn text-editor-btn--sm"
              onClick={handleRedo}
              disabled={!canRedo || rewriting}
              title="Next version (Ctrl+Shift+Z)"
            >
              →
            </button>
          </div>
        )}

        <span className="text-editor-lines">{lineCount}L</span>
        <button
          className="text-editor-btn text-editor-btn--rewrite"
          onClick={handleRewrite}
          disabled={rewriting || !text.trim()}
          title="AI Rewrite (Ctrl+Shift+R)"
        >
          {rewriting ? "..." : "✨ Rewrite"}
        </button>
        <button className="text-editor-btn text-editor-btn--send" onClick={handleSend}>
          Send
        </button>
        <button className="text-editor-btn" onClick={onClose}>
          <svg width="9" height="9" viewBox="0 0 9 9">
            <path d="M1 1L8 8M8 1L1 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      {error && <div className="text-editor-error">{error}</div>}
      <textarea
        ref={textareaRef}
        className="text-editor-area"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setError("");
        }}
        onKeyDown={handleKeyDown}
        placeholder="Type or paste text here..."
        spellCheck={false}
      />
    </div>
  );
}
