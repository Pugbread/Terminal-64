import React, { useState, useEffect, useMemo } from "react";
import type { ChatMessage as ChatMessageType, ToolCall } from "../../lib/types";
import { readFileBase64 } from "../../lib/tauriApi";

const DELEGATION_BLOCK_RE = /\[DELEGATION_START\][\s\S]*?\[DELEGATION_END\]/;
const MERGE_PREFIX = "All delegated tasks have finished. Here are the results:";
const SLASH_CMD_RE = /^\/([a-zA-Z0-9_-]+)\s*([\s\S]*)$/;

// Mood tag: «t64:normal|problem|success|thinking» — strip ALL occurrences,
// use the last one found as the bubble color.
const MOOD_TAG_G = /\s*«t64:(normal|problem|success|thinking)»\s*/g;
export type MoodTag = "normal" | "problem" | "success" | "thinking";

export function parseMood(text: string): { clean: string; mood: MoodTag } {
  let mood: MoodTag = "normal";
  let m;
  while ((m = MOOD_TAG_G.exec(text)) !== null) mood = m[1] as MoodTag;
  MOOD_TAG_G.lastIndex = 0; // reset stateful regex
  const clean = text.replace(MOOD_TAG_G, "").trim();
  return { clean, mood };
}

const IMAGE_EXTS = /\.(png|jpg|jpeg|gif|webp|bmp|svg)$/i;
const ATTACHED_FILE_RE = /\[Attached file: (.+?)\]/g;
const EXT_TO_MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  gif: "image/gif", webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml",
};

// Module-level cache so Virtuoso unmounting + remounting a message doesn't
// re-fetch the same image's base64 blob (and flash the filename placeholder
// on every re-enter). Lives for the lifetime of the chat panel.
const INLINE_IMAGE_CACHE = new Map<string, string>();

function InlineImage({ filePath }: { filePath: string }) {
  const [src, setSrc] = useState<string | null>(() => INLINE_IMAGE_CACHE.get(filePath) ?? null);
  useEffect(() => {
    const cached = INLINE_IMAGE_CACHE.get(filePath);
    if (cached) {
      setSrc(cached);
      return;
    }
    let cancelled = false;
    const ext = filePath.split(".").pop()?.toLowerCase() || "png";
    const mime = EXT_TO_MIME[ext] || "image/png";
    readFileBase64(filePath).then((b64) => {
      if (cancelled) return;
      const dataUrl = `data:${mime};base64,${b64}`;
      INLINE_IMAGE_CACHE.set(filePath, dataUrl);
      setSrc(dataUrl);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [filePath]);
  if (!src) return <span className="cc-inline-file">{filePath.split(/[/\\]/).pop()}</span>;
  return <img src={src} alt="attached" className="cc-inline-image" />;
}

function renderUserContent(content: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match;
  const re = new RegExp(ATTACHED_FILE_RE.source, "g");
  while ((match = re.exec(content)) !== null) {
    if (match.index > lastIndex) {
      parts.push(content.slice(lastIndex, match.index));
    }
    const filePath = match[1];
    if (filePath && IMAGE_EXTS.test(filePath)) {
      parts.push(<InlineImage key={match.index} filePath={filePath} />);
    } else if (filePath) {
      parts.push(<span key={match.index} className="cc-inline-file">{filePath.split(/[/\\]/).pop()}</span>);
    }
    lastIndex = re.lastIndex;
  }
  if (lastIndex < content.length) {
    parts.push(content.slice(lastIndex));
  }
  return parts.length > 0 ? <>{parts}</> : content;
}

function renderInline(text: string, keyPrefix: string = ""): React.ReactNode[] {
  // Order matters: bold+italic before bold/italic to prevent partial matching
  const pattern = /(\*\*\*(.+?)\*\*\*|\*\*(.+?)\*\*|\*(.+?)\*|__(.+?)__|~~(.+?)~~|`([^`]+)`|\[([^\]]+)\]\(((?:[^()]+|\([^()]*\))+)\))/g;
  const result: React.ReactNode[] = [];
  let lastIndex = 0;
  let match;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      result.push(text.slice(lastIndex, match.index));
    }
    const key = `${keyPrefix}${match.index}`;
    if (match[2]) {
      // ***bold italic***
      result.push(<strong key={key}><em>{match[2]}</em></strong>);
    } else if (match[3]) {
      // **bold**
      result.push(<strong key={key}>{match[3]}</strong>);
    } else if (match[4]) {
      // *italic*
      result.push(<em key={key}>{match[4]}</em>);
    } else if (match[5]) {
      // __underline/bold__
      result.push(<strong key={key}>{match[5]}</strong>);
    } else if (match[6]) {
      // ~~strikethrough~~
      result.push(<del key={key}>{match[6]}</del>);
    } else if (match[7]) {
      // `inline code`
      result.push(<code key={key} className="cc-inline-code">{match[7]}</code>);
    } else if (match[8] && match[9]) {
      // [text](url) — only allow safe protocols
      const href = match[9].trim();
      const hrefLower = href.toLowerCase().replace(/\s/g, '');
      if (/^https?:|^mailto:/i.test(hrefLower)) {
        result.push(<a key={key} className="cc-link" href={href} title={href}>{match[8]}</a>);
      } else {
        result.push(<span key={key}>{match[8]}</span>);
      }
    }
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex < text.length) {
    result.push(text.slice(lastIndex));
  }
  return result;
}

function SkillCommandBadge({ name, args }: { name: string; args: string }) {
  return (
    <div className="cc-skill-badge">
      <span className="cc-skill-badge-icon">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
        </svg>
      </span>
      <span className="cc-skill-badge-name">/{name}</span>
      {args && <span className="cc-skill-badge-args">{args}</span>}
    </div>
  );
}

function DelegationPlanBadge({ block }: { block: string }) {
  const [expanded, setExpanded] = useState(false);
  const tasks = block.match(/\[TASK\]\s*(.+)/g)?.map((t) => t.replace(/\[TASK\]\s*/, "")) || [];
  const context = block.match(/\[CONTEXT\]\s*(.+)/)?.[1] || "";
  return (
    <div className="cc-delegation-badge">
      <button className="cc-delegation-badge-header" onClick={() => setExpanded((v) => !v)}>
        <span className="cc-delegation-badge-icon">◈</span>
        <span className="cc-delegation-badge-text">Delegation plan — {tasks.length} agents</span>
        <span className="cc-tc-expand">{expanded ? "▾" : "▸"}</span>
      </button>
      {expanded && (
        <div className="cc-delegation-badge-body">
          {context && <p className="cc-delegation-badge-ctx">{context}</p>}
          <ol className="cc-delegation-badge-tasks">
            {tasks.map((t, i) => <li key={i}>{t}</li>)}
          </ol>
        </div>
      )}
    </div>
  );
}

function MergeResultCard({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);
  const tasks: { name: string; status: string; result: string }[] = [];
  let m;
  const re = /## (.+?) \[(Completed|Failed|Cancelled)\]\n([\s\S]*?)(?=\n---|\n\nPlease review|$)/g;
  while ((m = re.exec(content)) !== null) {
    tasks.push({ name: m[1] ?? "", status: m[2] ?? "", result: (m[3] ?? "").trim() });
  }
  const completed = tasks.filter((t) => t.status === "Completed").length;
  return (
    <div className="cc-merge-card">
      <button className="cc-merge-card-header" onClick={() => setExpanded((v) => !v)}>
        <span className="cc-delegation-badge-icon">◈</span>
        <span className="cc-delegation-badge-text">Delegation results — {completed}/{tasks.length} completed</span>
        <span className="cc-tc-expand">{expanded ? "▾" : "▸"}</span>
      </button>
      {expanded && (
        <div className="cc-merge-card-body">
          {tasks.map((t, i) => (
            <div key={i} className={`cc-merge-task cc-merge-task--${t.status.toLowerCase()}`}>
              <div className="cc-merge-task-header">
                <span className={`cc-merge-task-dot cc-merge-task-dot--${t.status.toLowerCase()}`} />
                <span className="cc-merge-task-name">{t.name}</span>
              </div>
              <pre className="cc-merge-task-result">{t.result}</pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CopyBtn({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="cc-copy-btn"
      onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
      title="Copy"
    >
      {copied ? "✓" : "⎘"}
    </button>
  );
}

export function renderContent(text: string) {
  if (!text) return null;

  // Split on fenced code blocks first (closed or unclosed at end of stream)
  const segments = text.split(/(```[\s\S]*?```|```[\s\S]*$)/g);
  const elements: React.ReactNode[] = [];
  let key = 0;

  for (const segment of segments) {
    if (segment.startsWith("```")) {
      const closed = segment.endsWith("```") && segment.length > 3;
      const inner = closed ? segment.slice(3, -3) : segment.slice(3);
      const nl = inner.indexOf("\n");
      const code = nl >= 0 ? inner.slice(nl + 1) : inner;
      const lang = nl >= 0 ? inner.slice(0, nl).trim() : "";
      elements.push(
        <pre key={key++} className="cc-code-block">
          <CopyBtn text={code} />
          {lang && <span className="cc-code-lang">{lang}</span>}
          <code>{code}</code>
        </pre>
      );
      continue;
    }

    // Process line-by-line for block elements
    const lines = segment.split("\n");
    let i = 0;
    while (i < lines.length) {
      const line = lines[i]!;
      const trimmed = line.trimStart();

      // Empty line
      if (!trimmed) { i++; continue; }

      // Headings
      const headingMatch = trimmed.match(/^(#{1,4})\s+(.+)$/);
      if (headingMatch) {
        const level = headingMatch[1]!.length;
        const Tag = `h${level}` as keyof React.JSX.IntrinsicElements;
        elements.push(<Tag key={key++} className={`cc-h cc-h${level}`}>{renderInline(headingMatch[2]!)}</Tag>);
        i++; continue;
      }

      // Horizontal rule
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
        elements.push(<hr key={key++} className="cc-hr" />);
        i++; continue;
      }

      // Blockquote (collect consecutive > lines)
      if (trimmed.startsWith("> ") || trimmed === ">") {
        const quoteLines: string[] = [];
        while (i < lines.length && (lines[i]!.trimStart().startsWith("> ") || lines[i]!.trimStart() === ">")) {
          quoteLines.push(lines[i]!.trimStart().replace(/^>\s?/, ""));
          i++;
        }
        elements.push(
          <blockquote key={key++} className="cc-blockquote">
            {renderInline(quoteLines.join("\n"))}
          </blockquote>
        );
        continue;
      }

      // Unordered list (- or * or +)
      if (/^[-*+]\s/.test(trimmed)) {
        const items: string[] = [];
        while (i < lines.length && /^[-*+]\s/.test(lines[i]!.trimStart())) {
          items.push(lines[i]!.trimStart().replace(/^[-*+]\s/, ""));
          i++;
        }
        elements.push(
          <ul key={key++} className="cc-list">
            {items.map((item, j) => <li key={j}>{renderInline(item)}</li>)}
          </ul>
        );
        continue;
      }

      // Ordered list
      if (/^\d+[.)]\s/.test(trimmed)) {
        const items: string[] = [];
        const startMatch = trimmed.match(/^(\d+)[.)]\s/);
        const startNum = startMatch ? parseInt(startMatch[1]!, 10) : 1;
        while (i < lines.length && /^\d+[.)]\s/.test(lines[i]!.trimStart())) {
          items.push(lines[i]!.trimStart().replace(/^\d+[.)]\s/, ""));
          i++;
        }
        elements.push(
          <ol key={key++} className="cc-list" start={startNum}>
            {items.map((item, j) => <li key={j}>{renderInline(item)}</li>)}
          </ol>
        );
        continue;
      }

      // Tables — lines starting with |
      if (trimmed.startsWith("|") && trimmed.includes("|", 1)) {
        const tableLines: string[] = [];
        while (i < lines.length && lines[i]!.trim().startsWith("|")) {
          tableLines.push(lines[i]!.trim());
          i++;
        }
        if (tableLines.length >= 2) {
          const parseRow = (row: string) =>
            row.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

          const headers = parseRow(tableLines[0]!);
          // Check if second line is a separator (|---|---|)
          const hasSep = /^\|[\s:]*-+[\s:]*(\|[\s:]*-+[\s:]*)*\|?$/.test(tableLines[1]!);
          const bodyStart = hasSep ? 2 : 1;

          const aligns: ("left" | "center" | "right" | undefined)[] = [];
          if (hasSep) {
            parseRow(tableLines[1]!).forEach((cell) => {
              const l = cell.startsWith(":");
              const r = cell.endsWith(":");
              if (l && r) aligns.push("center");
              else if (r) aligns.push("right");
              else if (l) aligns.push("left");
              else aligns.push(undefined);
            });
          }

          elements.push(
            <div key={key++} className="cc-table-wrap">
              <table className="cc-table">
                <thead>
                  <tr>
                    {headers.map((h, j) => (
                      <th key={j} style={aligns[j] ? { textAlign: aligns[j] } : undefined}>
                        {renderInline(h)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {tableLines.slice(bodyStart).map((row, ri) => (
                    <tr key={ri}>
                      {parseRow(row).map((cell, ci) => (
                        <td key={ci} style={aligns[ci] ? { textAlign: aligns[ci] } : undefined}>
                          {renderInline(cell)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
          continue;
        }
      }

      // Regular paragraph — collect consecutive non-empty, non-special lines
      const paraLines: string[] = [];
      while (i < lines.length && lines[i]!.trim() && !/^(#{1,4}\s|[-*+]\s|\d+[.)]\s|>\s?|\|.|(-{3,}|\*{3,}|_{3,})$)/.test(lines[i]!.trimStart())) {
        paraLines.push(lines[i]!);
        i++;
      }
      if (paraLines.length) {
        elements.push(<p key={key++} className="cc-p">{renderInline(paraLines.join("\n"))}</p>);
      }
    }
  }

  return elements;
}

export function toolHeader(tc: ToolCall): { icon: string; title: string; detail: string } {
  const i = tc.input;
  switch (tc.name) {
    case "Bash":
      return { icon: "$", title: "Bash", detail: String(i.command || "").slice(0, 80) };
    case "Read":
      return { icon: "◉", title: "Read", detail: shortPath(i.file_path) };
    case "Edit":
      return { icon: "✎", title: "Edit", detail: shortPath(i.file_path) };
    case "Write":
      return { icon: "+", title: "Write", detail: shortPath(i.file_path) };
    case "MultiEdit":
      return { icon: "✎", title: "MultiEdit", detail: shortPath(i.file_path) };
    case "Glob":
      return { icon: "⊛", title: "Glob", detail: String(i.pattern || "") };
    case "Grep":
      return { icon: "⊛", title: "Grep", detail: `/${String(i.pattern || "")}/` };
    case "WebSearch":
      return { icon: "⌕", title: "Search", detail: String(i.query || "").slice(0, 60) };
    case "WebFetch":
      return { icon: "↓", title: "Fetch", detail: String(i.url || "").slice(0, 60) };
    case "Agent":
      return { icon: "◈", title: "Agent", detail: String(i.description || i.prompt || "").slice(0, 60) };
    case "Skill":
      return { icon: "/", title: String(i.skill || "Skill"), detail: String(i.args || "") };
    case "NotebookEdit":
      return { icon: "✎", title: "Notebook", detail: shortPath(i.file_path) };
    case "AskUserQuestion":
      return { icon: "?", title: "Question", detail: "" };
    default:
      return { icon: "⚙", title: tc.name, detail: summarizeFallback(i) };
  }
}

function shortPath(fp: unknown): string {
  if (!fp) return "";
  return String(fp).split(/[/\\]/).slice(-2).join("/");
}

function summarizeFallback(input: Record<string, unknown>): string {
  const first = Object.values(input)[0];
  return typeof first === "string" ? first.slice(0, 50) : "";
}

function ToolBody({ tc, onEditClick }: { tc: ToolCall; onEditClick?: (tcId: string, filePath: string, oldStr: string, newStr: string) => void }) {
  const i = tc.input;
  const result = tc.result;

  // Edit — show old_string → new_string as diff
  if (tc.name === "Edit" && i.old_string !== undefined) {
    return (
      <div className="cc-tc-body">
        <div className="cc-tc-diff" onClick={() => onEditClick?.(tc.id, String(i.file_path || ""), String(i.old_string), String(i.new_string))} style={{ cursor: onEditClick ? "pointer" : undefined }}>
          <div className="cc-tc-diff-add">{String(i.new_string)}</div>
          <div className="cc-tc-diff-del">{String(i.old_string)}</div>
        </div>
        {result && <pre className="cc-tc-output">{result}</pre>}
      </div>
    );
  }

  // Write — show content preview
  if (tc.name === "Write" && i.content) {
    const content = String(i.content);
    const preview = content.length > 500 ? content.slice(0, 500) + "\n..." : content;
    return (
      <div className="cc-tc-body">
        <pre className="cc-tc-output"><CopyBtn text={content} />{preview}</pre>
        {result && <pre className="cc-tc-result-text">{result}</pre>}
      </div>
    );
  }

  // Bash — show command and output
  if (tc.name === "Bash") {
    const cmd = i.command ? String(i.command) : "";
    return (
      <div className="cc-tc-body">
        {cmd && <pre className="cc-tc-command"><CopyBtn text={cmd} />$ {cmd}</pre>}
        {result && <pre className="cc-tc-output"><CopyBtn text={result} />{result}</pre>}
      </div>
    );
  }

  // Skill tool — show skill name and loaded content
  if (tc.name === "Skill") {
    const skillName = i.skill ? String(i.skill) : "unknown";
    const skillArgs = i.args ? String(i.args) : "";
    return (
      <div className="cc-tc-body">
        <div className="cc-skill-loaded">
          <span className="cc-skill-loaded-label">Loaded skill</span>
          <code className="cc-skill-loaded-name">/{skillName}</code>
          {skillArgs && <span className="cc-skill-loaded-args">{skillArgs}</span>}
        </div>
        {result && <pre className="cc-tc-output cc-skill-output">{result}</pre>}
      </div>
    );
  }

  // Default — show input JSON and result
  return (
    <div className="cc-tc-body">
      <pre className="cc-tc-output">{JSON.stringify(i, null, 2)}</pre>
      {result && <pre className="cc-tc-output">{result}</pre>}
    </div>
  );
}

const EXPAND_BY_DEFAULT = new Set(["Write", "Edit", "MultiEdit"]);

function ToolCallCard({ tc, onEditClick }: { tc: ToolCall; onEditClick?: (tcId: string, filePath: string, oldStr: string, newStr: string) => void }) {
  const [expanded, setExpanded] = useState(EXPAND_BY_DEFAULT.has(tc.name));
  const hasResult = tc.result !== undefined;
  const hdr = toolHeader(tc);

  return (
    <div className={`cc-tc ${tc.isError ? "cc-tc--error" : ""}`}>
      <button className="cc-tc-header" onClick={() => setExpanded((v) => !v)}>
        <span className={`cc-tc-status ${hasResult ? (tc.isError ? "cc-tc-status--err" : "cc-tc-status--ok") : "cc-tc-status--pending"}`}>
          {hasResult ? (tc.isError ? "✕" : "✓") : "⋯"}
        </span>
        <span className="cc-tc-icon">{String(hdr.icon)}</span>
        <span className="cc-tc-name">{hdr.title}</span>
        <span className="cc-tc-detail">{hdr.detail}</span>
        <span className="cc-tc-expand">{expanded ? "▾" : "▸"}</span>
      </button>
      {expanded && <ToolBody tc={tc} {...(onEditClick && { onEditClick })} />}
    </div>
  );
}

const GROUPABLE_TOOLS = new Set(["Read", "Grep", "Glob", "WebSearch", "WebFetch"]);

function groupLabel(tcs: ToolCall[]): { icon: string; name: string; details: string } {
  const first = tcs[0]?.name;
  if (tcs.every((tc) => tc.name === first)) {
    switch (first) {
      case "Read":
        return { icon: "◉", name: `Read ${tcs.length} files`, details: tcs.map((tc) => shortPath(tc.input.file_path)).join(", ") };
      case "Grep":
        return { icon: "⊛", name: `${tcs.length} searches`, details: tcs.map((tc) => `/${tc.input.pattern || ""}/`).join(", ") };
      case "Glob":
        return { icon: "⊛", name: `${tcs.length} globs`, details: tcs.map((tc) => String(tc.input.pattern || "")).join(", ") };
      case "WebSearch":
        return { icon: "⌕", name: `${tcs.length} web searches`, details: tcs.map((tc) => String(tc.input.query || "")).join(", ") };
      case "WebFetch":
        return { icon: "↓", name: `Fetch ${tcs.length} URLs`, details: tcs.map((tc) => String(tc.input.url || "").slice(0, 40)).join(", ") };
    }
  }
  return { icon: "⊛", name: `${tcs.length} lookups`, details: "" };
}

export function ToolGroupCard({ tcs }: { tcs: ToolCall[] }) {
  const [expanded, setExpanded] = useState(false);
  const allDone = tcs.every((tc) => tc.result !== undefined);
  const anyError = tcs.some((tc) => tc.isError);
  const lbl = groupLabel(tcs);

  return (
    <div className={`cc-tc ${anyError ? "cc-tc--error" : ""}`}>
      <button className="cc-tc-header" onClick={() => setExpanded((v) => !v)}>
        <span className={`cc-tc-status ${allDone ? (anyError ? "cc-tc-status--err" : "cc-tc-status--ok") : "cc-tc-status--pending"}`}>
          {allDone ? (anyError ? "✕" : "✓") : "⋯"}
        </span>
        <span className="cc-tc-icon">{lbl.icon}</span>
        <span className="cc-tc-name">{lbl.name}</span>
        <span className="cc-tc-detail">{lbl.details}</span>
        <span className="cc-tc-expand">{expanded ? "▾" : "▸"}</span>
      </button>
      {expanded && (
        <div className="cc-tc-body">
          {tcs.map((tc) => {
            const hdr = toolHeader(tc);
            return (
              <div key={tc.id} className="cc-tc-group-item">
                <div className="cc-tc-group-file">{hdr.detail}</div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export { GROUPABLE_TOOLS };

function buildCopyText(message: ChatMessageType): string {
  if (message.role === "user") {
    return message.content || "";
  }
  // Assistant: text content + tool call summaries (strip mood tag)
  const textPart = parseMood(message.content?.replace(DELEGATION_BLOCK_RE, "").trim() || "").clean;
  const parts: string[] = [];
  if (textPart) parts.push(textPart);
  if (message.toolCalls && message.toolCalls.length > 0) {
    const toolLines = message.toolCalls.map((tc) => {
      const hdr = toolHeader(tc);
      return `[${hdr.title}] ${hdr.detail}`.trim();
    });
    parts.push(toolLines.join("\n"));
  }
  return parts.join("\n\n");
}

function ChatMessageInner({ message, onRewind, onFork, onEditClick }: {
  message: ChatMessageType;
  onRewind?: (messageId: string, content: string) => void;
  onFork?: (messageId: string) => void;
  onEditClick?: (tcId: string, filePath: string, oldStr: string, newStr: string) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    const text = buildCopyText(message);
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
    setMenuOpen(false);
  };

  const menuEl = menuOpen && (
    <div className="cc-ctx-menu" onMouseLeave={() => setMenuOpen(false)}>
      <button className="cc-ctx-item" onClick={() => { setMenuOpen(false); onRewind?.(message.id, message.role === "user" ? message.content : ""); }}>
        <span className="cc-ctx-icon">↩</span> Rewind
      </button>
      <button className="cc-ctx-item" onClick={() => { setMenuOpen(false); onFork?.(message.id); }}>
        <span className="cc-ctx-icon">⑂</span> Fork
      </button>
      <button className="cc-ctx-item" onClick={handleCopy}>
        <span className="cc-ctx-icon">{copied ? "✓" : "⎘"}</span> {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );

  const menuBtn = (
    <div className="cc-msg-actions">
      <button className="cc-msg-menu-btn" onClick={() => setMenuOpen((v) => !v)} title="Message options">⋯</button>
      {menuEl}
    </div>
  );

  if (message.role === "user") {
    const content = message.content || "";
    const isMerge = content.startsWith(MERGE_PREFIX);
    const slashMatch = content.match(SLASH_CMD_RE);
    const isSlashCmd = slashMatch && !isMerge;
    return (
      <div className="cc-message cc-message--user" data-msg-id={message.id}>
        {menuBtn}
        {isMerge ? (
          <MergeResultCard content={content} />
        ) : isSlashCmd ? (
          <SkillCommandBadge name={slashMatch[1]!} args={(slashMatch[2] ?? "").trim()} />
        ) : content ? (
          <div className="cc-bubble cc-bubble--user">
            {renderUserContent(content)}
          </div>
        ) : null}
      </div>
    );
  }

  // Strip [DELEGATION_START]...[DELEGATION_END] blocks from assistant text,
  // then extract mood tag for bubble coloring
  const { delegationBlock, cleanContent, mood } = useMemo(() => {
    if (!message.content) return { delegationBlock: undefined, cleanContent: "", mood: "normal" as MoodTag };
    const delegation = message.content.match(DELEGATION_BLOCK_RE)?.[0];
    const stripped = message.content.replace(DELEGATION_BLOCK_RE, "").trim();
    const { clean, mood } = parseMood(stripped);
    return { delegationBlock: delegation, cleanContent: clean, mood };
  }, [message.content]);

  const renderedContent = useMemo(() => cleanContent ? renderContent(cleanContent) : null, [cleanContent]);

  return (
    <div className="cc-message cc-message--assistant" data-msg-id={message.id}>
      {menuBtn}
      {renderedContent && (
        <div className={`cc-bubble cc-bubble--assistant${mood !== "normal" ? ` cc-bubble--${mood}` : ""}`}>
          {renderedContent}
        </div>
      )}
      {delegationBlock && <DelegationPlanBadge block={delegationBlock} />}
      {message.toolCalls && message.toolCalls.length > 0 && (
        <div className="cc-tc-list">
          {message.toolCalls.map((tc) => (
            <ToolCallCard key={tc.id} tc={tc} {...(onEditClick && { onEditClick })} />
          ))}
        </div>
      )}
    </div>
  );
}

const ChatMessage = React.memo(ChatMessageInner);
export default ChatMessage;
