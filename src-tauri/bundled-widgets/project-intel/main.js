/**
 * Project Intelligence Dashboard — main.js
 *
 * Communicates with Terminal 64 via postMessage bridge (t64:* protocol).
 * Five panels: Token Usage, File Anatomy, Learning Memory, Bug Log, Semantic Search.
 */

// ---- T64 Bridge Helpers ----

let _msgId = 0;
function nextId() { return `pi-${++_msgId}`; }

function post(type, payload) {
  window.parent.postMessage({ type, payload }, "*");
}

/** Send a request and wait for a response with a matching id */
function request(type, payload, responseType, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const id = nextId();
    const timer = setTimeout(() => {
      window.removeEventListener("message", handler);
      reject(new Error(`Timeout waiting for ${responseType}`));
    }, timeout);

    function handler(e) {
      const msg = e.data;
      if (msg && msg.type === responseType && msg.payload && msg.payload.id === id) {
        clearTimeout(timer);
        window.removeEventListener("message", handler);
        resolve(msg.payload);
      }
    }
    window.addEventListener("message", handler);
    post(type, { ...payload, id });
  });
}

function readFile(path) {
  return request("t64:read-file", { path }, "t64:file-content").then(r => {
    if (r.error) throw new Error(r.error);
    return r.content;
  });
}

function searchFiles(cwd, query) {
  return request("t64:search-files", { cwd, query }, "t64:search-results").then(r => {
    if (r.error) throw new Error(r.error);
    return r.results;
  });
}

function execCommand(command, cwd) {
  return request("t64:exec", { command, cwd }, "t64:exec-result").then(r => {
    if (r.code !== 0 && r.stderr) throw new Error(r.stderr);
    return r;
  });
}

function getState(key) {
  return request("t64:get-state", { key }, "t64:state-value").then(r => {
    if (r.error) throw new Error(r.error);
    return r.value;
  });
}

function setState(key, value) {
  return request("t64:set-state", { key, value }, "t64:state-saved");
}

function subscribe(topic) {
  post("t64:subscribe", { topic });
}

// ---- State ----

let activePanel = "anatomy";
let themeColors = {};
let projectCwd = ".";

// Data caches
let anatomyData = null;
let memoryData = null;
let bugData = null;
let memoryFilter = "all";
const TYPE_LABELS = { dnr: "Do-Not-Repeat", pref: "Preference", learning: "Learning", decision: "Decision" };

// ---- Init ----

window.addEventListener("message", (e) => {
  const msg = e.data;
  if (!msg || !msg.type) return;

  switch (msg.type) {
    case "t64:init": {
      const p = msg.payload || {};
      if (p.theme) {
        themeColors = p.theme.ui || {};
        applyTheme(p.theme);
      }
      // Load saved project dir, then load panels
      loadSavedProject();
      break;
    }

    case "t64:broadcast": {
      const { topic, data } = msg.payload || {};
      if (topic === "wolf:updated") {
        loadAllPanels();
      }
      break;
    }

    case "t64:directory-picked": {
      const { path } = msg.payload || {};
      if (path) {
        projectCwd = path;
        updateProjectDisplay();
        setState("pi-project-cwd", projectCwd).catch(() => {});
        loadAllPanels();
      }
      break;
    }
  }
});

async function loadSavedProject() {
  try {
    const saved = await getState("pi-project-cwd");
    if (saved) {
      projectCwd = saved;
    }
  } catch {}
  updateProjectDisplay();
  loadAllPanels();
}

function updateProjectDisplay() {
  const el = document.getElementById("projectPath");
  if (!el) return;
  if (projectCwd && projectCwd !== ".") {
    el.textContent = projectCwd;
    el.classList.remove("pi-project-path--none");
  } else {
    el.textContent = "No project selected";
    el.classList.add("pi-project-path--none");
  }
}

function pickDirectory() {
  post("t64:pick-directory", { id: nextId() });
}

document.getElementById("pickDir").addEventListener("click", pickDirectory);

// Request initial state
post("t64:request-state", {});

// Subscribe to wolf update events
subscribe("wolf:updated");
subscribe("vector:indexed");

// ---- Theme ----

function applyTheme(theme) {
  const ui = theme.ui || {};
  const root = document.documentElement;
  if (ui.bg) root.style.setProperty("--pi-bg", ui.bg);
  if (ui.bgSecondary) root.style.setProperty("--pi-bg-secondary", ui.bgSecondary);
  if (ui.border) root.style.setProperty("--pi-border", ui.border);
  if (ui.fg) root.style.setProperty("--pi-fg", ui.fg);
  if (ui.fgMuted) root.style.setProperty("--pi-fg-muted", ui.fgMuted);
  if (ui.accent) root.style.setProperty("--pi-accent", ui.accent);
  document.body.style.background = ui.bg || "#1e1e2e";
}

// ---- Tab Navigation ----

const tabBar = document.getElementById("tabBar");
tabBar.addEventListener("click", (e) => {
  const btn = e.target.closest(".pi-tab");
  if (!btn) return;
  const panel = btn.dataset.panel;
  if (panel === activePanel) return;

  // Update tabs
  tabBar.querySelectorAll(".pi-tab").forEach(t => t.classList.remove("pi-tab--active"));
  btn.classList.add("pi-tab--active");

  // Update panels
  document.querySelectorAll(".pi-panel").forEach(p => p.classList.add("pi-panel--hidden"));
  const target = document.getElementById(`panel-${panel}`);
  if (target) target.classList.remove("pi-panel--hidden");

  activePanel = panel;
  savePrefs();

  // Re-render panels that need layout dimensions (hidden panels have 0x0 rects)
  if (panel === "anatomy" && anatomyData && anatomyData.length > 0) {
    requestAnimationFrame(() => {
      const container = document.getElementById("treemapContainer");
      if (container) renderTreemap(container, anatomyData);
    });
  }
});

// ---- Refresh ----

document.getElementById("refreshAll").addEventListener("click", () => {
  loadAllPanels();
});

function loadAllPanels() {
  loadAnatomy();
  loadMemory();
  loadBugs();
}

// ---- Preferences (via t64:state) ----

async function loadPrefs() {
  try {
    const prefs = await getState("pi-prefs");
    if (prefs) {
      const p = typeof prefs === "string" ? JSON.parse(prefs) : prefs;
      if (p.activePanel) {
        const tab = tabBar.querySelector(`[data-panel="${p.activePanel}"]`);
        if (tab) tab.click();
      }
      if (p.memoryFilter) {
        memoryFilter = p.memoryFilter;
        document.querySelectorAll(".pi-filter").forEach(f => {
          f.classList.toggle("pi-filter--active", f.dataset.filter === memoryFilter);
        });
      }
    }
  } catch { /* first run, no prefs */ }
}

function savePrefs() {
  setState("pi-prefs", JSON.stringify({ activePanel, memoryFilter })).catch(() => {});
}

loadPrefs();

function formatNum(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

// ============================================================
// PANEL 2: File Anatomy (Treemap)
// ============================================================

async function loadAnatomy() {
  const container = document.getElementById("treemapContainer");
  const empty = document.getElementById("anatomyEmpty");
  const summary = document.getElementById("anatomySummary");

  try {
    const raw = await readFile(`${projectCwd}/.wolf/anatomy.md`);
    anatomyData = parseAnatomyMd(raw);

    if (!anatomyData || anatomyData.length === 0) {
      container.style.display = "none";
      empty.style.display = "flex";
      return;
    }

    container.style.display = "block";
    empty.style.display = "none";

    const total = anatomyData.reduce((s, f) => s + f.tokens, 0);
    summary.textContent = `${anatomyData.length} files / ${formatNum(total)} tokens`;

    renderTreemap(container, anatomyData);
  } catch {
    container.style.display = "none";
    empty.style.display = "flex";
  }
}

/**
 * Parse anatomy.md — OpenWolf format:
 * ## src-tauri/src/
 * - `lib.rs` — Safe stderr logging (~34532 tok)
 * - `main.rs` (~51 tok)
 */
function parseAnatomyMd(raw) {
  const files = [];
  let currentDir = "";

  for (const line of raw.split("\n")) {
    // Directory header: ## src-tauri/src/
    const dirMatch = line.match(/^##\s+(.+)/);
    if (dirMatch) {
      currentDir = dirMatch[1].trim().replace(/^\.\//, "");
      continue;
    }

    // File entry: - `filename` — description (~NNN tok)
    const fileMatch = line.match(/^-\s+`([^`]+)`\s*(?:—\s*(.+?))?\s*\(~(\d+)\s*tok\)/);
    if (fileMatch) {
      const filename = fileMatch[1];
      const desc = (fileMatch[2] || "").trim();
      const tokens = parseInt(fileMatch[3], 10);
      const fullPath = currentDir ? currentDir + filename : filename;
      if (tokens > 0) files.push({ name: fullPath, tokens, desc });
    }
  }

  return files;
}

function renderTreemap(container, data) {
  container.innerHTML = "";

  const rect = container.getBoundingClientRect();
  const W = rect.width;
  const H = rect.height;
  if (W < 10 || H < 10) return;

  const total = data.reduce((s, f) => s + f.tokens, 0);
  if (total === 0) return;

  // Sort descending by tokens
  const sorted = [...data].sort((a, b) => b.tokens - a.tokens);

  // Simple squarified treemap layout
  const rects = squarify(sorted.map(d => d.tokens / total), { x: 0, y: 0, w: W, h: H });

  const colors = [
    "rgba(137,180,250,0.25)", "rgba(203,166,247,0.25)", "rgba(166,227,161,0.25)",
    "rgba(249,226,175,0.25)", "rgba(243,139,168,0.25)", "rgba(137,220,235,0.25)",
    "rgba(250,179,135,0.25)", "rgba(116,199,236,0.25)", "rgba(180,190,254,0.25)",
    "rgba(148,226,213,0.25)",
  ];

  const tooltip = document.getElementById("treemapTooltip");

  sorted.forEach((file, i) => {
    const r = rects[i];
    if (!r) return;

    const cell = document.createElement("div");
    cell.className = "pi-treemap-cell";
    cell.style.left = r.x + "px";
    cell.style.top = r.y + "px";
    cell.style.width = r.w + "px";
    cell.style.height = r.h + "px";
    cell.style.background = colors[i % colors.length];

    if (r.w > 30 && r.h > 16) {
      const label = document.createElement("span");
      label.className = "pi-treemap-label";
      label.textContent = file.name.split("/").pop();
      cell.appendChild(label);
    }

    cell.addEventListener("mouseenter", (e) => {
      tooltip.innerHTML = `
        <div class="pi-tooltip-file">${escHtml(file.name)}</div>
        <div class="pi-tooltip-tokens">${formatNum(file.tokens)} tokens</div>
        ${file.desc ? `<div class="pi-tooltip-desc">${escHtml(file.desc)}</div>` : ""}
      `;
      tooltip.style.display = "block";
    });

    cell.addEventListener("mousemove", (e) => {
      tooltip.style.left = (e.clientX + 12) + "px";
      tooltip.style.top = (e.clientY + 12) + "px";
    });

    cell.addEventListener("mouseleave", () => {
      tooltip.style.display = "none";
    });

    // Click to open file in editor
    cell.addEventListener("click", () => {
      post("t64:open-file", { path: `${projectCwd}/${file.name}` });
    });

    container.appendChild(cell);
  });
}

/**
 * Simple squarified treemap layout.
 * Takes normalized values (sum to ~1) and a bounding rect.
 */
function squarify(values, bounds) {
  const rects = [];
  layoutStrip(values, 0, values.length, bounds, rects);
  return rects;
}

function layoutStrip(values, start, end, bounds, rects) {
  if (start >= end) return;
  if (end - start === 1) {
    rects[start] = { x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h };
    return;
  }

  const total = values.slice(start, end).reduce((s, v) => s + v, 0);
  if (total <= 0) return;

  const isWide = bounds.w >= bounds.h;
  let accumulated = 0;
  let split = start;
  const half = total / 2;

  for (let i = start; i < end; i++) {
    accumulated += values[i];
    if (accumulated >= half) {
      split = i + 1;
      break;
    }
  }

  if (split === start) split = start + 1;
  if (split >= end) split = end - 1;

  const ratio = accumulated / total;

  let r1, r2;
  if (isWide) {
    const splitX = bounds.x + bounds.w * ratio;
    r1 = { x: bounds.x, y: bounds.y, w: bounds.w * ratio, h: bounds.h };
    r2 = { x: splitX, y: bounds.y, w: bounds.w * (1 - ratio), h: bounds.h };
  } else {
    const splitY = bounds.y + bounds.h * ratio;
    r1 = { x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h * ratio };
    r2 = { x: bounds.x, y: splitY, w: bounds.w, h: bounds.h * (1 - ratio) };
  }

  layoutStrip(values, start, split, r1, rects);
  layoutStrip(values, split, end, r2, rects);
}

// ============================================================
// PANEL 3: Learning Memory
// ============================================================

async function loadMemory() {
  const cards = document.getElementById("memoryCards");
  const empty = document.getElementById("memoryEmpty");

  try {
    const raw = await readFile(`${projectCwd}/.wolf/cerebrum.md`);
    memoryData = parseCerebrumMd(raw);

    if (!memoryData || memoryData.length === 0) {
      cards.style.display = "none";
      empty.style.display = "flex";
      return;
    }

    cards.style.display = "flex";
    empty.style.display = "none";
    renderMemoryCards();
  } catch {
    cards.style.display = "none";
    empty.style.display = "flex";
  }
}

/**
 * Parse cerebrum.md — expects sections like:
 *
 * ## Do-Not-Repeat
 * - Rule text here
 *   Context: why
 *
 * ## Preferences
 * - Preference text here
 */
function parseCerebrumMd(raw) {
  const entries = [];
  let currentType = "pref";

  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Section headers
    if (/^#{1,3}\s.*do.?not.?repeat/i.test(line)) {
      currentType = "dnr";
      continue;
    }
    if (/^#{1,3}\s.*\bdecision/i.test(line)) {
      currentType = "decision";
      continue;
    }
    if (/^#{1,3}\s.*(preference|user pref)/i.test(line)) {
      currentType = "pref";
      continue;
    }
    if (/^#{1,3}\s.*\blearnings?\b/i.test(line)) {
      currentType = "learning";
      continue;
    }

    // List items
    const itemMatch = line.match(/^[-*]\s+(.+)/);
    if (itemMatch) {
      const text = itemMatch[1].trim();
      let context = "";
      // Check next lines for indented context
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j];
        if (/^\s+(context|reason|why|note)\s*:/i.test(next)) {
          context = next.replace(/^\s+(context|reason|why|note)\s*:\s*/i, "").trim();
        } else if (/^[-*]\s/.test(next) || /^#{1,3}\s/.test(next)) {
          break;
        }
      }
      entries.push({ type: currentType, text, context });
    }
  }

  return entries;
}

function renderMemoryCards() {
  const cards = document.getElementById("memoryCards");
  cards.innerHTML = "";

  const filtered = memoryFilter === "all"
    ? memoryData
    : memoryData.filter(e => e.type === memoryFilter);

  if (filtered.length === 0) {
    cards.innerHTML = `<div class="pi-empty"><p>No entries match this filter.</p></div>`;
    return;
  }

  for (const entry of filtered) {
    const card = document.createElement("div");
    card.className = `pi-card pi-card--${entry.type}`;
    card.innerHTML = `
      <div class="pi-card-type">${TYPE_LABELS[entry.type] || entry.type}</div>
      <div class="pi-card-text">${renderMd(entry.text)}</div>
      ${entry.context ? `<div class="pi-card-context">${renderMd(entry.context)}</div>` : ""}
    `;
    cards.appendChild(card);
  }
}

// Memory filter buttons
document.querySelectorAll(".pi-filter").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".pi-filter").forEach(f => f.classList.remove("pi-filter--active"));
    btn.classList.add("pi-filter--active");
    memoryFilter = btn.dataset.filter;
    savePrefs();
    renderMemoryCards();
  });
});

// ============================================================
// PANEL 4: Bug Log
// ============================================================

async function loadBugs() {
  const body = document.getElementById("bugBody");
  const empty = document.getElementById("bugEmpty");
  const tableWrap = document.querySelector(".pi-table-wrap");

  try {
    const raw = await readFile(`${projectCwd}/.wolf/buglog.json`);
    bugData = JSON.parse(raw);

    if (!bugData || !Array.isArray(bugData.bugs) || bugData.bugs.length === 0) {
      tableWrap.style.display = "none";
      empty.style.display = "flex";
      return;
    }

    tableWrap.style.display = "block";
    empty.style.display = "none";
    renderBugTable();
  } catch {
    tableWrap.style.display = "none";
    empty.style.display = "flex";
  }
}

function renderBugTable(filter = "") {
  const body = document.getElementById("bugBody");
  body.innerHTML = "";

  let bugs = bugData.bugs || [];
  if (filter) {
    const q = filter.toLowerCase();
    bugs = bugs.filter(b =>
      (b.title || "").toLowerCase().includes(q) ||
      (b.file || "").toLowerCase().includes(q) ||
      (b.description || "").toLowerCase().includes(q)
    );
  }

  // Sort by last_seen descending
  bugs.sort((a, b) => {
    const da = new Date(b.last_seen || b.timestamp || 0).getTime();
    const db = new Date(a.last_seen || a.timestamp || 0).getTime();
    return da - db;
  });

  for (const bug of bugs) {
    const tr = document.createElement("tr");
    const status = bug.status || (bug.fix_count > 0 ? "fixed" : "open");
    const statusClass = status === "fixed" ? "fixed" : (bug.fix_count > 1 ? "recurring" : "open");

    tr.innerHTML = `
      <td title="${escHtml(bug.description || "")}">${escHtml(bug.title || "Unknown bug")}</td>
      <td><code>${escHtml((bug.file || "").split("/").pop() || "—")}</code></td>
      <td>${bug.fix_count || 0}</td>
      <td>${formatDate(bug.last_seen || bug.timestamp)}</td>
      <td><span class="pi-status pi-status--${statusClass}">${status}</span></td>
    `;
    body.appendChild(tr);
  }

  if (bugs.length === 0) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="5" style="text-align:center;color:var(--pi-fg-muted);padding:20px">No bugs match "${escHtml(filter)}"</td>`;
    body.appendChild(tr);
  }
}

// Bug search
const bugSearch = document.getElementById("bugSearch");
let bugSearchTimer;
bugSearch.addEventListener("input", () => {
  clearTimeout(bugSearchTimer);
  bugSearchTimer = setTimeout(() => {
    if (bugData) renderBugTable(bugSearch.value);
  }, 200);
});

// ============================================================
// PANEL 5: Semantic Search
// ============================================================

const semanticInput = document.getElementById("semanticInput");
const semanticGo = document.getElementById("semanticGo");
const searchResults = document.getElementById("searchResults");
const searchEmpty = document.getElementById("searchEmpty");

semanticGo.addEventListener("click", doSemanticSearch);
semanticInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") doSemanticSearch();
});

async function doSemanticSearch() {
  const query = semanticInput.value.trim();
  if (!query) return;

  searchResults.innerHTML = `<div class="pi-loading"><div class="pi-spinner"></div>Searching...</div>`;
  searchEmpty.style.display = "none";

  try {
    // Try vector_search via shell exec (if sqlite-vec backend is available)
    const result = await execCommand(
      `echo '{"query":"${query.replace(/"/g, '\\"')}","limit":20}' | timeout 5 cat`,
      projectCwd
    ).catch(() => null);

    // Fallback: use file search
    let results = [];
    try {
      const fileResults = await searchFiles(projectCwd, query);
      if (Array.isArray(fileResults)) {
        results = fileResults.map(r => ({
          type: "file",
          title: typeof r === "string" ? r.split("/").pop() : (r.path || r.file || "").split("/").pop(),
          path: typeof r === "string" ? r : (r.path || r.file || ""),
          snippet: typeof r === "object" ? (r.line || r.match || r.snippet || "") : "",
          score: typeof r === "object" ? (r.score || 0.5) : 0.5,
        }));
      }
    } catch { /* no results */ }

    if (results.length === 0) {
      searchResults.innerHTML = "";
      searchEmpty.style.display = "flex";
      searchEmpty.querySelector("p").textContent = `No results for "${query}"`;
      return;
    }

    searchResults.innerHTML = "";
    searchEmpty.style.display = "none";

    for (const r of results.slice(0, 20)) {
      const card = document.createElement("div");
      card.className = "pi-result";

      const typeClass = r.type === "session" ? "session" : r.type === "skill" ? "skill" : "file";
      card.innerHTML = `
        <div class="pi-result-header">
          <span class="pi-result-type pi-result-type--${typeClass}">${r.type}</span>
          <span class="pi-result-title">${escHtml(r.title || r.path || "Untitled")}</span>
          ${r.score ? `<span class="pi-result-score">${(r.score * 100).toFixed(0)}%</span>` : ""}
        </div>
        ${r.snippet ? `<div class="pi-result-snippet">${escHtml(r.snippet).slice(0, 200)}</div>` : ""}
      `;

      card.addEventListener("click", () => {
        if (r.path) post("t64:open-file", { path: r.path.startsWith("/") ? r.path : `${projectCwd}/${r.path}` });
      });

      searchResults.appendChild(card);
    }
  } catch (err) {
    searchResults.innerHTML = `<div class="pi-empty"><p>Search failed: ${escHtml(err.message)}</p></div>`;
  }
}

// ============================================================
// Utilities
// ============================================================

function renderMd(str) {
  if (!str) return "";
  return escHtml(str)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

function escHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatDate(dateStr) {
  if (!dateStr) return "—";
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    const now = new Date();
    const diff = now.getTime() - d.getTime();
    if (diff < 60_000) return "just now";
    if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
    if (diff < 604800_000) return `${Math.floor(diff / 86400_000)}d ago`;
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  } catch {
    return dateStr;
  }
}

// Handle resize for token chart redraw
let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (activePanel === "anatomy" && anatomyData) {
      const container = document.getElementById("treemapContainer");
      renderTreemap(container, anatomyData);
    }
  }, 150);
});
