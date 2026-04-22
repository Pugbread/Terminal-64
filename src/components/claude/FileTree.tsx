import { useState, useCallback, useRef, useEffect } from "react";
import { listDirectory, searchFiles } from "../../lib/tauriApi";
import type { DirEntry } from "../../lib/types";
import { joinPath, baseName } from "../../lib/platform";

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
      } catch (e) {
        console.warn("[file-tree] Failed to list directory:", fullPath, e);
        setChildren([]);
      }
      setLoading(false);
    }
    setExpanded(true);
  }, [isDir, expanded, children, fullPath, onFileClick, code]);

  return (
    <div>
      <div
        className={`cft-node ${isDir ? "cft-node--dir" : code ? "cft-node--file" : "cft-node--dim"}`}
        style={{ paddingLeft: depth * 14 + 8 }}
        onClick={toggle}
      >
        {isDir && (
          <span className={`cft-arrow ${expanded ? "cft-arrow--open" : ""}`}>▸</span>
        )}
        <span className="cft-icon">{fileIcon(name, isDir)}</span>
        <span className="cft-name">{name}</span>
        {loading && <span className="cft-loading">…</span>}
      </div>
      {expanded && children && children.map((child) => (
        <TreeNode
          key={child.name}
          name={child.name}
          fullPath={joinPath(fullPath, child.name)}
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
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<string[] | null>(null);
  const [searching, setSearching] = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current); };
  }, []);

  // Load root directory on mount
  useEffect(() => {
    listDirectory(cwd).then(setEntries).catch(() => setError(true));
  }, [cwd]);

  const handleSearch = useCallback((value: string) => {
    setQuery(value);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (!value.trim()) {
      setSearchResults(null);
      return;
    }
    setSearching(true);
    searchTimer.current = setTimeout(() => {
      searchFiles(cwd, value.trim()).then((results) => {
        setSearchResults(results);
        setSearching(false);
      }).catch(() => {
        setSearchResults([]);
        setSearching(false);
      });
    }, 200);
  }, [cwd]);


  const dirName = baseName(cwd) || cwd;

  return (
    <div className="cft-sidebar" onClick={(e) => e.stopPropagation()}>
      <div className="cft-header">
        <span className="cft-title">{dirName}</span>
        <button className="cft-close" onClick={onClose}>×</button>
      </div>
      <div className="cft-search">
        <input
          className="cft-search-input"
          placeholder="Search files…"
          value={query}
          onChange={(e) => handleSearch(e.target.value)}
          autoFocus
        />
      </div>
      <div className="cft-tree">
        {searchResults !== null ? (
          <>
            {searching && <div className="cft-empty">Searching…</div>}
            {!searching && searchResults.length === 0 && <div className="cft-empty">No results</div>}
            {searchResults.map((rel) => {
              const fullPath = joinPath(cwd, rel);
              const name = baseName(rel) || rel;
              const code = isCodeFile(name);
              return (
                <div
                  key={rel}
                  className={`cft-node cft-search-result ${code ? "cft-node--file" : "cft-node--dim"}`}
                  style={{ paddingLeft: 8 }}
                  onClick={() => code && onFileClick(fullPath)}
                >
                  <span className="cft-icon">{fileIcon(name, false)}</span>
                  <span className="cft-name cft-search-path">{rel}</span>
                </div>
              );
            })}
          </>
        ) : (
          <>
            {error && <div className="cft-empty">Failed to load directory</div>}
            {!entries && !error && <div className="cft-empty">Loading…</div>}
            {entries && entries.length === 0 && <div className="cft-empty">Empty directory</div>}
            {entries && entries.map((entry) => (
              <TreeNode
                key={entry.name}
                name={entry.name}
                fullPath={joinPath(cwd, entry.name)}
                isDir={entry.is_dir}
                onFileClick={onFileClick}
                depth={0}
              />
            ))}
          </>
        )}
      </div>
    </div>
  );
}
