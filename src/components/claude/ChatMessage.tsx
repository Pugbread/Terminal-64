import React, { useState } from "react";
import { ChatMessage as ChatMessageType, ToolCall } from "../../lib/types";

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
      // [text](url)
      result.push(<a key={key} className="cc-link" href={match[9]} title={match[9]}>{match[8]}</a>);
    }
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex < text.length) {
    result.push(text.slice(lastIndex));
  }
  return result;
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

      // Regular paragraph — collect consecutive non-empty, non-special lines
      const paraLines: string[] = [];
      while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|[-*+]\s|\d+[.)]\s|>\s?|(-{3,}|\*{3,}|_{3,})$)/.test(lines[i].trimStart())) {
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
        <pre className="cc-tc-output">{preview}</pre>
        {result && <pre className="cc-tc-result-text">{result}</pre>}
      </div>
    );
  }

  // Bash — show command and output
  if (tc.name === "Bash") {
    const cmd = i.command ? String(i.command) : "";
    return (
      <div className="cc-tc-body">
        {cmd && <pre className="cc-tc-command">$ {cmd}</pre>}
        {result && <pre className="cc-tc-output">{result}</pre>}
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

export function ReadGroupCard({ tcs }: { tcs: ToolCall[] }) {
  const [expanded, setExpanded] = useState(false);
  const allDone = tcs.every((tc) => tc.result !== undefined);
  const anyError = tcs.some((tc) => tc.isError);

  return (
    <div className={`cc-tc ${anyError ? "cc-tc--error" : ""}`}>
      <button className="cc-tc-header" onClick={() => setExpanded((v) => !v)}>
        <span className={`cc-tc-status ${allDone ? (anyError ? "cc-tc-status--err" : "cc-tc-status--ok") : "cc-tc-status--pending"}`}>
          {allDone ? (anyError ? "✕" : "✓") : "⋯"}
        </span>
        <span className="cc-tc-icon">◉</span>
        <span className="cc-tc-name">Read {tcs.length} files</span>
        <span className="cc-tc-detail">{tcs.map((tc) => shortPath(tc.input.file_path)).join(", ")}</span>
        <span className="cc-tc-expand">{expanded ? "▾" : "▸"}</span>
      </button>
      {expanded && (
        <div className="cc-tc-body">
          {tcs.map((tc) => (
            <div key={tc.id} className="cc-tc-group-item">
              <div className="cc-tc-group-file">{shortPath(tc.input.file_path)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ChatMessageInner({ message, onRewind, onEditClick }: { message: ChatMessageType; onRewind?: (messageId: string, content: string) => void; onEditClick?: (tcId: string, filePath: string, oldStr: string, newStr: string) => void }) {
  if (message.role === "user") {
    return (
      <div className="cc-message cc-message--user">
        <div className="cc-bubble cc-bubble--user">
          {message.content}
          <button
            className="cc-rewind-btn"
            onClick={() => onRewind?.(message.id, message.content)}
            title="Rewind to this message (edit and resend)"
          >
            ↩
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="cc-message cc-message--assistant">
      {message.content && (
        <div className="cc-bubble cc-bubble--assistant">
          {renderContent(message.content)}
        </div>
      )}
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
