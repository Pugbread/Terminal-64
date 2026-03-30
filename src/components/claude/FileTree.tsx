import { useState, useCallback } from "react";
import { listDirectory, readFile } from "../../lib/tauriApi";
import type { DirEntry } from "../../lib/types";

const CODE_EXTS = new Set([
  "ts", "tsx", "js", "jsx", "rs", "py", "go", "java", "json", "css", "scss",
  "html", "md", "yaml", "yml", "toml", "sh", "bash", "zsh", "sql", "xml",
  "swift", "kt", "rb", "c", "cpp", "h", "hpp", "vue", "svelte", "astro",
  "lua", "zig", "hs", "ml", "ex", "exs", "php", "cs", "fs", "lock",
  "cfg", "ini", "conf", "env", "txt", "csv", "makefile", "dockerfile",
]);

function isCodeFile(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower === "makefile" || lower === "dockerfile" || lower === "rakefile") return true;
  const ext = lower.split(".").pop() || "";
  return CODE_EXTS.has(ext);
}

function fileIcon(name: string, isDir: boolean): string {
  if (isDir) return "📁";
  const ext = name.split(".").pop()?.toLowerCase() || "";
  if (["ts", "tsx"].includes(ext)) return "⬡";
  if (["js", "jsx"].includes(ext)) return "◆";
  if (ext === "rs") return "⚙";
  if (ext === "py") return "◈";
  if (ext === "json") return "{}";
  if (["css", "scss"].includes(ext)) return "#";
  if (ext === "md") return "¶";
  if (["html", "xml", "svg"].includes(ext)) return "◇";
  return "·";
}

interface TreeNodeProps {
  name: string;
  fullPath: string;
  isDir: boolean;
  onFileClick: (path: string) => void;
  depth: number;
}

function TreeNode({ name, fullPath, isDir, onFileClick, depth }: TreeNodeProps) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<DirEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const code = !isDir && isCodeFile(name);

  const toggle = useCallback(async () => {
    if (!isDir) {
      if (code) onFileClick(fullPath);
      return;
    }
    if (expanded) {
      setExpanded(false);
      return;
    }
    if (children === null) {
      setLoading(true);
      try {
        const entries = await listDirectory(fullPath);
        setChildren(entries);
      } catch {
        setChildren([]);
      }
      setLoading(false);
    }
    setExpanded(true);
  }, [isDir, expanded, children, fullPath, onFileClick, code]);

  return (
    <div>
      <div
        className={`ft-node ${isDir ? "ft-node--dir" : code ? "ft-node--file" : "ft-node--dim"}`}
        style={{ paddingLeft: depth * 14 + 8 }}
        onClick={toggle}
      >
        {isDir && (
          <span className={`ft-arrow ${expanded ? "ft-arrow--open" : ""}`}>▸</span>
        )}
        <span className="ft-icon">{fileIcon(name, isDir)}</span>
        <span className="ft-name">{name}</span>
        {loading && <span className="ft-loading">…</span>}
      </div>
      {expanded && children && children.map((child) => (
        <TreeNode
          key={child.name}
          name={child.name}
          fullPath={`${fullPath}/${child.name}`}
          isDir={child.is_dir}
          onFileClick={onFileClick}
          depth={depth + 1}
        />
      ))}
    </div>
  );
}

interface FileTreeProps {
  cwd: string;
  onFileClick: (path: string) => void;
  onClose: () => void;
}

export default function FileTree({ cwd, onFileClick, onClose }: FileTreeProps) {
  const [entries, setEntries] = useState<DirEntry[] | null>(null);
  const [error, setError] = useState(false);

  // Load root on first render
  if (entries === null && !error) {
    listDirectory(cwd).then(setEntries).catch(() => setError(true));
  }

  const dirName = cwd.replace(/\\/g, "/").split("/").pop() || cwd;

  return (
    <div className="ft-sidebar" onClick={(e) => e.stopPropagation()}>
      <div className="ft-header">
        <span className="ft-title">{dirName}</span>
        <button className="ft-close" onClick={onClose}>×</button>
      </div>
      <div className="ft-tree">
        {error && <div className="ft-empty">Failed to load directory</div>}
        {!entries && !error && <div className="ft-empty">Loading…</div>}
        {entries && entries.length === 0 && <div className="ft-empty">Empty directory</div>}
        {entries && entries.map((entry) => (
          <TreeNode
            key={entry.name}
            name={entry.name}
            fullPath={`${cwd}/${entry.name}`}
            isDir={entry.is_dir}
            onFileClick={onFileClick}
            depth={0}
          />
        ))}
      </div>
    </div>
  );
}
