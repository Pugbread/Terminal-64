import React, { useState } from "react";
import { ChatMessage as ChatMessageType, ToolCall } from "../../lib/types";

const DELEGATION_BLOCK_RE = /\[DELEGATION_START\][\s\S]*?\[DELEGATION_END\]/;
const MERGE_PREFIX = "All delegated tasks have finished. Here are the results:";

// Render inline markdown: bold, italic, bold+italic, inline code, links, strikethrough
function renderInline(text: string, keyPrefix: string = ""): React.ReactNode[] {
  // Order matters: bold+italic first, then bold, italic, inline code, links, strikethrough
  const pattern = /(\*\*\*(.+?)\*\*\*|\*\*(.+?)\*\*|\*(.+?)\*|__(.+?)__|~~(.+?)~~|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\))/g;
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
    tasks.push({ name: m[1], status: m[2], result: m[3].trim() });
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

// Render a full markdown block: headings, code blocks, lists, blockquotes, hrs, paragraphs
export function renderContent(text: string) {
  if (!text) return null;

  // Split on fenced code blocks first (preserve them intact)
  const segments = text.split(/(```[\s\S]*?```)/g);
  const elements: React.ReactNode[] = [];
  let key = 0;

  for (const segment of segments) {
    if (segment.startsWith("```") && segment.endsWith("```")) {
      const inner = segment.slice(3, -3);
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
      const line = lines[i];
      const trimmed = line.trimStart();

      // Empty line
      if (!trimmed) { i++; continue; }

      // Headings
      const headingMatch = trimmed.match(/^(#{1,4})\s+(.+)$/);
      if (headingMatch) {
        const level = headingMatch[1].length;
        const Tag = `h${level}` as keyof JSX.IntrinsicElements;
        elements.push(<Tag key={key++} className={`cc-h cc-h${level}`}>{renderInline(headingMatch[2])}</Tag>);
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
        while (i < lines.length && (lines[i].trimStart().startsWith("> ") || lines[i].trimStart() === ">")) {
          quoteLines.push(lines[i].trimStart().replace(/^>\s?/, ""));
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
        while (i < lines.length && /^[-*+]\s/.test(lines[i].trimStart())) {
          items.push(lines[i].trimStart().replace(/^[-*+]\s/, ""));
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
        while (i < lines.length && /^\d+[.)]\s/.test(lines[i].trimStart())) {
          items.push(lines[i].trimStart().replace(/^\d+[.)]\s/, ""));
          i++;
        }
        elements.push(
          <ol key={key++} className="cc-list">
            {items.map((item, j) => <li key={j}>{renderInline(item)}</li>)}
          </ol>
        );
        continue;
      }

      // Tables — lines starting with |
      if (trimmed.startsWith("|") && trimmed.includes("|", 1)) {
        const tableLines: string[] = [];
        while (i < lines.length && lines[i].trim().startsWith("|")) {
          tableLines.push(lines[i].trim());
          i++;
        }
        if (tableLines.length >= 2) {
          const parseRow = (row: string) =>
            row.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

          const headers = parseRow(tableLines[0]);
          // Check if second line is a separator (|---|---|)
          const hasSep = /^\|[\s:]*-+[\s:]*(\|[\s:]*-+[\s:]*)*\|?$/.test(tableLines[1]);
          const bodyStart = hasSep ? 2 : 1;

          // Parse alignment from separator
          const aligns: ("left" | "center" | "right" | undefined)[] = [];
          if (hasSep) {
            parseRow(tableLines[1]).forEach((cell) => {
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
      while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|[-*+]\s|\d+[.)]\s|>\s?|\|.|(-{3,}|\*{3,}|_{3,})$)/.test(lines[i].trimStart())) {
        paraLines.push(lines[i]);
        i++;
      }
      if (paraLines.length) {
        elements.push(<p key={key++} className="cc-p">{renderInline(paraLines.join("\n"))}</p>);
      }
    }
  }

  return elements;
}

// Tool-specific header content
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

// Render the expanded body based on tool type
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
      {expanded && <ToolBody tc={tc} onEditClick={onEditClick} />}
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

function ChatMessageInner({ message, onRewind, onFork, onEditClick }: {
  message: ChatMessageType;
  onRewind?: (messageId: string, content: string) => void;
  onFork?: (messageId: string) => void;
  onEditClick?: (tcId: string, filePath: string, oldStr: string, newStr: string) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);

  const menuEl = menuOpen && (
    <div className="cc-ctx-menu" onMouseLeave={() => setMenuOpen(false)}>
      <button className="cc-ctx-item" onClick={() => { setMenuOpen(false); onRewind?.(message.id, message.role === "user" ? message.content : ""); }}>
        <span className="cc-ctx-icon">↩</span> Rewind
      </button>
      <button className="cc-ctx-item" onClick={() => { setMenuOpen(false); onFork?.(message.id); }}>
        <span className="cc-ctx-icon">⑂</span> Fork
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
    return (
      <div className="cc-message cc-message--user">
        {menuBtn}
        {isMerge ? (
          <MergeResultCard content={content} />
        ) : content ? (
          <div className="cc-bubble cc-bubble--user">
            {content}
          </div>
        ) : null}
      </div>
    );
  }

  // Strip [DELEGATION_START]...[DELEGATION_END] blocks from assistant text
  const delegationBlock = message.content?.match(DELEGATION_BLOCK_RE)?.[0];
  const cleanContent = message.content ? message.content.replace(DELEGATION_BLOCK_RE, "").trim() : "";

  return (
    <div className="cc-message cc-message--assistant">
      {menuBtn}
      {cleanContent && (
        <div className="cc-bubble cc-bubble--assistant">
          {renderContent(cleanContent)}
        </div>
      )}
      {delegationBlock && <DelegationPlanBadge block={delegationBlock} />}
      {message.toolCalls && message.toolCalls.length > 0 && (
        <div className="cc-tc-list">
          {message.toolCalls.map((tc) => (
            <ToolCallCard key={tc.id} tc={tc} onEditClick={onEditClick} />
          ))}
        </div>
      )}
    </div>
  );
}

const ChatMessage = React.memo(ChatMessageInner);
export default ChatMessage;
export type { ChatMessageType };
