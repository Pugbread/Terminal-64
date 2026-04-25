import { useState, useEffect, useRef, useMemo } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { listSkills, createSkillFolder, deleteSkill, getSkillCreatorPath, ensureSkillsPlugin, readSkillContent, spawnClaudeWithPrompt, syncClaudeSkills, generateSkillMetadata } from "../../lib/tauriApi";
import { useCanvasStore } from "../../stores/canvasStore";
import { useClaudeStore } from "../../stores/claudeStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { formatRelativeTime, openSystemFolder } from "../../lib/constants";
import type { SkillInfo } from "../../lib/types";
import "./Skill.css";

const SKILL_CREATOR_PROMPT = `You are the Skill Creator for Terminal 64. Your job is to help the user create a Claude Code skill — a reusable set of instructions that Claude loads when triggered by matching user prompts.

## What is a skill?

A skill is a folder containing a \`SKILL.md\` file with YAML frontmatter and markdown instructions:

\`\`\`
skill-name/
├── SKILL.md          (required — frontmatter + instructions)
├── scripts/          (optional — executable helpers)
├── references/       (optional — docs loaded as needed)
└── assets/           (optional — templates, icons, etc.)
\`\`\`

### SKILL.md format

\`\`\`markdown
---
name: my-skill
description: What this skill does and when to trigger it. Be specific — include contexts and phrases that should activate the skill.
---

# My Skill

Instructions for Claude when this skill is active...
\`\`\`

## Your workflow

1. **Understand intent** — Ask: What should this skill enable Claude to do? When should it trigger? What's the expected output?
2. **Interview** — Clarify edge cases, input/output formats, dependencies
3. **Draft the SKILL.md** — Write the frontmatter and instructions
4. **Test** — Create 2-3 realistic test prompts and try them
5. **Iterate** — Improve based on results

## Key guidelines

- **name**: kebab-case, max 64 chars (e.g. \`roblox-helper\`, \`api-generator\`)
- **description**: Be specific and slightly "pushy" — Claude tends to under-trigger skills. Include contexts, phrases, and adjacent topics that should activate it
- Keep SKILL.md under 500 lines — use reference files for larger content
- Explain *why* things are important rather than using rigid MUST/NEVER rules
- Use imperative form in instructions
- Include examples where helpful
- For multi-domain skills, use reference files per domain

## Tags

After creating the skill, assign exactly **2 tags** for categorization (e.g. "game-dev", "web", "data", "automation", "devops"). Never add more than 2 tags — pick the two most relevant. Tags help users filter and find skills in the library.

**Start by asking the user what skill they want to create.**`;

function buildSkillPrompt(skillFolderPath: string, skillCreatorPath?: string): string {
  let prompt = SKILL_CREATOR_PROMPT + `\n\n**Important:** The skill files (SKILL.md, scripts/, references/, etc.) must be written to: \`${skillFolderPath}\`\nYour working directory is the user's project — use it to understand context, read code, and explore the codebase. But the actual skill output goes in the path above.`;
  if (skillCreatorPath) {
    prompt += `\n\n## Skill Creator Toolkit\n\nThe full skill-creator toolkit is available at: \`${skillCreatorPath}/\`\n\nIt contains:\n- \`SKILL.md\` — Full skill creation guide (read this for detailed workflow)\n- \`agents/\` — Subagent instructions (grader.md, comparator.md, analyzer.md)\n- \`scripts/\` — Python utilities: \`quick_validate.py\`, \`package_skill.py\`, \`run_eval.py\`, \`aggregate_benchmark.py\`, \`improve_description.py\`, \`run_loop.py\`\n- \`eval-viewer/\` — \`generate_review.py\` + \`viewer.html\` for reviewing test results\n- \`references/schemas.md\` — JSON schemas for evals, grading, benchmarks\n- \`assets/eval_review.html\` — Trigger eval review template\n\nRead the full SKILL.md at that path for the complete workflow including eval, benchmarking, and description optimization.`;
  }
  return prompt;
}

// ── Tag color system ──────────────────────────────
const TAG_PALETTE = [
  "#89dceb", "#cba6f7", "#f9e2af", "#a6e3a1", "#f38ba8",
  "#89b4fa", "#fab387", "#94e2d5", "#eba0ac", "#74c7ec",
  "#f5c2e7", "#b4befe",
];

function tagColor(tag: string): string {
  let hash = 0;
  for (let i = 0; i < tag.length; i++) hash = ((hash << 5) - hash + tag.charCodeAt(i)) | 0;
  return TAG_PALETTE[Math.abs(hash) % TAG_PALETTE.length]!;
}

function primaryAccent(skill: SkillInfo): string {
  const firstTag = skill.tags?.[0];
  if (firstTag) return tagColor(firstTag);
  return "#89dceb";
}

// ── Component ─────────────────────────────────────
interface SkillDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function SkillDialog({ isOpen, onClose }: SkillDialogProps) {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [name, setName] = useState("");
  const [dir, setDir] = useState("");
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const recentDirs = useSettingsStore((s) => s.recentDirs);
  const addRecentDir = useSettingsStore((s) => s.addRecentDir);

  const refreshList = () => listSkills().then((list) => {
    setSkills(list);
    for (const s of list) {
      if (s.pending_backfill) {
        generateSkillMetadata(s.name)
          .then(() => listSkills().then(setSkills).catch(() => {}))
          .catch(() => {});
      }
    }
  }).catch(() => {});

  useEffect(() => {
    if (!isOpen) return;
    setName("");
    setDir("");
    setSearch("");
    setActiveTag(null);
    setShowCreate(false);
    setDetailSkill(null);
    setDetailContent(null);
    (async () => {
      try { await syncClaudeSkills(); } catch {}
      refreshList();
    })();
    setTimeout(() => searchRef.current?.focus(), 120);
  }, [isOpen]);

  useEffect(() => {
    if (showCreate) setTimeout(() => nameRef.current?.focus(), 80);
  }, [showCreate]);

  const handleBrowse = async () => {
    const selected = await open({ directory: true, title: "Select project folder" });
    if (selected) setDir(selected as string);
  };

  // Collect all unique tags
  const allTags = useMemo(() => {
    const tagSet = new Set<string>();
    for (const s of skills) {
      if (s.tags) s.tags.forEach((t) => tagSet.add(t));
    }
    return Array.from(tagSet).sort();
  }, [skills]);

  // Filter skills by search + tag
  const filteredSkills = useMemo(() => {
    let result = skills;
    if (activeTag) {
      result = result.filter((s) => s.tags?.includes(activeTag));
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      result = result.filter((s) =>
        s.name.toLowerCase().includes(q) ||
        (s.description && s.description.toLowerCase().includes(q)) ||
        (s.tags && s.tags.some((t) => t.toLowerCase().includes(q)))
      );
    }
    return result;
  }, [skills, activeTag, search]);

  // Detail view state (must be before early return to satisfy hook rules)
  const [detailSkill, setDetailSkill] = useState<SkillInfo | null>(null);
  const [detailContent, setDetailContent] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (detailSkill) { e.stopPropagation(); setDetailSkill(null); setDetailContent(null); return; }
      if (showCreate) { e.stopPropagation(); setShowCreate(false); return; }
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isOpen, onClose, detailSkill, showCreate]);

  if (!isOpen) return null;

  const handleCreate = async () => {
    const id = name.trim().toLowerCase().replace(/[^a-z0-9-_]/g, "-").replace(/-+/g, "-");
    if (!id || !dir.trim()) return;
    setCreating(true);
    try {
      const skillFolderPath = await createSkillFolder(id);
      const skillCreatorPath = await getSkillCreatorPath().catch(() => undefined);
      const skillName = name.trim();
      const projectDir = dir.trim();
      addRecentDir(projectDir);
      const prompt = buildSkillPrompt(skillFolderPath, skillCreatorPath);
      const activeId = useCanvasStore.getState().activeTerminalId;
      const activeProvider = activeId
        ? useClaudeStore.getState().sessions[activeId]?.provider
        : undefined;
      spawnClaudeWithPrompt(projectDir, `Skill: ${skillName}`, prompt, () => ({
        canvasStore: useCanvasStore,
        claudeStore: useClaudeStore,
        settingsStore: useSettingsStore,
      }), { skipOpenwolf: true, provider: activeProvider ?? "anthropic" });
      onClose();
    } catch (err) {
      console.warn("[skill] Failed to create:", err);
    } finally {
      setCreating(false);
    }
  };

  const handleOpen = async (skill: SkillInfo) => {
    setDetailSkill(skill);
    setDetailLoading(true);
    setDetailContent(null);
    try {
      const content = await readSkillContent(skill.name);
      setDetailContent(content);
    } catch (e) {
      console.warn("[skill] Failed to read skill content:", e);
      setDetailContent(null);
    } finally {
      setDetailLoading(false);
    }
  };

  const handleUseSkill = (skill: SkillInfo) => {
    // Find the active Claude session and insert /skill-name into its draft
    const activeId = useCanvasStore.getState().activeTerminalId;
    const terminals = useCanvasStore.getState().terminals;
    const activeTerm = terminals.find((t) => t.terminalId === activeId && t.panelType === "claude");
    if (activeTerm) {
      const sid = activeTerm.terminalId;
      useClaudeStore.getState().setDraftPrompt(sid, `/${skill.name} `);
    }
    onClose();
  };

  const handleBackToList = () => {
    setDetailSkill(null);
    setDetailContent(null);
  };

  const handleDelete = async (e: React.MouseEvent, skill: SkillInfo) => {
    e.stopPropagation();
    try {
      await deleteSkill(skill.name);
      refreshList();
    } catch (err) {
      console.warn("[skill] Failed to delete:", err);
    }
  };

  return (
    <div className="skl-overlay" onClick={onClose}>
      <div className="skl-dialog" onClick={(e) => e.stopPropagation()}>
        {/* ── Header ── */}
        <div className="skl-header">
          <div className="skl-header-left">
            {detailSkill ? (
              <button className="skl-back-btn" onClick={handleBackToList}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M19 12H5M12 19l-7-7 7-7"/>
                </svg>
              </button>
            ) : (
              <div className="skl-header-icon">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
                </svg>
              </div>
            )}
            <div className="skl-header-text">
              <span className="skl-title">{detailSkill ? detailSkill.name : "Skill Library"}</span>
              <span className="skl-subtitle">
                {detailSkill
                  ? (detailSkill.description || "No description")
                  : skills.length === 0 ? "No skills yet" : `${skills.length} skill${skills.length !== 1 ? "s" : ""}`
                }
              </span>
            </div>
          </div>
          <button className="skl-close" onClick={onClose}>
            <svg width="12" height="12" viewBox="0 0 12 12">
              <path d="M2 2L10 10M10 2L2 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* ── Body ── */}
        {detailSkill ? (
          /* ── Detail View ── */
          <>
            <div className="skl-body">
              {/* Tags */}
              {detailSkill.tags && detailSkill.tags.length > 0 && (
                <div className="skl-detail-tags">
                  {detailSkill.tags.map((t) => (
                    <span
                      key={t}
                      className="skl-card-tag"
                      style={{ "--skl-tag-color": tagColor(t) } as React.CSSProperties}
                    >
                      {t}
                    </span>
                  ))}
                </div>
              )}

              {/* Command hint */}
              <div className="skl-detail-command">
                <span className="skl-detail-command-label">Slash command</span>
                <code className="skl-detail-command-value">/{detailSkill.name}</code>
              </div>

              {/* SKILL.md content preview */}
              <div className="skl-detail-section">
                <span className="skl-detail-section-label">SKILL.md</span>
                {detailLoading ? (
                  <div className="skl-detail-loading">Loading...</div>
                ) : detailContent ? (
                  <pre className="skl-detail-content">{detailContent}</pre>
                ) : (
                  <div className="skl-detail-empty">No SKILL.md found</div>
                )}
              </div>
            </div>

            {/* Detail footer */}
            <div className="skl-footer skl-detail-footer">
              <button
                className="skl-use-btn"
                onClick={() => handleUseSkill(detailSkill)}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 12h14M12 5l7 7-7 7"/>
                </svg>
                Use Skill
              </button>
            </div>
          </>
        ) : (
          /* ── List View ── */
          <>
            <div className="skl-body">
              {/* Toolbar: search + mode toggle + new */}
              <div className="skl-toolbar">
                <div className="skl-search">
                  <svg className="skl-search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="11" cy="11" r="8"/>
                    <path d="M21 21l-4.35-4.35"/>
                  </svg>
                  <input
                    ref={searchRef}
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search skills..."
                    onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
                  />
                </div>
                <button
                  className={`skl-new-btn ${showCreate ? "skl-new-btn--cancel" : ""}`}
                  onClick={() => setShowCreate(!showCreate)}
                >
                  {showCreate ? "Cancel" : "+ New"}
                </button>
              </div>

              {/* Create panel (collapsible) */}
              {showCreate && (
                <div className="skl-create">
                  <div className="skl-create-fields">
                    <div className="skl-create-field">
                      <div className="skl-create-label">Skill name</div>
                      <input
                        ref={nameRef}
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="my-awesome-skill"
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && name.trim() && dir.trim()) handleCreate();
                          if (e.key === "Escape") setShowCreate(false);
                        }}
                      />
                    </div>
                    <div className="skl-create-field">
                      <div className="skl-create-label">Project directory</div>
                      <div className="skl-dir-row">
                        <input
                          value={dir}
                          onChange={(e) => setDir(e.target.value)}
                          placeholder="Select or type a project path..."
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && name.trim() && dir.trim()) handleCreate();
                            if (e.key === "Escape") setShowCreate(false);
                          }}
                        />
                        <button className="skl-browse-btn" onClick={handleBrowse}>Browse</button>
                      </div>
                      {recentDirs.length > 0 && !dir.trim() && (
                        <div className="skl-recents">
                          {recentDirs.map((d) => (
                            <button key={d} className="skl-recent" onClick={() => setDir(d)}>
                              {d.split(/[/\\]/).slice(-2).join("/")}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="skl-create-actions">
                    <button
                      className="skl-create-btn"
                      onClick={handleCreate}
                      disabled={!name.trim() || !dir.trim() || creating}
                    >
                      {creating ? "Creating..." : "Create Skill"}
                    </button>
                  </div>
                </div>
              )}

              {/* Tag filter + grid */}
              {allTags.length > 0 && (
                <div className="skl-tags">
                  {allTags.filter((tag) => !search.trim() || tag.toLowerCase().includes(search.trim().toLowerCase())).map((tag) => {
                    const color = tagColor(tag);
                    return (
                      <span
                        key={tag}
                        className={`skl-tag ${activeTag === tag ? "skl-tag--active" : ""}`}
                        style={{ "--skl-tag-color": color } as React.CSSProperties}
                        onClick={() => setActiveTag(activeTag === tag ? null : tag)}
                      >
                        <span className="skl-tag-dot" />
                        {tag}
                      </span>
                    );
                  })}
                </div>
              )}

              {/* Skills grid */}
              {filteredSkills.length > 0 && (
                <>
                  <div className="skl-section-label">
                    {activeTag ? `Tagged "${activeTag}"` : search.trim() ? "Results" : "All skills"}
                  </div>
                  <div className="skl-grid">
                    {filteredSkills.map((s) => {
                      const accent = primaryAccent(s);
                      return (
                        <div
                          key={s.name}
                          className="skl-card"
                          style={{ "--skl-card-accent": accent } as React.CSSProperties}
                          onClick={() => handleOpen(s)}
                        >
                          <div className="skl-card-accent" />
                          <div className="skl-card-content">
                            <div className="skl-card-top">
                              <span className="skl-card-name">{s.name}</span>
                              {s.imported_from && (
                                <span className="skl-card-imported" title={`Imported from ${s.imported_from}`}>imported</span>
                              )}
                              <span className={`skl-card-status ${s.has_skill_md ? "skl-card-status--ready" : "skl-card-status--empty"}`} />
                            </div>
                            {s.description && (
                              <span className="skl-card-desc">{s.description}</span>
                            )}
                            <div className="skl-card-footer">
                              <div className="skl-card-tags">
                                {s.tags && s.tags.map((t) => (
                                  <span
                                    key={t}
                                    className="skl-card-tag"
                                    style={{ "--skl-tag-color": tagColor(t) } as React.CSSProperties}
                                  >
                                    {t}
                                  </span>
                                ))}
                              </div>
                              <span className="skl-card-time">{formatRelativeTime(s.modified)}</span>
                            </div>
                          </div>
                          <button
                            className="skl-card-delete"
                            onClick={(e) => handleDelete(e, s)}
                            title="Delete skill"
                          >
                            <svg width="12" height="12" viewBox="0 0 12 12">
                              <path d="M2.5 3.5H9.5M4 3.5V9.5H8V3.5M5 5V8M7 5V8M4.2 3.5L4.8 2H7.2L7.8 3.5" stroke="currentColor" strokeWidth="0.9" strokeLinecap="round" strokeLinejoin="round"/>
                            </svg>
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}

              {/* Empty states */}
              {filteredSkills.length === 0 && skills.length === 0 && (
                <div className="skl-empty">
                  <div className="skl-empty-glyph">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
                    </svg>
                  </div>
                  <div className="skl-empty-text">
                    <div className="skl-empty-title">No skills yet</div>
                    <div className="skl-empty-desc">
                      Skills are reusable instruction sets for Claude.<br />
                      Hit <strong style={{ color: "var(--accent, #89b4fa)" }}>+ New</strong> to craft your first one.
                    </div>
                  </div>
                </div>
              )}

              {filteredSkills.length === 0 && skills.length > 0 && (
                <div className="skl-empty">
                  <div className="skl-empty-text">
                    <div className="skl-empty-title">No matches</div>
                    <div className="skl-empty-desc">
                      {activeTag && search.trim()
                        ? `No skills matching "${search}" with tag "${activeTag}".`
                        : activeTag
                          ? `No skills tagged "${activeTag}".`
                          : `No skills matching "${search}".`
                      }
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* ── Footer ── */}
            <div className="skl-footer">
              <button
                className="skl-folder-btn"
                onClick={() => openSystemFolder("$HOME/.terminal64/skills")}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                </svg>
                Open Skills Folder
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
