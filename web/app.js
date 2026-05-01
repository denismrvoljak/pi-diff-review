const reviewData = JSON.parse(document.getElementById("diff-review-data").textContent || "{}");
const snapshotItems = reviewData.snapshot?.items || [];
const NON_TOP_FILE_SCROLL_PADDING = 16;
const LARGE_FILE_BYTE_LIMIT = 200 * 1024;
const LARGE_FILE_LINE_LIMIT = 3000;
const THEME_STORAGE_KEY = "pi.diffReview.theme";
const HIDE_GENERATED_STORAGE_KEY = "pi.diffReview.hideGenerated";
const SIDEBAR_STORAGE_KEY = "pi.diffReview.sidebar";
const REVIEW_THEMES = {
  dark: { label: "dark", monacoTheme: "review-dark" },
  light: { label: "light", monacoTheme: "review-light" },
};

function readInitialTheme() {
  try {
    const storedTheme = window.localStorage?.getItem(THEME_STORAGE_KEY);
    if (storedTheme === "light" || storedTheme === "dark") return storedTheme;
  } catch {}
  return "dark";
}

function readInitialHideGenerated() {
  try {
    return window.localStorage?.getItem(HIDE_GENERATED_STORAGE_KEY) === "true";
  } catch {}
  return false;
}

function readInitialSidebarVisible() {
  try {
    const stored = window.localStorage?.getItem(SIDEBAR_STORAGE_KEY);
    if (stored === "true") return true;
    if (stored === "false") return false;
  } catch {}
  return true;
}

const initialHideGenerated = readInitialHideGenerated();
const initialSidebarVisible = readInitialSidebarVisible();

function itemVisibleFiles(item, hideGenerated = state.hideGenerated) {
  if (!item) return [];
  if (!hideGenerated) return item.files;
  return item.files.filter((file) => file.isGenerated !== true);
}

function firstItemWithFiles(hideGenerated = initialHideGenerated) {
  return snapshotItems.find((item) => itemVisibleFiles(item, hideGenerated).length > 0) || null;
}

function firstWorkingTreeItemWithFiles(hideGenerated = initialHideGenerated) {
  return (
    snapshotItems.find(
      (item) => item.kind === "working-tree" && itemVisibleFiles(item, hideGenerated).length > 0,
    ) || null
  );
}

function firstCommitItemWithFiles(hideGenerated = initialHideGenerated) {
  return (
    snapshotItems.find(
      (item) => item.kind === "commit" && itemVisibleFiles(item, hideGenerated).length > 0,
    ) || null
  );
}

const initialItem =
  firstWorkingTreeItemWithFiles() || firstCommitItemWithFiles() || firstItemWithFiles();

const state = {
  activeItemId: initialItem?.id || null,
  activeFileId: initialItem?.files[0]?.id || null,
  comments: [],
  itemNotes: {},
  fileNotes: {},
  overallComment: "",
  reviewedItems: {},
  reviewedFiles: {},
  fullFiles: {},
  collapsedFiles: {},
  collapsedDirs: {},
  collapsedItems: Object.fromEntries(
    snapshotItems.map((item) => [item.id, item.kind === "aggregate"]),
  ),
  fileFilter: "",
  hideGenerated: initialHideGenerated,
  sidebarVisible: initialSidebarVisible,
  wrapLines: false,
  theme: readInitialTheme(),
  pendingScrollFileId: null,
  fileContents: {},
  fileErrors: {},
  pendingRequestIds: {},
  overallCommentEditing: false,
  largeFileLoads: {},
  renderedItemId: null,
};

const sidebarTitleEl = document.getElementById("sidebar-title");
const sidebarSearchInputEl = document.getElementById("sidebar-search-input");
const expandAllCommitsButton = document.getElementById("expand-all-commits-button");
const collapseAllCommitsButton = document.getElementById("collapse-all-commits-button");
const windowTitleEl = document.getElementById("window-title");
const repoRootEl = document.getElementById("repo-root");
const branchSummaryEl = document.getElementById("branch-summary");
const fileTreeEl = document.getElementById("file-tree");
const summaryEl = document.getElementById("summary");
const currentFileLabelEl = document.getElementById("current-file-label");
const currentItemStatsEl = document.getElementById("current-item-stats");
const currentItemDescriptionEl = document.getElementById("current-item-description");
const modeHintEl = document.getElementById("mode-hint");
const fileCommentsContainer = document.getElementById("file-comments-container");
const editorContainerEl = document.getElementById("editor-container");
const submitButton = document.getElementById("submit-button");
const cancelButton = document.getElementById("cancel-button");
const overallCommentButton = document.getElementById("overall-comment-button");
const fileCommentButton = document.getElementById("file-comment-button");
const commitCommentButton = document.getElementById("commit-comment-button");
const toggleReviewedButton = document.getElementById("toggle-reviewed-button");
const toggleGeneratedButton = document.getElementById("toggle-generated-button");
const toggleWrapButton = document.getElementById("toggle-wrap-button");
const toggleThemeButton = document.getElementById("toggle-theme-button");
const toggleSidebarButton = document.getElementById("toggle-sidebar-button");
const sidebarEl = document.getElementById("sidebar");

repoRootEl.textContent = reviewData.repoRoot || "";
windowTitleEl.textContent = reviewData.repoLabel ? `Review · ${reviewData.repoLabel}` : "Review";
branchSummaryEl.textContent = reviewData.branchName || "";
sidebarTitleEl.textContent = "";

let monacoApi = null;
let requestSequence = 0;
let pendingScrollFrame = null;
const editorRecords = new Map();

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;");
}

function updateGeneratedButton() {
  const count = generatedFileCount();
  toggleGeneratedButton.classList.toggle("hidden", count === 0);
  toggleGeneratedButton.disabled = count === 0;
  if (count === 0) {
    toggleGeneratedButton.textContent = "";
    toggleGeneratedButton.setAttribute("aria-label", "No generated or vendored files");
    return;
  }

  toggleGeneratedButton.textContent = state.hideGenerated
    ? `Generated/vendor: hidden (${count})`
    : `Generated/vendor: shown (${count})`;
  toggleGeneratedButton.setAttribute(
    "aria-label",
    state.hideGenerated ? "Show generated and vendored files" : "Hide generated and vendored files",
  );
}

function updateThemeButton() {
  const theme = REVIEW_THEMES[state.theme] || REVIEW_THEMES.dark;
  toggleThemeButton.textContent = `Theme: ${theme.label}`;
  toggleThemeButton.setAttribute(
    "aria-label",
    `Switch to ${state.theme === "dark" ? "light" : "dark"} theme`,
  );
}

function applyTheme() {
  if (!REVIEW_THEMES[state.theme]) state.theme = "dark";
  document.documentElement.dataset.reviewTheme = state.theme;
  try {
    window.localStorage?.setItem(THEME_STORAGE_KEY, state.theme);
  } catch {}
  if (monacoApi != null) {
    monacoApi.editor.setTheme(REVIEW_THEMES[state.theme].monacoTheme);
  }
  updateThemeButton();
}

function updateSidebarButton() {
  if (!toggleSidebarButton) return;
  toggleSidebarButton.textContent = `Sidebar: ${state.sidebarVisible ? "on" : "off"}`;
  toggleSidebarButton.setAttribute(
    "aria-label",
    state.sidebarVisible ? "Hide sidebar" : "Show sidebar",
  );
}

function applySidebarVisibility() {
  if (!(sidebarEl instanceof HTMLElement)) return;
  sidebarEl.classList.toggle("hidden", !state.sidebarVisible);
  updateSidebarButton();
}

function inferLanguage(path) {
  if (!path) return "plaintext";
  const lower = path.toLowerCase();
  if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "typescript";
  if (
    lower.endsWith(".js") ||
    lower.endsWith(".jsx") ||
    lower.endsWith(".mjs") ||
    lower.endsWith(".cjs")
  )
    return "javascript";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".md")) return "markdown";
  if (lower.endsWith(".css")) return "css";
  if (lower.endsWith(".html")) return "html";
  if (lower.endsWith(".sh")) return "shell";
  if (lower.endsWith(".yml") || lower.endsWith(".yaml")) return "yaml";
  if (lower.endsWith(".rs")) return "rust";
  if (lower.endsWith(".java")) return "java";
  if (lower.endsWith(".kt")) return "kotlin";
  if (lower.endsWith(".py")) return "python";
  if (lower.endsWith(".go")) return "go";
  return "plaintext";
}

function normalizeQuery(query) {
  return String(query || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

function scoreSubsequence(query, candidate) {
  if (!query) return 0;
  let queryIndex = 0;
  let score = 0;
  let firstMatchIndex = -1;
  let previousMatchIndex = -2;

  for (let i = 0; i < candidate.length && queryIndex < query.length; i += 1) {
    if (candidate[i] !== query[queryIndex]) continue;
    if (firstMatchIndex === -1) firstMatchIndex = i;
    score += 10;
    if (i === previousMatchIndex + 1) score += 8;

    const previousChar = i > 0 ? candidate[i - 1] : "";
    if (
      i === 0 ||
      previousChar === "/" ||
      previousChar === "_" ||
      previousChar === "-" ||
      previousChar === "."
    ) {
      score += 12;
    }

    previousMatchIndex = i;
    queryIndex += 1;
  }

  if (queryIndex !== query.length) return -1;
  if (firstMatchIndex >= 0) score += Math.max(0, 20 - firstMatchIndex);
  return score;
}

function itemLabel(item) {
  return item.kind === "working-tree" ? "Working tree" : item.title;
}

function isAggregateItem(item) {
  return item?.kind === "aggregate";
}

function formatCount(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function formatFileCount(count) {
  return formatCount(count, "file");
}

function generatedFileCount() {
  const paths = new Set();
  for (const item of snapshotItems) {
    for (const file of item.files) {
      if (file.isGenerated === true) paths.add(file.path);
    }
  }
  return paths.size;
}

function itemDescription(item) {
  if (!item) return "";
  if (item.kind === "aggregate") {
    return item.subtitle || `${formatFileCount(item.files.length)} in the combined stack diff`;
  }
  if (item.kind === "working-tree") {
    return item.subtitle || formatFileCount(item.files.length);
  }
  return "";
}

function itemHint(item) {
  if (!item) return "";
  if (item.kind === "aggregate") {
    return `${formatFileCount(item.files.length)} · Combined diff across the frozen review snapshot.`;
  }
  if (item.kind === "working-tree") {
    return `${formatFileCount(item.files.length)} · Uncommitted changes captured when this review opened.`;
  }

  const parts = [
    item.shortSha || item.commitSha?.slice(0, 7) || "",
    formatFileCount(item.files.length),
  ].filter(Boolean);
  if (item.authoredAt) parts.push(formatAuthoredDate(item.authoredAt));
  if (item.authorName) parts.push(item.authorName);
  if ((item.coAuthors || []).length > 0) {
    parts.push(`Co-authored by ${item.coAuthors.join(", ")}`);
  }
  return parts.join(" · ");
}

function formatAuthoredDate(value) {
  if (!value) return "";
  return String(value).slice(0, 10);
}

function statusLabel(status) {
  if (!status) return "";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function getAddedLines(target) {
  if (!target) return null;
  if (typeof target.addedLines === "number") return target.addedLines;
  return target.lineStats?.addedLines ?? null;
}

function getDeletedLines(target) {
  if (!target) return null;
  if (typeof target.deletedLines === "number") return target.deletedLines;
  return target.lineStats?.deletedLines ?? null;
}

function getOriginalLineCount(target) {
  if (!target) return null;
  if (typeof target.originalLineCount === "number") return target.originalLineCount;
  return target.lineStats?.originalLineCount ?? null;
}

function getModifiedLineCount(target) {
  if (!target) return null;
  if (typeof target.modifiedLineCount === "number") return target.modifiedLineCount;
  return target.lineStats?.modifiedLineCount ?? null;
}

function getOriginalByteCount(target) {
  if (!target) return null;
  return target.lineStats?.originalByteCount ?? null;
}

function getModifiedByteCount(target) {
  if (!target) return null;
  return target.lineStats?.modifiedByteCount ?? null;
}

function getLargestByteCount(target) {
  return Math.max(0, getOriginalByteCount(target) || 0, getModifiedByteCount(target) || 0);
}

function getLargestLineCount(target) {
  return Math.max(0, getOriginalLineCount(target) || 0, getModifiedLineCount(target) || 0);
}

function formatBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024) return `${bytes}b`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}kb`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}mb`;
}

function isLargeFile(target) {
  return (
    getLargestByteCount(target) >= LARGE_FILE_BYTE_LIMIT ||
    getLargestLineCount(target) >= LARGE_FILE_LINE_LIMIT
  );
}

function largeFileReason(target) {
  const parts = [];
  const byteCount = getLargestByteCount(target);
  const lineCount = getLargestLineCount(target);
  if (lineCount > 0) {
    parts.push(`${lineCount.toLocaleString()} lines`);
  }
  if (byteCount > 0) {
    parts.push(formatBytes(byteCount));
  }
  return `Diff is hidden by default due to its size (${parts.join(", ")}).`;
}

function shouldDeferLargeFile(file) {
  return isLargeFile(file) && state.largeFileLoads[file.id] !== true;
}

function diffStatSegments(target) {
  const added = Math.max(0, getAddedLines(target) || 0);
  const deleted = Math.max(0, getDeletedLines(target) || 0);
  const originalLineCount = getOriginalLineCount(target);
  const modifiedLineCount = getModifiedLineCount(target);

  if (originalLineCount == null || modifiedLineCount == null) {
    const totalChanged = added + deleted;
    if (totalChanged <= 0) {
      return { green: 0, red: 0, gray: 100 };
    }
    return {
      green: (100 * added) / totalChanged,
      red: (100 * deleted) / totalChanged,
      gray: 0,
    };
  }

  const unchanged = Math.max(0, Math.min(originalLineCount - deleted, modifiedLineCount - added));
  const total = added + deleted + unchanged;

  if (total <= 0) {
    return { green: 0, red: 0, gray: 100 };
  }

  return {
    green: (100 * added) / total,
    red: (100 * deleted) / total,
    gray: Math.max(0, (100 * unchanged) / total),
  };
}

function caricatureDiffSegments(segments, compact) {
  const minSegmentPct = compact ? 8 : 7;
  let green = segments.green;
  let red = segments.red;
  let gray = segments.gray;

  if (green > 0 && green < minSegmentPct) {
    const needed = minSegmentPct - green;
    green = minSegmentPct;
    if (gray >= needed) {
      gray -= needed;
    } else if (red >= needed - gray) {
      red -= needed - gray;
      gray = 0;
    }
  }

  if (red > 0 && red < minSegmentPct) {
    const needed = minSegmentPct - red;
    red = minSegmentPct;
    if (gray >= needed) {
      gray -= needed;
    } else if (green >= needed - gray) {
      green -= needed - gray;
      gray = 0;
    }
  }

  const total = green + red + gray;
  if (total <= 0) {
    return { green: 0, red: 0, gray: 100 };
  }

  return {
    green: (100 * green) / total,
    red: (100 * red) / total,
    gray: Math.max(0, (100 * gray) / total),
  };
}

function renderDiffStat(target, status = null, options = {}) {
  const addedLines = getAddedLines(target);
  const deletedLines = getDeletedLines(target);
  if (addedLines == null || deletedLines == null) {
    return status
      ? `<span class="text-[10px] font-medium text-review-muted">${escapeHtml(statusLabel(status))}</span>`
      : "";
  }

  const compact = options.compact === true;
  const segments = caricatureDiffSegments(diffStatSegments(target), compact);
  const countClass = compact ? "text-[10px]" : "text-xs";
  const barClass = compact ? "h-2 w-10" : "h-2.5 w-12";

  return `
    <span class="inline-flex min-w-0 items-center gap-1.5 whitespace-nowrap ${countClass}">
      <span class="font-semibold text-[#3fb950]">+${addedLines}</span>
      <span class="font-semibold text-[#f85149]">-${deletedLines}</span>
      <span class="flex overflow-hidden rounded-sm bg-[#6e7681]/35 ${barClass}">
        <span class="h-full bg-[#3fb950]" style="width:${segments.green}%"></span>
        <span class="h-full bg-[#f85149]" style="width:${segments.red}%"></span>
        <span class="h-full bg-[#6e7681]/35" style="width:${segments.gray}%"></span>
      </span>
    </span>
  `;
}

function renderChevronIcon(collapsed, sizeClass = "h-4 w-4") {
  return `
    <svg class="${sizeClass} shrink-0 text-review-muted transition-transform ${collapsed ? "-rotate-90" : ""}" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M12.78 6.22a.749.749 0 0 1 0 1.06l-4.25 4.25a.749.749 0 0 1-1.06 0L3.22 7.28a.749.749 0 0 1 1.06-1.06L8 9.939l3.72-3.719a.749.749 0 0 1 1.06 0Z"></path>
    </svg>
  `;
}

function renderReviewedCheck(reviewed) {
  if (!reviewed) return "";
  return '<span class="flex h-4 min-w-[16px] items-center justify-center text-[11px] font-semibold text-[#3fb950]">✓</span>';
}

function renderCheckPlaceholder() {
  return '<span class="flex h-4 min-w-[16px] items-center justify-center text-[11px] font-semibold text-transparent">✓</span>';
}

function renderCommentCount(count) {
  if (!count || count <= 0) return "";
  return `
    <span class="flex shrink-0 items-center gap-1 text-[10px] font-medium text-review-text">
      <svg class="h-3.5 w-3.5 text-review-muted" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M3.5 3.25h9A1.25 1.25 0 0 1 13.75 4.5v5A1.25 1.25 0 0 1 12.5 10.75H8.39l-2.62 2.29a.75.75 0 0 1-1.24-.56v-1.73H3.5A1.25 1.25 0 0 1 2.25 9.5v-5A1.25 1.25 0 0 1 3.5 3.25Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"></path>
      </svg>
      <span>${count}</span>
    </span>
  `;
}

function renderSidebarIndicators({ reviewed = false, commentCount = 0, placeholder = true } = {}) {
  const comment = renderCommentCount(commentCount);
  const check = reviewed ? renderReviewedCheck(true) : placeholder ? renderCheckPlaceholder() : "";
  if (!comment && !check) return "";
  return `<span class="flex shrink-0 items-center gap-1.5">${check}${comment}</span>`;
}

function activeItem() {
  return snapshotItems.find((item) => item.id === state.activeItemId) || null;
}

function activeFile() {
  const item = activeItem();
  if (!item) return null;
  const visibleFiles = itemVisibleFiles(item);
  return visibleFiles.find((file) => file.id === state.activeFileId) || visibleFiles[0] || null;
}

function ensureActiveSelection() {
  const item = activeItem();
  if (item == null || itemVisibleFiles(item).length === 0) {
    const fallback = firstItemWithFiles(state.hideGenerated);
    const fallbackFiles = itemVisibleFiles(fallback);
    state.activeItemId = fallback?.id || null;
    state.activeFileId = fallbackFiles[0]?.id || null;
    return;
  }
  const visibleFiles = itemVisibleFiles(item);
  if (visibleFiles.some((file) => file.id === state.activeFileId)) return;
  state.activeFileId = visibleFiles[0]?.id || null;
}

function getDisplayPath(file) {
  return file?.comparison?.displayPath || file?.path || "";
}

function getFilePath(file) {
  const comparison = file?.comparison;
  return comparison?.newPath || comparison?.oldPath || file?.path || "";
}

function reviewFileKey(file, item = activeItem()) {
  return `${item?.id || "unknown"}::${file?.path || ""}`;
}

function fileNoteKey(file = activeFile(), item = activeItem()) {
  return `${item?.id || "unknown"}::${file?.path || ""}`;
}

function itemReviewKey(item = activeItem()) {
  return item?.id || "unknown";
}

function areAllItemFilesReviewed(item = activeItem()) {
  const visibleFiles = itemVisibleFiles(item);
  if (!item || visibleFiles.length === 0) return false;
  return visibleFiles.every((file) => isFileReviewed(file, item));
}

function isItemExplicitlyReviewed(item = activeItem()) {
  return state.reviewedItems[itemReviewKey(item)] === true;
}

function isItemReviewed(item = activeItem()) {
  if (isAggregateItem(item)) return false;
  return isItemExplicitlyReviewed(item) || areAllItemFilesReviewed(item);
}

function isFileReviewed(file, item = activeItem()) {
  return state.reviewedFiles[reviewFileKey(file, item)] === true;
}

function fullFileKey(file, item = activeItem()) {
  return reviewFileKey(file, item);
}

function isShowingFullFile(file, item = activeItem()) {
  return state.fullFiles[fullFileKey(file, item)] === true;
}

function collapsedFileKey(file, item = activeItem()) {
  return reviewFileKey(file, item);
}

function isFileCollapsed(file, item = activeItem()) {
  return state.collapsedFiles[collapsedFileKey(file, item)] === true;
}

function collapsedDirKey(item, path) {
  return `${item?.id || "unknown"}::${path || ""}`;
}

function isDirCollapsed(item, path) {
  return state.collapsedDirs[collapsedDirKey(item, path)] === true;
}

function commentMatchesFile(comment, file, item = activeItem()) {
  if (!file || !item) return false;
  return comment.itemId === item.id && comment.filePath === file.path;
}

function itemInlineComments(item, file) {
  return state.comments.filter((comment) => commentMatchesFile(comment, file, item));
}

function currentItemNote(item = activeItem()) {
  if (!item || isAggregateItem(item)) return null;
  return state.itemNotes[item.id] || null;
}

function currentFileNote(item = activeItem(), file = activeFile()) {
  if (!item || isAggregateItem(item) || !file) return null;
  return state.fileNotes[fileNoteKey(file, item)] || null;
}

function canCreateItemScopedFeedback(file = activeFile(), item = activeItem()) {
  return file != null && item != null;
}

function getFileSearchScore(query, file) {
  const normalizedQuery = normalizeQuery(query);
  if (!normalizedQuery) return 0;
  const path = (file?.path || "").toLowerCase();
  const baseName = path.split("/").pop() || path;
  const pathScore = scoreSubsequence(normalizedQuery, path);
  const baseScore = scoreSubsequence(normalizedQuery, baseName);
  let score = Math.max(pathScore, baseScore >= 0 ? baseScore + 40 : -1);
  if (score < 0) return -1;
  if (baseName === normalizedQuery) score += 200;
  else if (baseName.startsWith(normalizedQuery)) score += 120;
  else if (path.includes(normalizedQuery)) score += 35;
  return score;
}

function buildSidebarFileTree(files) {
  const root = { path: "", directories: new Map(), files: [] };

  for (const file of files) {
    const parts = file.path.split("/").filter(Boolean);
    let node = root;
    let currentPath = "";

    for (const part of parts.slice(0, -1)) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      if (!node.directories.has(part)) {
        node.directories.set(part, {
          name: part,
          path: currentPath,
          directories: new Map(),
          files: [],
        });
      }
      node = node.directories.get(part);
    }

    node.files.push(file);
  }

  return root;
}

function collectDirectoryFiles(directory) {
  const files = [...directory.files];
  for (const childDirectory of directory.directories.values()) {
    files.push(...collectDirectoryFiles(childDirectory));
  }
  return files;
}

function directoryCommentCount(directory, item) {
  return collectDirectoryFiles(directory).reduce(
    (count, file) => count + itemInlineComments(item, file).length,
    0,
  );
}

function renderSidebarFileLeaf(container, item, file, depth) {
  const requestState = getRequestState(file.id);
  const loading = requestState.requestId != null && requestState.contents == null;
  const errored = requestState.error != null;
  const reviewed = isFileReviewed(file, item);
  const commentCount = itemInlineComments(item, file).length;
  const status = file.comparison?.status || null;
  const baseName = file.path.split("/").pop() || file.path;
  const indentPx = 8;
  const basePaddingPx = 6;

  const fileRow = document.createElement("button");
  fileRow.type = "button";
  fileRow.className = [
    "mt-1 flex w-full min-w-0 items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left",
    reviewed
      ? "text-review-text hover:bg-review-hover"
      : "text-review-muted hover:bg-review-hover hover:text-review-text",
  ].join(" ");
  fileRow.style.paddingLeft = `${basePaddingPx + depth * indentPx}px`;
  fileRow.innerHTML = `
    <span class="min-w-0 flex flex-1 items-center gap-1.5 overflow-hidden">
      <span class="truncate text-[13px]">${escapeHtml(baseName)}</span>
      ${errored ? '<span class="flex h-4 min-w-[16px] items-center justify-center text-[10px] text-red-400">!</span>' : loading ? '<span class="flex h-4 min-w-[16px] items-center justify-center text-[10px] text-[#58a6ff]">…</span>' : renderSidebarIndicators({ reviewed, commentCount })}
    </span>
    <span class="flex shrink-0 items-center gap-1.5 overflow-hidden">
      ${renderDiffStat(file, status, { compact: true })}
    </span>
  `;
  fileRow.addEventListener("click", () => openFile(file.id, item.id, true));
  container.appendChild(fileRow);
}

function renderSidebarDirectoryNode(container, item, directory, depth) {
  const indentPx = 8;
  const basePaddingPx = 6;
  const collapsed = isDirCollapsed(item, directory.path);
  const descendantFiles = collectDirectoryFiles(directory);
  const allReviewed =
    descendantFiles.length > 0 && descendantFiles.every((file) => isFileReviewed(file, item));
  const commentCount = directoryCommentCount(directory, item);

  const directoryRow = document.createElement("button");
  directoryRow.type = "button";
  directoryRow.className =
    "mt-1 flex w-full min-w-0 items-center justify-between gap-2 rounded-md px-2 py-1 text-left text-[13px] text-review-muted hover:bg-review-hover";
  directoryRow.style.paddingLeft = `${basePaddingPx + depth * indentPx}px`;
  directoryRow.innerHTML = `
    <span class="min-w-0 flex flex-1 items-center gap-1.5 overflow-hidden">
      ${renderChevronIcon(collapsed)}
      <span class="truncate">${escapeHtml(directory.name)}</span>
      ${collapsed ? renderSidebarIndicators({ reviewed: allReviewed, commentCount, placeholder: false }) : ""}
    </span>
  `;
  directoryRow.addEventListener("click", () => {
    const key = collapsedDirKey(item, directory.path);
    state.collapsedDirs[key] = !collapsed;
    renderSidebar();
  });
  container.appendChild(directoryRow);

  if (collapsed) return;

  const childDirectories = [...directory.directories.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const childDirectory of childDirectories) {
    renderSidebarDirectoryNode(container, item, childDirectory, depth + 1);
  }

  const childFiles = [...directory.files].sort((a, b) => a.path.localeCompare(b.path));
  for (const file of childFiles) {
    renderSidebarFileLeaf(container, item, file, depth + 1);
  }
}

function renderSidebarFileTree(container, item, files) {
  const tree = buildSidebarFileTree(files);
  const directories = [...tree.directories.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const directory of directories) {
    renderSidebarDirectoryNode(container, item, directory, 1);
  }

  const rootFiles = [...tree.files].sort((a, b) => a.path.localeCompare(b.path));
  for (const file of rootFiles) {
    renderSidebarFileLeaf(container, item, file, 1);
  }
}

function getFilteredItems() {
  const query = state.fileFilter.trim();
  if (!query) {
    return snapshotItems
      .map((item) => ({ item, files: itemVisibleFiles(item), score: 0 }))
      .filter((entry) => entry.files.length > 0);
  }

  const normalizedQuery = normalizeQuery(query);
  return snapshotItems
    .map((item) => {
      const itemScore = scoreSubsequence(normalizedQuery, itemLabel(item).toLowerCase());
      const files = itemVisibleFiles(item)
        .map((file) => ({ file, score: getFileSearchScore(query, file) }))
        .filter((entry) => entry.score >= 0)
        .sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path))
        .map((entry) => entry.file);
      const score = Math.max(itemScore, files.length > 0 ? 1 : -1);
      return { item, files, score };
    })
    .filter((entry) => entry.score >= 0 && entry.files.length > 0)
    .sort((a, b) => b.score - a.score || itemLabel(a.item).localeCompare(itemLabel(b.item)));
}

function getRequestState(fileId) {
  return {
    contents: state.fileContents[fileId],
    error: state.fileErrors[fileId],
    requestId: state.pendingRequestIds[fileId],
  };
}

function ensureFileLoaded(fileId) {
  if (!fileId) return;
  const requestState = getRequestState(fileId);
  if (
    requestState.contents != null ||
    requestState.error != null ||
    requestState.requestId != null
  ) {
    return;
  }

  const requestId = `request:${Date.now()}:${++requestSequence}`;
  state.pendingRequestIds[fileId] = requestId;
  if (window.glimpse?.send) {
    window.glimpse.send({ type: "request-file", requestId, fileId });
  }
}

function ensureVisibleFileLoaded(item, file) {
  if (!file) return;
  if (shouldDeferLargeFile(file)) return;
  ensureFileLoaded(file.id);
}

function openItem(itemId) {
  if (state.activeItemId === itemId) {
    const item = activeItem();
    const visibleFiles = itemVisibleFiles(item);
    if (visibleFiles[0]) ensureVisibleFileLoaded(item, visibleFiles[0]);
    renderSidebar();
    return;
  }

  state.activeItemId = itemId;
  ensureActiveSelection();
  renderSidebar();
  renderHeader();
  renderItemNoteArea();
  renderDocument();
}

function openFile(fileId, itemId = state.activeItemId, scrollIntoView = true) {
  const previousItemId = state.activeItemId;
  const item = snapshotItems.find((entry) => entry.id === itemId) || null;

  state.activeItemId = itemId;
  state.activeFileId = fileId;
  state.pendingScrollFileId = scrollIntoView ? fileId : null;
  const file = item?.files.find((entry) => entry.id === fileId) || null;
  ensureVisibleFileLoaded(item, file);
  renderSidebar();
  renderHeader();
  renderItemNoteArea();

  if (previousItemId === itemId && state.renderedItemId === itemId) {
    updateToolbarButtons();
    schedulePendingScroll();
    return;
  }

  renderDocument();
}

function disposeEditors() {
  for (const record of editorRecords.values()) {
    try {
      for (const disposable of record.disposables || []) {
        disposable?.dispose?.();
      }
      record.originalModel?.dispose();
      record.modifiedModel?.dispose();
      record.diffEditor?.dispose?.();
    } catch {}
  }
  editorRecords.clear();
}

function disposeEditorRecord(fileId) {
  const record = editorRecords.get(fileId);
  if (!record) return;
  try {
    for (const disposable of record.disposables || []) {
      disposable?.dispose?.();
    }
    record.originalModel?.dispose();
    record.modifiedModel?.dispose();
    record.diffEditor?.dispose?.();
  } catch {}
  editorRecords.delete(fileId);
}

function editorContentHeight(editor) {
  const contentHeight = editor?.getContentHeight?.() || 0;
  const scrollHeight = editor?.getScrollHeight?.() || 0;

  if (scrollHeight > contentHeight && scrollHeight - contentHeight <= 12) {
    return scrollHeight;
  }

  return contentHeight;
}

function renderSidebar() {
  ensureActiveSelection();
  fileTreeEl.innerHTML = "";
  const itemEntries = getFilteredItems();
  const orderedItemEntries = [...itemEntries].sort((a, b) => {
    if (isAggregateItem(a.item) === isAggregateItem(b.item)) return 0;
    return isAggregateItem(a.item) ? 1 : -1;
  });

  if (orderedItemEntries.length === 0) {
    const message = state.fileFilter.trim()
      ? `No items match <span class="text-review-text">${escapeHtml(state.fileFilter.trim())}</span>.`
      : state.hideGenerated && generatedFileCount() > 0
        ? "No visible review items. Generated files are hidden."
        : "No review items.";
    fileTreeEl.innerHTML = `<div class="px-3 py-4 text-sm text-review-muted">${message}</div>`;
  } else {
    for (const { item, files } of orderedItemEntries) {
      const note = currentItemNote(item);
      const feedbackCount =
        state.comments.filter((comment) => comment.itemId === item.id).length +
        Object.values(state.fileNotes).filter(
          (fileNote) => fileNote?.itemId === item.id && fileNote?.body?.trim(),
        ).length +
        (note?.body?.trim() ? 1 : 0);
      const itemReviewed = isItemReviewed(item);
      const collapsed = state.collapsedItems[item.id] === true;
      const aggregate = isAggregateItem(item);

      const itemWrap = document.createElement("div");
      itemWrap.className = [
        "mt-2 flex gap-2 rounded-md border border-review-border px-2 py-2 hover:bg-review-panel",
        collapsed ? "items-center" : "items-start",
        state.activeItemId === item.id ? "bg-review-panel text-review-strong" : "text-review-text",
      ].join(" ");

      const itemChevron = document.createElement("button");
      itemChevron.type = "button";
      itemChevron.className =
        "flex h-6 w-6 shrink-0 items-center justify-center rounded-md hover:bg-review-hover";
      itemChevron.setAttribute(
        "aria-label",
        aggregate
          ? collapsed
            ? "Expand combined diff files"
            : "Collapse combined diff files"
          : collapsed
            ? "Expand commit files"
            : "Collapse commit files",
      );
      itemChevron.innerHTML = renderChevronIcon(collapsed);
      itemChevron.addEventListener("click", (event) => {
        event.stopPropagation();
        state.collapsedItems[item.id] = !collapsed;
        renderSidebar();
      });

      const itemRow = document.createElement("button");
      itemRow.type = "button";
      itemRow.className = "flex min-w-0 flex-1 items-center justify-between gap-2 text-left";
      const expandedDescription = item.description?.trim() || "";
      itemRow.innerHTML = `
        <span class="min-w-0 flex flex-1 items-start gap-1.5 overflow-hidden">
          <span class="min-w-0 flex-1">
            <span class="block whitespace-normal break-words text-[13px] font-medium">${escapeHtml(itemLabel(item))}</span>
            ${expandedDescription ? `<span class="mt-1 block whitespace-pre-wrap break-words text-[11px] leading-5 text-review-muted">${escapeHtml(expandedDescription)}</span>` : ""}
            ${itemDescription(item) ? `<span class="mt-1 block truncate text-[11px] text-review-muted">${escapeHtml(itemDescription(item))}</span>` : ""}
          </span>
          ${renderSidebarIndicators({ reviewed: itemReviewed, commentCount: feedbackCount, placeholder: !aggregate })}
        </span>
      `;
      itemRow.addEventListener("click", () => openItem(item.id));

      itemWrap.appendChild(itemChevron);
      itemWrap.appendChild(itemRow);
      if (aggregate) {
        const separator = document.createElement("div");
        separator.className = "mx-1 mt-3 border-t border-review-border";
        fileTreeEl.appendChild(separator);
      }
      fileTreeEl.appendChild(itemWrap);

      if (collapsed) continue;
      renderSidebarFileTree(fileTreeEl, item, files);
    }
  }

  const itemNotes = Object.values(state.itemNotes).filter((note) => note?.body?.trim()).length;
  const fileNotes = Object.values(state.fileNotes).filter((note) => note?.body?.trim()).length;
  const comments = state.comments.length;
  const hasOverallComment = Boolean(state.overallComment?.trim());
  const filteredFileCount = itemEntries.reduce((count, entry) => count + entry.files.length, 0);
  const generatedSuffix =
    state.hideGenerated && generatedFileCount() > 0
      ? ` · ${formatCount(generatedFileCount(), "generated file")} hidden`
      : "";
  const filteredSuffix = state.fileFilter.trim()
    ? ` · ${formatCount(filteredFileCount, "file")} shown${generatedSuffix}`
    : generatedSuffix;
  const hasWorkingTreeItem = snapshotItems.some((item) => item.kind === "working-tree");
  const commitItemCount = snapshotItems.filter((item) => item.kind === "commit").length;
  const branchParts = [];
  if (reviewData.branchName) branchParts.push(reviewData.branchName);
  branchParts.push(
    hasWorkingTreeItem
      ? `${formatCount(commitItemCount, "commit")} · dirty working tree`
      : formatCount(commitItemCount, "commit"),
  );
  branchSummaryEl.textContent = branchParts.join(" · ");

  const summaryParts = [formatCount(comments, "inline comment")];
  if (fileNotes > 0) summaryParts.push(formatCount(fileNotes, "file note"));
  if (itemNotes > 0) summaryParts.push(formatCount(itemNotes, "commit comment"));
  if (hasOverallComment) summaryParts.push(formatCount(1, "overall comment"));

  summaryEl.textContent = `${summaryParts.join(" · ")}${filteredSuffix}`;
  updateGeneratedButton();
}

function renderHeader() {
  const item = activeItem();
  currentFileLabelEl.textContent = item ? itemLabel(item) : "No review item selected";
  currentItemStatsEl.innerHTML = item ? renderDiffStat(item) : "";
  currentItemDescriptionEl.textContent = "";
  currentItemDescriptionEl.classList.add("hidden");
  modeHintEl.textContent = itemHint(item);
}

function rerenderDocumentPreservingScroll() {
  const scroller = document.getElementById("review-document-scroller");
  const scrollTop = scroller instanceof HTMLElement ? scroller.scrollTop : null;
  renderDocument();
  if (scrollTop == null) return;
  requestAnimationFrame(() => {
    const nextScroller = document.getElementById("review-document-scroller");
    if (nextScroller instanceof HTMLElement) {
      nextScroller.scrollTop = scrollTop;
    }
  });
}

function reviewButtonClass(reviewed, enabled = true) {
  if (!enabled) {
    return "cursor-default rounded-md border border-review-border bg-review-input px-3 py-1 text-xs font-medium text-review-muted opacity-60";
  }
  return reviewed
    ? "cursor-pointer rounded-md border border-[#2ea043]/40 bg-[#238636]/15 px-3 py-1 text-xs font-medium text-[#3fb950] hover:bg-[#238636]/25"
    : "cursor-pointer rounded-md border border-review-border bg-review-panel px-3 py-1 text-xs font-medium text-review-text hover:bg-review-hover";
}

function updateToolbarButtons() {
  const item = activeItem();
  const file = activeFile();
  const aggregate = isAggregateItem(item);
  const explicitlyReviewed = isItemExplicitlyReviewed(item);
  const itemLabelText = item?.kind === "working-tree" ? "Working tree" : "Commit";

  toggleReviewedButton.textContent = isItemReviewed(item)
    ? `${itemLabelText} reviewed`
    : `Mark ${itemLabelText.toLowerCase()} reviewed`;
  toggleReviewedButton.disabled = item == null || aggregate;
  toggleReviewedButton.className = reviewButtonClass(
    isItemReviewed(item),
    item != null && !aggregate,
  );
  toggleReviewedButton.dataset.explicit = explicitlyReviewed ? "true" : "false";
  toggleReviewedButton.classList.toggle("hidden", aggregate);

  fileCommentButton.textContent = "File comment";
  fileCommentButton.disabled = item == null || aggregate || file == null;
  fileCommentButton.className =
    item == null || aggregate || file == null
      ? "cursor-default rounded-md border border-review-border bg-review-input px-3 py-1 text-xs font-medium text-review-muted opacity-60"
      : "cursor-pointer rounded-md border border-review-border bg-review-panel px-3 py-1 text-xs font-medium text-review-text hover:bg-review-hover";
  fileCommentButton.classList.toggle("hidden", aggregate);

  if (commitCommentButton) {
    commitCommentButton.textContent = `${itemLabelText} comment`;
    commitCommentButton.disabled = item == null || aggregate;
    commitCommentButton.className =
      item == null || aggregate
        ? "cursor-default rounded-md border border-review-border bg-review-input px-3 py-1 text-xs font-medium text-review-muted opacity-60"
        : "cursor-pointer rounded-md border border-review-border bg-review-panel px-3 py-1 text-xs font-medium text-review-text hover:bg-review-hover";
    commitCommentButton.classList.toggle("hidden", aggregate);
  }

  toggleWrapButton.textContent = `Wrap lines: ${state.wrapLines ? "on" : "off"}`;
  updateGeneratedButton();
  updateThemeButton();
  updateSidebarButton();
}

function showTextModal(options) {
  const backdrop = document.createElement("div");
  backdrop.className = "review-modal-backdrop";
  backdrop.innerHTML = `
    <div class="review-modal-card">
      <div class="mb-2 text-base font-semibold text-review-strong">${escapeHtml(options.title)}</div>
      <div class="mb-4 text-sm text-review-muted">${escapeHtml(options.description)}</div>
      <textarea id="review-modal-text" class="scrollbar-thin min-h-48 w-full resize-y rounded-md border border-review-border bg-review-input px-3 py-2 text-sm text-review-text outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500">${escapeHtml(options.initialValue ?? "")}</textarea>
      <div class="mt-4 flex justify-end gap-2">
        <button id="review-modal-cancel" class="cursor-pointer rounded-md border border-review-border bg-review-panel px-4 py-2 text-sm font-medium text-review-text hover:bg-review-hover">Cancel</button>
        <button id="review-modal-save" class="cursor-pointer rounded-md border border-[rgba(240,246,252,0.1)] bg-[#238636] px-4 py-2 text-sm font-medium text-white hover:bg-[#2ea043]">${escapeHtml(options.saveLabel ?? "Save")}</button>
      </div>
    </div>
  `;
  document.body.appendChild(backdrop);
  const textarea = backdrop.querySelector("#review-modal-text");
  const close = () => backdrop.remove();
  backdrop.querySelector("#review-modal-cancel").addEventListener("click", close);
  backdrop.querySelector("#review-modal-save").addEventListener("click", () => {
    options.onSave(textarea.value.trim());
    close();
  });
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) close();
  });
  textarea.focus();
}

function showOverallCommentInput() {
  state.overallCommentEditing = true;
  updateFeedbackUI();
}

function showItemNoteInput() {
  const item = activeItem();
  if (!item || isAggregateItem(item)) return;
  const existing = currentItemNote(item);
  if (!existing) {
    state.itemNotes[item.id] = {
      id: `${Date.now()}:${Math.random().toString(16).slice(2)}`,
      itemId: item.id,
      itemKind: item.kind,
      commitSha: item.commitSha,
      body: "",
    };
  }
  updateFeedbackUI();
}

function showFileNoteInput() {
  const item = activeItem();
  const file = activeFile();
  if (!item || isAggregateItem(item) || !file) return;
  const key = fileNoteKey(file, item);
  const existing = currentFileNote(item, file);
  if (!existing) {
    state.fileNotes[key] = {
      id: `${Date.now()}:${Math.random().toString(16).slice(2)}`,
      itemId: item.id,
      itemKind: item.kind,
      commitSha: item.commitSha,
      filePath: file.path,
      body: "",
    };
  }
  updateFeedbackUI();
}

function renderCommentDOM(comment, onDelete) {
  const container = document.createElement("div");
  container.className = "view-zone-container";
  const title =
    comment.lineNumber == null
      ? `${comment.itemKind === "commit" ? "Commit" : "Working tree"} comment`
      : `${comment.side === "original" ? "Original" : "Modified"} line ${comment.lineNumber}`;

  container.innerHTML = `
    <div class="mb-2 flex items-center justify-between gap-3">
      <div class="text-xs font-semibold text-review-text">${escapeHtml(title)}</div>
      <button data-action="delete" class="cursor-pointer rounded-md border border-transparent bg-transparent px-2 py-1 text-xs font-medium text-review-muted hover:bg-red-500/10 hover:text-red-400">Delete</button>
    </div>
    <textarea data-comment-id="${escapeHtml(comment.id)}" class="scrollbar-thin min-h-[76px] w-full resize-y rounded-md border border-review-border bg-review-input px-3 py-2 text-sm text-review-text outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500" placeholder="Leave a comment"></textarea>
  `;
  const textarea = container.querySelector("textarea");
  textarea.value = comment.body || "";
  textarea.addEventListener("input", () => {
    comment.body = textarea.value;
  });
  container.querySelector("[data-action='delete']").addEventListener("click", onDelete);
  if (!comment.body) setTimeout(() => textarea.focus(), 50);
  return container;
}

function renderOverallCommentDOM() {
  const container = document.createElement("div");
  container.className = "rounded-lg border border-review-border bg-review-panel p-4";
  container.innerHTML = `
    <div class="mb-2 flex items-center justify-between gap-3">
      <div class="text-xs font-semibold text-review-text">Overall review note</div>
      <button data-action="delete" class="cursor-pointer rounded-md border border-transparent bg-transparent px-2 py-1 text-xs font-medium text-review-muted hover:bg-red-500/10 hover:text-red-400">Delete</button>
    </div>
    <textarea data-comment-id="overall-comment" class="scrollbar-thin min-h-[76px] w-full resize-y rounded-md border border-review-border bg-review-input px-3 py-2 text-sm text-review-text outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500" placeholder="Leave an overall review note"></textarea>
  `;
  const textarea = container.querySelector("textarea");
  textarea.value = state.overallComment || "";
  textarea.addEventListener("input", () => {
    state.overallComment = textarea.value;
  });
  container.querySelector("[data-action='delete']").addEventListener("click", () => {
    state.overallComment = "";
    state.overallCommentEditing = false;
    updateFeedbackUI();
  });
  if (!state.overallComment) setTimeout(() => textarea.focus(), 50);
  return container;
}

function renderNotePanelDOM({ title, placeholder, value, onChange, onDelete, autoFocus }) {
  const container = document.createElement("div");
  container.className = "rounded-lg border border-review-border bg-review-panel p-4";
  container.innerHTML = `
    <div class="mb-2 flex items-center justify-between gap-3">
      <div class="text-xs font-semibold text-review-text">${escapeHtml(title)}</div>
      <button data-action="delete" class="cursor-pointer rounded-md border border-transparent bg-transparent px-2 py-1 text-xs font-medium text-review-muted hover:bg-red-500/10 hover:text-red-400">Delete</button>
    </div>
    <textarea class="scrollbar-thin min-h-[76px] w-full resize-y rounded-md border border-review-border bg-review-input px-3 py-2 text-sm text-review-text outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500" placeholder="${escapeHtml(placeholder || "Leave a note")}"></textarea>
  `;
  const textarea = container.querySelector("textarea");
  textarea.value = value || "";
  textarea.addEventListener("input", () => onChange(textarea.value));
  container.querySelector("[data-action='delete']").addEventListener("click", onDelete);
  if (autoFocus && !(value || "").trim()) setTimeout(() => textarea.focus(), 50);
  return container;
}

function renderItemNoteArea() {
  fileCommentsContainer.innerHTML = "";
  const item = activeItem();
  const file = activeFile();
  const note = currentItemNote(item);
  const fileNote = currentFileNote(item, file);

  const showOverall = state.overallCommentEditing || Boolean(state.overallComment?.trim());
  const showItemNote = item != null && note != null;
  const showFileNote = item != null && file != null && fileNote != null;

  if (!showOverall && !showItemNote && !showFileNote) {
    fileCommentsContainer.className = "hidden overflow-hidden px-0 py-0";
    return;
  }

  fileCommentsContainer.className =
    "border-b border-review-border bg-review-bg px-4 py-4 space-y-4";

  if (showOverall) {
    fileCommentsContainer.appendChild(renderOverallCommentDOM());
  }

  if (showFileNote) {
    fileCommentsContainer.appendChild(
      renderNotePanelDOM({
        title: `File note · ${getDisplayPath(file)}`,
        placeholder: "Leave a file-level note",
        value: fileNote.body,
        onChange: (value) => {
          fileNote.body = value;
        },
        onDelete: () => {
          delete state.fileNotes[fileNoteKey(file, item)];
          updateFeedbackUI();
        },
        autoFocus: true,
      }),
    );
  }

  if (showItemNote) {
    const dom = renderCommentDOM({ ...note, lineNumber: null }, () => {
      delete state.itemNotes[item.id];
      updateFeedbackUI();
    });
    dom.className = "rounded-lg border border-review-border bg-review-panel p-4";
    fileCommentsContainer.appendChild(dom);
  }
}

function canCommentOnSide(file, side) {
  if (!file || !canCreateItemScopedFeedback(file)) return false;
  const comparison = file.comparison;
  if (side === "original") return comparison?.hasOriginal === true;
  return comparison?.hasModified === true;
}

function createEditorRecord(hostEl, item, file, contents) {
  const originalModel = monacoApi.editor.createModel(
    contents.originalContent,
    inferLanguage(getFilePath(file) || file.path),
  );
  const modifiedModel = monacoApi.editor.createModel(
    contents.modifiedContent,
    inferLanguage(getFilePath(file) || file.path),
  );

  const shouldDelayReveal = file.comparison != null && !isShowingFullFile(file, item);
  let revealed = !shouldDelayReveal;
  hostEl.style.opacity = revealed ? "1" : "0";

  const diffEditor = monacoApi.editor.createDiffEditor(hostEl, {
    automaticLayout: true,
    renderSideBySide: file.comparison != null,
    readOnly: true,
    originalEditable: false,
    minimap: {
      enabled: true,
      renderCharacters: false,
      showSlider: "mouseover",
      size: "proportional",
    },
    renderOverviewRuler: true,
    diffWordWrap: state.wrapLines ? "on" : "off",
    scrollBeyondLastLine: false,
    lineNumbersMinChars: 4,
    glyphMargin: true,
    folding: true,
    lineDecorationsWidth: 10,
    overviewRulerBorder: false,
    wordWrap: "off",
    hideUnchangedRegions: {
      enabled: file.comparison != null && !isShowingFullFile(file, item),
      contextLineCount: 4,
      minimumLineCount: 2,
      revealLineCount: 12,
    },
    scrollbar: {
      alwaysConsumeMouseWheel: false,
      vertical: "hidden",
      horizontal: state.wrapLines ? "hidden" : "auto",
      useShadows: false,
    },
  });

  diffEditor.setModel({ original: originalModel, modified: modifiedModel });

  const record = {
    item,
    file,
    hostEl,
    diffEditor,
    originalModel,
    modifiedModel,
    originalDecorations: [],
    modifiedDecorations: [],
    activeViewZones: [],
    disposables: [],
    syncHeight: null,
  };

  const originalEditor = diffEditor.getOriginalEditor();
  const modifiedEditor = diffEditor.getModifiedEditor();
  originalEditor.updateOptions({ wordWrapOverride2: "inherit" });
  modifiedEditor.updateOptions({ wordWrapOverride2: "inherit" });

  const syncHeight = () => {
    const height = Math.max(
      editorContentHeight(originalEditor),
      editorContentHeight(modifiedEditor),
      160,
    );
    const nextHeight = height + 8;
    hostEl.style.height = `${nextHeight}px`;
    diffEditor.layout({
      width: hostEl.clientWidth || hostEl.offsetWidth || 0,
      height: nextHeight,
    });
  };
  const revealEditor = () => {
    if (revealed) return;
    revealed = true;
    hostEl.style.opacity = "1";
    schedulePendingScroll();
  };
  const revealEditorSoon = () => {
    requestAnimationFrame(() => {
      requestAnimationFrame(revealEditor);
    });
  };

  record.syncHeight = syncHeight;
  record.disposables.push(
    originalEditor.onDidContentSizeChange(syncHeight),
    modifiedEditor.onDidContentSizeChange(syncHeight),
    diffEditor.onDidUpdateDiff(() => {
      syncHeight();
      revealEditorSoon();
    }),
  );

  createGlyphHoverActions(record, originalEditor, "original");
  createGlyphHoverActions(record, modifiedEditor, "modified");
  editorRecords.set(file.id, record);
  syncEditorRecord(record);
  requestAnimationFrame(() => {
    syncHeight();
    if (!shouldDelayReveal) revealEditor();
  });
  if (shouldDelayReveal) {
    const fallbackReveal = setTimeout(revealEditor, 400);
    record.disposables.push({ dispose: () => clearTimeout(fallbackReveal) });
  }
}

function clearEditorViewZones(record) {
  if (!record || record.activeViewZones.length === 0) return;
  const original = record.diffEditor.getOriginalEditor();
  const modified = record.diffEditor.getModifiedEditor();
  original.changeViewZones((accessor) => {
    for (const zone of record.activeViewZones)
      if (zone.editor === original) accessor.removeZone(zone.id);
  });
  modified.changeViewZones((accessor) => {
    for (const zone of record.activeViewZones)
      if (zone.editor === modified) accessor.removeZone(zone.id);
  });
  record.activeViewZones = [];
}

function syncEditorRecord(record) {
  if (!record || !monacoApi) return;
  const comments = itemInlineComments(record.item, record.file);
  clearEditorViewZones(record);

  const originalEditor = record.diffEditor.getOriginalEditor();
  const modifiedEditor = record.diffEditor.getModifiedEditor();

  for (const comment of comments) {
    const editor = comment.side === "original" ? originalEditor : modifiedEditor;
    const domNode = renderCommentDOM(comment, () => {
      state.comments = state.comments.filter((item) => item.id !== comment.id);
      updateFeedbackUI();
    });

    editor.changeViewZones((accessor) => {
      const lineCount =
        typeof comment.body === "string" && comment.body.length > 0
          ? comment.body.split("\n").length
          : 1;
      const id = accessor.addZone({
        afterLineNumber: comment.lineNumber,
        heightInPx: Math.max(150, lineCount * 22 + 86),
        domNode,
      });
      record.activeViewZones.push({ id, editor });
    });
  }

  const originalRanges = [];
  const modifiedRanges = [];
  for (const comment of comments) {
    const range = {
      range: new monacoApi.Range(comment.lineNumber, 1, comment.lineNumber, 1),
      options: {
        isWholeLine: true,
        className:
          comment.side === "original"
            ? "review-comment-line-original"
            : "review-comment-line-modified",
        glyphMarginClassName:
          comment.side === "original"
            ? "review-comment-glyph-original"
            : "review-comment-glyph-modified",
      },
    };
    if (comment.side === "original") originalRanges.push(range);
    else modifiedRanges.push(range);
  }

  record.originalDecorations = originalEditor.deltaDecorations(
    record.originalDecorations,
    originalRanges,
  );
  record.modifiedDecorations = modifiedEditor.deltaDecorations(
    record.modifiedDecorations,
    modifiedRanges,
  );

  record.diffEditor.updateOptions({
    renderSideBySide: record.file.comparison != null,
    diffWordWrap: state.wrapLines ? "on" : "off",
    hideUnchangedRegions: {
      enabled: record.file.comparison != null && !isShowingFullFile(record.file, record.item),
      contextLineCount: 4,
      minimumLineCount: 2,
      revealLineCount: 12,
    },
    scrollbar: {
      alwaysConsumeMouseWheel: false,
      vertical: "hidden",
      horizontal: state.wrapLines ? "hidden" : "auto",
      useShadows: false,
    },
  });
  originalEditor.updateOptions({
    wordWrapOverride2: "inherit",
    scrollbar: {
      alwaysConsumeMouseWheel: false,
      vertical: "hidden",
      horizontal: state.wrapLines ? "hidden" : "auto",
      useShadows: false,
    },
  });
  modifiedEditor.updateOptions({
    wordWrapOverride2: "inherit",
    scrollbar: {
      alwaysConsumeMouseWheel: false,
      vertical: "hidden",
      horizontal: state.wrapLines ? "hidden" : "auto",
      useShadows: false,
    },
  });
  requestAnimationFrame(() => record.syncHeight?.());
}

function syncAllEditors() {
  for (const record of editorRecords.values()) {
    syncEditorRecord(record);
  }
}

function createGlyphHoverActions(record, editor, side) {
  let hoverDecoration = [];

  function openDraftAtLine(line) {
    if (!record || !canCommentOnSide(record.file, side)) return;
    state.activeItemId = record.item.id;
    state.activeFileId = record.file.id;
    state.comments.push({
      id: `${Date.now()}:${Math.random().toString(16).slice(2)}`,
      itemId: record.item.id,
      itemKind: record.item.kind,
      commitSha: record.item.commitSha,
      filePath: record.file.path,
      side,
      lineNumber: line,
      body: "",
    });
    updateFeedbackUI();
    editor.revealLineInCenter(line);
  }

  editor.onMouseMove((event) => {
    if (!canCommentOnSide(record.file, side)) {
      hoverDecoration = editor.deltaDecorations(hoverDecoration, []);
      return;
    }

    const target = event.target;
    if (
      target.type === monacoApi.editor.MouseTargetType.GUTTER_GLYPH_MARGIN ||
      target.type === monacoApi.editor.MouseTargetType.GUTTER_LINE_NUMBERS
    ) {
      const line = target.position?.lineNumber;
      if (!line) return;
      hoverDecoration = editor.deltaDecorations(hoverDecoration, [
        {
          range: new monacoApi.Range(line, 1, line, 1),
          options: { glyphMarginClassName: "review-glyph-plus" },
        },
      ]);
    } else {
      hoverDecoration = editor.deltaDecorations(hoverDecoration, []);
    }
  });

  editor.onMouseLeave(() => {
    hoverDecoration = editor.deltaDecorations(hoverDecoration, []);
  });

  editor.onMouseDown((event) => {
    if (!canCommentOnSide(record.file, side)) return;
    const target = event.target;
    if (
      target.type === monacoApi.editor.MouseTargetType.GUTTER_GLYPH_MARGIN ||
      target.type === monacoApi.editor.MouseTargetType.GUTTER_LINE_NUMBERS
    ) {
      const line = target.position?.lineNumber;
      if (!line) return;
      openDraftAtLine(line);
    }
  });
}

function placeholderPanel(message) {
  const panel = document.createElement("div");
  panel.className =
    "flex h-full items-center justify-center rounded-md border border-review-border bg-review-bg px-4 text-sm text-review-muted";
  panel.textContent = message;
  return panel;
}

function schedulePendingScroll() {
  const fileId = state.pendingScrollFileId;
  if (!fileId) return;
  if (pendingScrollFrame != null) cancelAnimationFrame(pendingScrollFrame);

  let attemptsRemaining = 6;
  const tick = () => {
    const currentFileId = state.pendingScrollFileId;
    if (!currentFileId) {
      pendingScrollFrame = null;
      return;
    }

    const scroller = document.getElementById("review-document-scroller");
    const section = document.getElementById(`file-section-${currentFileId}`);
    const header = section?.querySelector("[data-file-header='true']");
    if (scroller instanceof HTMLElement && section instanceof HTMLElement) {
      const item = activeItem();
      const fileIndex = item?.files.findIndex((file) => file.id === currentFileId) ?? -1;
      if (fileIndex <= 0) {
        scroller.scrollTop = 0;
      } else if (header instanceof HTMLElement) {
        const headerTop =
          header.getBoundingClientRect().top -
          scroller.getBoundingClientRect().top +
          scroller.scrollTop;
        scroller.scrollTop = Math.max(0, headerTop - NON_TOP_FILE_SCROLL_PADDING);
      } else {
        scroller.scrollTop = Math.max(0, section.offsetTop - NON_TOP_FILE_SCROLL_PADDING);
      }
    }

    attemptsRemaining -= 1;
    if (attemptsRemaining > 0) {
      pendingScrollFrame = requestAnimationFrame(tick);
      return;
    }

    if (state.pendingScrollFileId === currentFileId) {
      state.pendingScrollFileId = null;
    }
    pendingScrollFrame = null;
  };

  pendingScrollFrame = requestAnimationFrame(tick);
}

function renderLargeFilePlaceholder(editorHost, item, file) {
  const wrapper = document.createElement("div");
  wrapper.className =
    "flex min-h-[160px] flex-col items-center justify-center gap-3 rounded-md border border-review-border bg-review-bg px-4 py-5 text-center text-sm text-review-muted";

  const body = document.createElement("div");
  body.className = "max-w-3xl leading-6";
  body.textContent = largeFileReason(file);

  const button = document.createElement("button");
  button.type = "button";
  button.className =
    "cursor-pointer rounded-md border border-review-border bg-review-panel px-3 py-2 text-sm font-medium text-review-text hover:bg-review-hover";
  button.textContent = "Load diff";
  button.addEventListener("click", () => {
    state.largeFileLoads[file.id] = true;
    renderFileSectionContent(editorHost, item, file);
  });

  wrapper.appendChild(body);
  wrapper.appendChild(button);
  editorHost.appendChild(wrapper);
}

function renderFileSectionContent(editorHost, item, file) {
  disposeEditorRecord(file.id);
  editorHost.innerHTML = "";

  const requestState = getRequestState(file.id);
  if (requestState.contents != null && monacoApi != null) {
    createEditorRecord(editorHost, item, file, requestState.contents);
    return;
  }

  if (requestState.error != null) {
    editorHost.appendChild(
      placeholderPanel(`Failed to load ${getDisplayPath(file)}\n\n${requestState.error}`),
    );
    return;
  }

  if (shouldDeferLargeFile(file)) {
    renderLargeFilePlaceholder(editorHost, item, file);
    return;
  }

  ensureFileLoaded(file.id);
  editorHost.appendChild(placeholderPanel(`Loading ${getDisplayPath(file)}...`));
}

function refreshRenderedFileSection(fileId) {
  const item = activeItem();
  if (!item) return;
  const file = item.files.find((entry) => entry.id === fileId);
  if (!file) return;

  const section = document.getElementById(`file-section-${fileId}`);
  const editorHost = section?.querySelector(".file-editor-host");
  if (!(editorHost instanceof HTMLElement)) return;

  renderFileSectionContent(editorHost, item, file);
  updateToolbarButtons();
  schedulePendingScroll();
}

function renderDocument() {
  disposeEditors();
  editorContainerEl.innerHTML = "";

  const item = activeItem();
  if (!item) {
    state.renderedItemId = null;
    editorContainerEl.innerHTML = `
      <div class="flex h-full items-center justify-center px-6 text-sm text-review-muted">
        No review item selected.
      </div>
    `;
    updateToolbarButtons();
    return;
  }

  state.renderedItemId = item.id;
  const scroller = document.createElement("div");
  scroller.id = "review-document-scroller";
  scroller.className = "scrollbar-thin h-full overflow-auto px-4 pb-4 pt-0 space-y-4";
  scroller.dataset.reviewItemId = item.id;

  const visibleFiles = itemVisibleFiles(item);
  if (visibleFiles.length === 0) {
    scroller.innerHTML = `
      <div class="flex h-full items-center justify-center px-6 text-sm text-review-muted">
        ${state.hideGenerated && generatedFileCount() > 0 ? "Generated files are hidden." : "No files in this review item."}
      </div>
    `;
    editorContainerEl.appendChild(scroller);
    updateToolbarButtons();
    return;
  }

  const firstVisibleFileId = visibleFiles[0]?.id ?? null;
  for (const file of visibleFiles) {
    const section = document.createElement("section");
    section.id = `file-section-${file.id}`;
    section.dataset.fileSection = "true";
    section.dataset.fileId = file.id;
    section.className = [
      "rounded-lg border border-review-border bg-review-panel",
      file.id === firstVisibleFileId ? "mt-4" : "",
    ].join(" ");

    const status = file.comparison?.status || null;
    const commentCount = itemInlineComments(item, file).length;
    const reviewed = isFileReviewed(file, item);
    const showingFullFile = isShowingFullFile(file, item);
    const collapsed = isFileCollapsed(file, item);

    const headerBar = document.createElement("div");
    headerBar.dataset.fileHeader = "true";
    headerBar.className = collapsed
      ? "flex w-full items-center justify-between gap-3 rounded-lg bg-review-panel px-4 py-3"
      : "sticky top-0 z-10 flex w-full items-center justify-between gap-3 rounded-t-lg border-b border-review-border bg-review-panel px-4 py-3";

    const headerMain = document.createElement("div");
    headerMain.className = "min-w-0 flex flex-1 items-center gap-2 text-left";

    const collapseButton = document.createElement("button");
    collapseButton.type = "button";
    collapseButton.className =
      "flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-review-muted hover:bg-review-hover";
    collapseButton.setAttribute("aria-label", collapsed ? "Expand file" : "Collapse file");
    collapseButton.innerHTML = renderChevronIcon(collapsed);
    collapseButton.addEventListener("click", () => {
      const key = collapsedFileKey(file, item);
      state.collapsedFiles[key] = !isFileCollapsed(file, item);
      rerenderDocumentPreservingScroll();
    });

    const title = document.createElement("span");
    title.className = "block truncate text-sm font-semibold text-review-strong";
    title.textContent = getDisplayPath(file);

    headerMain.appendChild(collapseButton);
    headerMain.appendChild(title);

    const headerActions = document.createElement("div");
    headerActions.className = "flex shrink-0 items-center gap-2";
    headerActions.innerHTML = `
      ${renderCommentCount(commentCount)}
      ${renderDiffStat(file, status)}
    `;

    const reviewedButton = document.createElement("button");
    reviewedButton.type = "button";
    reviewedButton.className = reviewButtonClass(reviewed);
    reviewedButton.textContent = reviewed ? "Reviewed" : "Mark reviewed";
    reviewedButton.addEventListener("click", () => {
      const key = reviewFileKey(file, item);
      const nextReviewed = !isFileReviewed(file, item);
      state.reviewedFiles[key] = nextReviewed;
      if (nextReviewed) {
        state.collapsedFiles[collapsedFileKey(file, item)] = true;
        renderSidebar();
        updateToolbarButtons();
        rerenderDocumentPreservingScroll();
        return;
      }
      reviewedButton.className = reviewButtonClass(nextReviewed);
      reviewedButton.textContent = nextReviewed ? "Reviewed" : "Mark reviewed";
      renderSidebar();
      updateToolbarButtons();
    });

    const fullFileButton = document.createElement("button");
    fullFileButton.type = "button";
    fullFileButton.className =
      "cursor-pointer border-0 bg-transparent p-0 text-xs font-medium text-review-muted underline-offset-2 hover:text-review-text hover:underline";
    fullFileButton.textContent = showingFullFile ? "Show changes only" : "Show full file";
    fullFileButton.addEventListener("click", () => {
      const key = fullFileKey(file, item);
      state.fullFiles[key] = !isShowingFullFile(file, item);
      if (isFileCollapsed(file, item)) {
        state.collapsedFiles[collapsedFileKey(file, item)] = false;
      }
      rerenderDocumentPreservingScroll();
    });

    if (file.comparison != null) headerActions.appendChild(fullFileButton);
    if (!isAggregateItem(item)) {
      headerActions.appendChild(reviewedButton);
    }
    headerBar.appendChild(headerMain);
    headerBar.appendChild(headerActions);
    section.appendChild(headerBar);
    scroller.appendChild(section);

    if (!collapsed) {
      const body = document.createElement("div");
      body.className = "overflow-hidden px-4 py-4";
      const editorHost = document.createElement("div");
      editorHost.className =
        "file-editor-host min-h-[160px] overflow-hidden rounded-md border border-review-border bg-review-bg";
      editorHost.style.height = "160px";
      body.appendChild(editorHost);
      section.appendChild(body);

      renderFileSectionContent(editorHost, item, file);
    }
  }

  editorContainerEl.appendChild(scroller);
  updateToolbarButtons();
  schedulePendingScroll();
}

function syncCommentBodiesFromDOM() {
  const textareas = document.querySelectorAll("textarea[data-comment-id]");
  textareas.forEach((textarea) => {
    const commentId = textarea.getAttribute("data-comment-id");
    if (commentId === "overall-comment") {
      state.overallComment = textarea.value;
      return;
    }
    const comment = state.comments.find((item) => item.id === commentId);
    if (comment) {
      comment.body = textarea.value;
      return;
    }
    for (const note of Object.values(state.itemNotes)) {
      if (note?.id === commentId) {
        note.body = textarea.value;
        return;
      }
    }
  });
}

function updateFeedbackUI() {
  syncCommentBodiesFromDOM();
  renderSidebar();
  renderHeader();
  renderItemNoteArea();
  syncAllEditors();
  updateToolbarButtons();
}

window.__reviewReceive = function (message) {
  if (!message || typeof message !== "object") return;
  const key = message.fileId;

  if (message.type === "file-data") {
    state.fileContents[key] = {
      originalContent: message.originalContent,
      modifiedContent: message.modifiedContent,
    };
    if (state.activeFileId === key) state.pendingScrollFileId = key;
    delete state.fileErrors[key];
    delete state.pendingRequestIds[key];
    renderSidebar();
    renderHeader();
    renderItemNoteArea();
    refreshRenderedFileSection(key);
    return;
  }

  if (message.type === "file-error") {
    state.fileErrors[key] = message.message || "Unknown error";
    if (state.activeFileId === key) state.pendingScrollFileId = key;
    delete state.pendingRequestIds[key];
    renderSidebar();
    renderHeader();
    renderItemNoteArea();
    refreshRenderedFileSection(key);
  }
};

function setupMonaco() {
  window.require.config({
    paths: {
      vs: "https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.52.2/min/vs",
    },
  });

  window.require(["vs/editor/editor.main"], function () {
    monacoApi = window.monaco;
    monacoApi.editor.defineTheme("review-dark", {
      base: "vs-dark",
      inherit: true,
      rules: [],
      colors: {
        "editor.background": "#0d1117",
        "diffEditor.insertedTextBackground": "#2ea04326",
        "diffEditor.removedTextBackground": "#f8514926",
      },
    });
    monacoApi.editor.defineTheme("review-light", {
      base: "vs",
      inherit: true,
      rules: [],
      colors: {
        "editor.background": "#ffffff",
        "editorGutter.background": "#ffffff",
        "diffEditor.insertedTextBackground": "#1a7f3726",
        "diffEditor.removedTextBackground": "#cf222e26",
      },
    });
    applyTheme();
    renderDocument();
  });
}

submitButton.addEventListener("click", () => {
  syncCommentBodiesFromDOM();
  const payload = {
    type: "submit",
    overallComment: state.overallComment.trim(),
    itemNotes: Object.values(state.itemNotes)
      .map((note) => ({ ...note, body: note.body.trim() }))
      .filter((note) => note.body.length > 0),
    fileNotes: Object.values(state.fileNotes)
      .map((note) => ({ ...note, body: note.body.trim() }))
      .filter((note) => note.body.length > 0),
    comments: state.comments
      .map((comment) => ({ ...comment, body: comment.body.trim() }))
      .filter((comment) => comment.body.length > 0),
  };
  window.glimpse.send(payload);
  window.glimpse.close();
});

cancelButton.addEventListener("click", () => {
  window.glimpse.send({ type: "cancel" });
  window.glimpse.close();
});

overallCommentButton.addEventListener("click", () => {
  showOverallCommentInput();
});

fileCommentButton.addEventListener("click", () => {
  showFileNoteInput();
});

if (commitCommentButton) {
  commitCommentButton.addEventListener("click", () => {
    showItemNoteInput();
  });
}

toggleGeneratedButton.addEventListener("click", () => {
  state.hideGenerated = !state.hideGenerated;
  try {
    window.localStorage?.setItem(HIDE_GENERATED_STORAGE_KEY, String(state.hideGenerated));
  } catch {}
  ensureActiveSelection();
  renderSidebar();
  renderHeader();
  renderItemNoteArea();
  renderDocument();
});

toggleWrapButton.addEventListener("click", () => {
  state.wrapLines = !state.wrapLines;
  renderDocument();
});

toggleThemeButton.addEventListener("click", () => {
  state.theme = state.theme === "dark" ? "light" : "dark";
  applyTheme();
});

toggleSidebarButton?.addEventListener("click", () => {
  state.sidebarVisible = !state.sidebarVisible;
  try {
    window.localStorage?.setItem(SIDEBAR_STORAGE_KEY, String(state.sidebarVisible));
  } catch {}
  applySidebarVisibility();
});

toggleReviewedButton.addEventListener("click", () => {
  const item = activeItem();
  if (!item) return;
  const key = itemReviewKey(item);
  if (isItemExplicitlyReviewed(item)) {
    delete state.reviewedItems[key];
  } else {
    state.reviewedItems[key] = true;
  }
  renderSidebar();
  renderHeader();
  updateToolbarButtons();
});

sidebarSearchInputEl.addEventListener("input", () => {
  state.fileFilter = sidebarSearchInputEl.value;
  renderSidebar();
});

sidebarSearchInputEl.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    sidebarSearchInputEl.value = "";
    state.fileFilter = "";
    renderSidebar();
  }
});

expandAllCommitsButton.addEventListener("click", () => {
  snapshotItems.forEach((item) => {
    if (item.kind === "aggregate") return;
    state.collapsedItems[item.id] = false;
  });
  renderSidebar();
});

collapseAllCommitsButton.addEventListener("click", () => {
  snapshotItems.forEach((item) => {
    if (item.kind === "aggregate") return;
    state.collapsedItems[item.id] = true;
  });
  renderSidebar();
});

applyTheme();
ensureActiveSelection();
applySidebarVisibility();
renderSidebar();
renderHeader();
renderItemNoteArea();
renderDocument();
setupMonaco();
