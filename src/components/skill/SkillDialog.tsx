import { useState, useEffect, useRef, useMemo } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { listSkills, createSkillFolder, deleteSkill, createClaudeSession, shellExec, SkillInfo } from "../../lib/tauriApi";
import { useCanvasStore } from "../../stores/canvasStore";
import { useClaudeStore } from "../../stores/claudeStore";
import { useSettingsStore } from "../../stores/settingsStore";
import type { PermissionMode } from "../../lib/types";
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

After creating the skill, suggest relevant tags for categorization (e.g. "game-dev", "web", "data", "automation", "devops"). Tags help users filter and find skills in the library.

**Start by asking the user what skill they want to create.**`;

function buildSkillPrompt(skillFolderPath: string): string {
  return SKILL_CREATOR_PROMPT + `\n\n**Important:** The skill files (SKILL.md, scripts/, references/, etc.) must be written to: \`${skillFolderPath}\`\nYour working directory is the user's project — use it to understand context, read code, and explore the codebase. But the actual skill output goes in the path above.`;
}

interface SkillDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function SkillDialog({ isOpen, onClose }: SkillDialogProps) {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [name, setName] = useState("");
  const [dir, setDir] = useState("");
  const [creating, setCreating] = useState(false);
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const recentDirs = useSettingsStore((s) => s.recentDirs);
  const addRecentDir = useSettingsStore((s) => s.addRecentDir);

  const refreshList = () => listSkills().then(setSkills).catch(() => {});

  useEffect(() => {
    if (!isOpen) return;
    setName("");
    setDir("");
    setActiveTag(null);
    refreshList();
    setTimeout(() => inputRef.current?.focus(), 100);
  }, [isOpen]);

  const handleBrowse = async () => {
    const selected = await open({ directory: true, title: "Select project folder" });
    if (selected) setDir(selected as string);
  };

  // Collect all unique tags across skills
  const allTags = useMemo(() => {
    const tagSet = new Set<string>();
    for (const s of skills) {
      if (s.tags) s.tags.forEach((t) => tagSet.add(t));
    }
    return Array.from(tagSet).sort();
  }, [skills]);

  // Filter skills by active tag
  const filteredSkills = useMemo(() => {
    if (!activeTag) return skills;
    return skills.filter((s) => s.tags?.includes(activeTag));
  }, [skills, activeTag]);

  if (!isOpen) return null;

  const handleCreate = async () => {
    const id = name.trim().toLowerCase().replace(/[^a-z0-9-_]/g, "-").replace(/-+/g, "-");
    if (!id || !dir.trim()) return;
    setCreating(true);
    try {
      const skillFolderPath = await createSkillFolder(id);
      const skillName = name.trim();
      const projectDir = dir.trim();
      addRecentDir(projectDir);
      const prompt = buildSkillPrompt(skillFolderPath);
      // Open Claude session with CWD = project directory (not the skill folder)
      useCanvasStore.getState().addClaudeTerminal(projectDir, false, `Skill: ${skillName}`);
      const terminals = useCanvasStore.getState().terminals;
      const claudePanel = terminals[terminals.length - 1];
      if (claudePanel?.panelType === "claude") {
        const sid = claudePanel.terminalId;
        useClaudeStore.getState().createSession(sid, `Skill: ${skillName}`);
        useClaudeStore.getState().addUserMessage(sid, prompt);
        const permMode = (useSettingsStore.getState().claudePermMode || "default") as PermissionMode;
        setTimeout(() => {
          createClaudeSession({
            session_id: sid,
            cwd: projectDir,
            prompt,
            permission_mode: permMode,
          }).catch((err) => {
            useClaudeStore.getState().setError(sid, String(err));
          });
          useClaudeStore.getState().incrementPromptCount(sid);
        }, 300);
      }
      onClose();
    } catch (err) {
      console.warn("[skill] Failed to create:", err);
    } finally {
      setCreating(false);
    }
  };

  const handleOpen = async (skill: SkillInfo) => {
    // createSkillFolder is idempotent (mkdir -p) and returns the path
    const folderPath = await createSkillFolder(skill.name);
    useCanvasStore.getState().addClaudeTerminal(folderPath, false, `Skill: ${skill.name}`);
    const terminals = useCanvasStore.getState().terminals;
    const claudePanel = terminals[terminals.length - 1];
    if (claudePanel?.panelType === "claude") {
      const sid = claudePanel.terminalId;
      useClaudeStore.getState().createSession(sid, `Skill: ${skill.name}`);
    }
    onClose();
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

  const formatTime = (ms: number) => {
    if (!ms) return "";
    const now = Date.now();
    const diff = now - ms;
    if (diff < 60000) return "just now";
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return new Date(ms).toLocaleDateString();
  };

  return (
    <div className="skl-dialog-overlay" onClick={onClose}>
      <div className="skl-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="skl-dialog-header">
          <span className="skl-dialog-title">Skills</span>
          <button className="skl-dialog-close" onClick={onClose}>
            <svg width="10" height="10" viewBox="0 0 10 10">
              <path d="M1 1L9 9M9 1L1 9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="skl-dialog-body">
          <div className="skl-form">
            <label>Create a new skill</label>
            <input
              ref={inputRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Skill name..."
              onKeyDown={(e) => {
                if (e.key === "Enter" && name.trim() && dir.trim()) handleCreate();
                if (e.key === "Escape") onClose();
              }}
            />
            <label>Project directory</label>
            <div className="skl-dir-row">
              <input
                value={dir}
                onChange={(e) => setDir(e.target.value)}
                placeholder="Select or type a project path..."
                onKeyDown={(e) => {
                  if (e.key === "Enter" && name.trim() && dir.trim()) handleCreate();
                  if (e.key === "Escape") onClose();
                }}
              />
              <button className="skl-btn skl-btn--browse" onClick={handleBrowse}>Browse</button>
            </div>
            {recentDirs.length > 0 && !dir.trim() && (
              <div className="skl-recent-dirs">
                {recentDirs.map((d) => (
                  <button key={d} className="skl-recent-dir" onClick={() => setDir(d)}>
                    {d.split(/[/\\]/).slice(-2).join("/")}
                  </button>
                ))}
              </div>
            )}
            <div className="skl-form-actions">
              <button className="skl-btn skl-btn--cancel" onClick={onClose}>Cancel</button>
              <button
                className="skl-btn skl-btn--create"
                onClick={handleCreate}
                disabled={!name.trim() || !dir.trim() || creating}
              >
                {creating ? "Creating..." : "Create"}
              </button>
            </div>
          </div>

          {/* Tag filter bar */}
          {allTags.length > 0 && (
            <div className="skl-tags-bar">
              {allTags.map((tag) => (
                <span
                  key={tag}
                  className={`skl-tag ${activeTag === tag ? "skl-tag--active" : ""}`}
                  onClick={() => setActiveTag(activeTag === tag ? null : tag)}
                >
                  {tag}
                </span>
              ))}
            </div>
          )}

          {filteredSkills.length > 0 && (
            <>
              <div className="skl-section-label">
                {activeTag ? `Skills tagged "${activeTag}"` : "Existing Skills"}
              </div>
              <div className="skl-list">
                {filteredSkills.map((s) => (
                  <div
                    key={s.name}
                    className="skl-list-item"
                    onClick={() => handleOpen(s)}
                  >
                    <div className={`skl-list-item-dot ${s.has_skill_md ? "skl-list-item-dot--ready" : "skl-list-item-dot--empty"}`} />
                    <div className="skl-list-item-info">
                      <span className="skl-list-item-name">{s.name}</span>
                      {s.description && (
                        <span className="skl-list-item-desc">{s.description}</span>
                      )}
                      {s.tags && s.tags.length > 0 && (
                        <div className="skl-list-item-tags">
                          {s.tags.map((t) => (
                            <span key={t} className="skl-list-item-tag">{t}</span>
                          ))}
                        </div>
                      )}
                    </div>
                    <span className="skl-list-item-time">{formatTime(s.modified)}</span>
                    <button
                      className="skl-list-item-delete"
                      onClick={(e) => handleDelete(e, s)}
                      title="Delete skill"
                    >
                      <svg width="10" height="10" viewBox="0 0 10 10">
                        <path d="M2 3H8M3 3V8.5H7V3M4 4.5V7M6 4.5V7M3.5 3L4 1.5H6L6.5 3" stroke="currentColor" strokeWidth="0.9" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}

          {filteredSkills.length === 0 && skills.length === 0 && (
            <div className="skl-empty">
              No skills yet. Create one to get started.
            </div>
          )}

          {filteredSkills.length === 0 && skills.length > 0 && activeTag && (
            <div className="skl-empty">
              No skills with tag "{activeTag}".
            </div>
          )}

          <button
            className="skl-open-folder"
            onClick={() => {
              const cmd = navigator.platform.includes("Win")
                ? 'explorer.exe "%USERPROFILE%\\.terminal64\\skills"'
                : 'open "$HOME/.terminal64/skills"';
              shellExec(cmd).catch(() => {});
            }}
          >
            Open Skills Folder
          </button>
        </div>
      </div>
    </div>
  );
}
