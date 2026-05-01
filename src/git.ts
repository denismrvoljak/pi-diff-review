import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type {
  ChangeStatus,
  ReviewFile,
  ReviewFileComparison,
  ReviewFileContents,
  ReviewItem,
  ReviewItemFile,
  ReviewLineStats,
  ReviewScope,
  ReviewSnapshot,
} from "./types.js";

interface ChangedPath {
  status: ChangeStatus;
  oldPath: string | null;
  newPath: string | null;
  isGenerated: boolean;
}

interface ReviewFileSeed {
  path: string;
  isGenerated: boolean;
  worktreeStatus: ChangeStatus | null;
  hasWorkingTreeFile: boolean;
  inGitDiff: boolean;
  inBranchDiff: boolean;
  inLastCommit: boolean;
  gitDiff: ReviewFileComparison | null;
  branchDiff: ReviewFileComparison | null;
  lastCommit: ReviewFileComparison | null;
}

interface CommitReviewMetadata {
  sha: string;
  shortSha: string;
  subject: string;
  description: string | null;
  authorName: string;
  authoredAt: string;
  coAuthors: string[];
}

interface CollectedReviewData {
  repoRoot: string;
  branchName: string | null;
  headSha: string | null;
  branchDiffBaseRef: string | null;
  branchDiffBaseRevision: string | null;
  worktreeChanges: ChangedPath[];
  currentPaths: string[];
  currentGeneratedPaths: Set<string>;
  generatedPaths: Set<string>;
  aggregateChanges: ChangedPath[];
  branchDiffChanges: ChangedPath[];
  lastCommitChanges: ChangedPath[];
}

async function runGit(pi: ExtensionAPI, repoRoot: string, args: string[]): Promise<string> {
  const result = await pi.exec("git", args, { cwd: repoRoot });
  if (result.code !== 0) {
    const message = result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} failed`;
    throw new Error(message);
  }
  return result.stdout;
}

async function runGitAllowFailure(
  pi: ExtensionAPI,
  repoRoot: string,
  args: string[],
): Promise<string> {
  const result = await pi.exec("git", args, { cwd: repoRoot });
  if (result.code !== 0) {
    return "";
  }
  return result.stdout;
}

export async function getRepoRoot(pi: ExtensionAPI, cwd: string): Promise<string> {
  const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd });
  if (result.code !== 0) {
    throw new Error("Not inside a git repository.");
  }
  return result.stdout.trim();
}

function parseNameStatus(output: string): ChangedPath[] {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const changes: ChangedPath[] = [];

  for (const line of lines) {
    const parts = line.split("\t");
    const rawStatus = parts[0] ?? "";
    const code = rawStatus[0];

    if (code === "R") {
      const oldPath = parts[1] ?? null;
      const newPath = parts[2] ?? null;
      if (oldPath != null && newPath != null) {
        changes.push({ status: "renamed", oldPath, newPath, isGenerated: false });
      }
      continue;
    }

    if (code === "M") {
      const path = parts[1] ?? null;
      if (path != null) {
        changes.push({ status: "modified", oldPath: path, newPath: path, isGenerated: false });
      }
      continue;
    }

    if (code === "A") {
      const path = parts[1] ?? null;
      if (path != null) {
        changes.push({ status: "added", oldPath: null, newPath: path, isGenerated: false });
      }
      continue;
    }

    if (code === "D") {
      const path = parts[1] ?? null;
      if (path != null) {
        changes.push({ status: "deleted", oldPath: path, newPath: null, isGenerated: false });
      }
    }
  }

  return changes;
}

function parseUntrackedPaths(output: string): ChangedPath[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((path) => ({
      status: "added" as const,
      oldPath: null,
      newPath: path,
      isGenerated: false,
    }));
}

function parseTrackedPaths(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function parseNumstatValue(raw: string): number | null {
  if (raw === "-") return null;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : null;
}

function parseNumstatZ(output: string): Map<string, ReviewLineStats> {
  const entries = new Map<string, ReviewLineStats>();
  const parts = output.split("\u0000");

  for (let index = 0; index < parts.length; ) {
    const entry = parts[index] ?? "";
    if (entry.length === 0) {
      index += 1;
      continue;
    }

    const [rawAdded = "", rawDeleted = "", ...rest] = entry.split("\t");
    const addedLines = parseNumstatValue(rawAdded);
    const deletedLines = parseNumstatValue(rawDeleted);
    const inlinePath = rest.join("\t");

    if (inlinePath.length > 0) {
      entries.set(inlinePath, {
        addedLines,
        deletedLines,
        originalLineCount: null,
        modifiedLineCount: null,
        originalByteCount: null,
        modifiedByteCount: null,
      });
      index += 1;
      continue;
    }

    const oldPath = parts[index + 1] ?? "";
    const newPath = parts[index + 2] ?? "";
    const path = newPath || oldPath;
    if (path.length > 0) {
      entries.set(path, {
        addedLines,
        deletedLines,
        originalLineCount: null,
        modifiedLineCount: null,
        originalByteCount: null,
        modifiedByteCount: null,
      });
    }
    index += 3;
  }

  return entries;
}

function mergeChangedPaths(tracked: ChangedPath[], untracked: ChangedPath[]): ChangedPath[] {
  const seen = new Set(
    tracked.map((change) => `${change.status}:${change.oldPath ?? ""}:${change.newPath ?? ""}`),
  );
  const merged = [...tracked];

  for (const change of untracked) {
    const key = `${change.status}:${change.oldPath ?? ""}:${change.newPath ?? ""}`;
    if (seen.has(key)) continue;
    merged.push(change);
    seen.add(key);
  }

  return merged;
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)];
}

function changedPathAttributePaths(change: ChangedPath): string[] {
  return uniquePaths(
    [change.newPath, change.oldPath].filter((path): path is string => path != null),
  );
}

function isGeneratedAttributeValue(value: string | undefined): boolean {
  const normalized = (value ?? "").trim().toLowerCase();
  return !["", "unspecified", "unset", "false", "0", "no"].includes(normalized);
}

async function getGeneratedFilePaths(
  pi: ExtensionAPI,
  repoRoot: string,
  paths: string[],
): Promise<Set<string>> {
  const generatedPaths = new Set<string>();
  const uniqueReviewPaths = uniquePaths(paths).filter((path) => path.length > 0);
  const batchSize = 200;

  for (let index = 0; index < uniqueReviewPaths.length; index += batchSize) {
    const batch = uniqueReviewPaths.slice(index, index + batchSize);
    const output = await runGitAllowFailure(pi, repoRoot, [
      "check-attr",
      "-z",
      "linguist-generated",
      "linguist-vendored",
      "--",
      ...batch,
    ]);
    const parts = output.split("\u0000");
    for (let partIndex = 0; partIndex + 2 < parts.length; partIndex += 3) {
      const path = parts[partIndex] ?? "";
      const value = parts[partIndex + 2];
      if (path.length > 0 && isGeneratedAttributeValue(value)) {
        generatedPaths.add(path);
      }
    }
  }

  return generatedPaths;
}

function annotateGeneratedChanges(
  changes: ChangedPath[],
  generatedPaths: Set<string>,
): ChangedPath[] {
  return changes.map((change) => ({
    ...change,
    isGenerated: changedPathAttributePaths(change).some((path) => generatedPaths.has(path)),
  }));
}

function toDisplayPath(change: ChangedPath): string {
  if (change.status === "renamed") {
    return `${change.oldPath ?? ""} -> ${change.newPath ?? ""}`;
  }
  return change.newPath ?? change.oldPath ?? "(unknown)";
}

function toComparison(change: ChangedPath): ReviewFileComparison {
  return {
    status: change.status,
    oldPath: change.oldPath,
    newPath: change.newPath,
    displayPath: toDisplayPath(change),
    hasOriginal: change.oldPath != null,
    hasModified: change.newPath != null,
  };
}

function buildReviewFileId(
  path: string,
  hasWorkingTreeFile: boolean,
  gitDiff: ReviewFileComparison | null,
  branchDiff: ReviewFileComparison | null,
  lastCommit: ReviewFileComparison | null,
): string {
  return [
    path,
    hasWorkingTreeFile ? "working" : "gone",
    gitDiff?.displayPath ?? "",
    branchDiff?.displayPath ?? "",
    lastCommit?.displayPath ?? "",
  ].join("::");
}

function createReviewFile(seed: ReviewFileSeed): ReviewFile {
  return {
    id: buildReviewFileId(
      seed.path,
      seed.hasWorkingTreeFile,
      seed.gitDiff,
      seed.branchDiff,
      seed.lastCommit,
    ),
    path: seed.path,
    isGenerated: seed.isGenerated,
    worktreeStatus: seed.worktreeStatus,
    hasWorkingTreeFile: seed.hasWorkingTreeFile,
    inGitDiff: seed.inGitDiff,
    inBranchDiff: seed.inBranchDiff,
    inLastCommit: seed.inLastCommit,
    gitDiff: seed.gitDiff,
    branchDiff: seed.branchDiff,
    lastCommit: seed.lastCommit,
  };
}

function compareReviewItemFiles(a: ReviewItemFile, b: ReviewItemFile): number {
  return a.path.localeCompare(b.path);
}

function buildReviewItemFileId(itemId: string, path: string, displayPath: string): string {
  return `${itemId}::${path}::${displayPath}`;
}

function toReviewItemFile(
  itemId: string,
  path: string,
  isGenerated: boolean,
  comparison: ReviewFileComparison,
  hasWorkingTreeFile: boolean,
  lineStats: ReviewLineStats | null,
): ReviewItemFile {
  return {
    id: buildReviewItemFileId(itemId, path, comparison.displayPath),
    path,
    isGenerated,
    comparison,
    hasWorkingTreeFile,
    lineStats,
  };
}

function formatAuthoredDate(authoredAt: string): string {
  const trimmed = authoredAt.trim();
  return trimmed.length >= 10 ? trimmed.slice(0, 10) : trimmed;
}

async function getHeadSha(pi: ExtensionAPI, repoRoot: string): Promise<string | null> {
  const output = await runGitAllowFailure(pi, repoRoot, ["rev-parse", "--verify", "HEAD"]);
  const sha = output.trim();
  return sha.length > 0 ? sha : null;
}

async function getCurrentBranchName(pi: ExtensionAPI, repoRoot: string): Promise<string | null> {
  const output = await runGitAllowFailure(pi, repoRoot, ["branch", "--show-current"]);
  const branch = output.trim();
  return branch.length > 0 ? branch : null;
}

function parseCoAuthors(body: string): string[] {
  return body
    .split(/\r?\n/)
    .map((line) => line.match(/^co-authored-by:\s*(.+?)(?:\s*<[^>]+>)?\s*$/i)?.[1]?.trim() ?? null)
    .filter((value): value is string => value != null && value.length > 0);
}

function parseCommitDescription(body: string): string | null {
  const lines = body.split(/\r?\n/);
  const descriptionLines = lines.slice(1);

  while (
    descriptionLines.length > 0 &&
    /^co-authored-by:/i.test(descriptionLines[descriptionLines.length - 1]?.trim() || "")
  ) {
    descriptionLines.pop();
  }

  while (
    descriptionLines.length > 0 &&
    descriptionLines[descriptionLines.length - 1]?.trim() === ""
  ) {
    descriptionLines.pop();
  }

  const description = descriptionLines.join("\n").trim();
  return description.length > 0 ? description : null;
}

async function getCommitReviewMetadata(
  pi: ExtensionAPI,
  repoRoot: string,
  sha: string,
): Promise<CommitReviewMetadata> {
  const output = await runGit(pi, repoRoot, [
    "show",
    "-s",
    "--format=%H%x00%h%x00%s%x00%an%x00%aI%x00%B",
    sha,
  ]);
  const [
    fullSha = sha,
    shortSha = sha.slice(0, 7),
    subject = sha,
    authorName = "",
    authoredAt = "",
    body = "",
  ] = output.trimEnd().split("\u0000");

  return {
    sha: fullSha,
    shortSha,
    subject,
    description: parseCommitDescription(body),
    authorName,
    authoredAt,
    coAuthors: parseCoAuthors(body),
  };
}

async function listLinearCommitShas(
  pi: ExtensionAPI,
  repoRoot: string,
  mergeBaseSha: string,
  headSha: string,
): Promise<string[]> {
  const output = await runGitAllowFailure(pi, repoRoot, [
    "rev-list",
    "--reverse",
    "--parents",
    `${mergeBaseSha}..${headSha}`,
  ]);

  const commits: string[] = [];
  for (const line of output
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)) {
    const hashes = line.split(/\s+/);
    if (hashes.length > 2) {
      throw new Error("Diff review stack mode currently supports only linear commit history.");
    }
    const commitSha = hashes[0];
    if (commitSha != null) {
      commits.push(commitSha);
    }
  }

  return commits;
}

function sumItemLineStats(files: ReviewItemFile[]): {
  addedLines: number;
  deletedLines: number;
  originalLineCount: number;
  modifiedLineCount: number;
} {
  return files.reduce(
    (totals, file) => ({
      addedLines: totals.addedLines + (file.lineStats?.addedLines ?? 0),
      deletedLines: totals.deletedLines + (file.lineStats?.deletedLines ?? 0),
      originalLineCount: totals.originalLineCount + (file.lineStats?.originalLineCount ?? 0),
      modifiedLineCount: totals.modifiedLineCount + (file.lineStats?.modifiedLineCount ?? 0),
    }),
    { addedLines: 0, deletedLines: 0, originalLineCount: 0, modifiedLineCount: 0 },
  );
}

async function getCommitItemLineStats(
  pi: ExtensionAPI,
  repoRoot: string,
  sha: string,
): Promise<Map<string, ReviewLineStats>> {
  const output = await runGitAllowFailure(pi, repoRoot, [
    "diff-tree",
    "--root",
    "--find-renames",
    "-M",
    "--numstat",
    "--no-commit-id",
    "-r",
    "-z",
    sha,
  ]);
  return parseNumstatZ(output);
}

async function resolveContentMetrics(
  originalContentPromise: Promise<string>,
  modifiedContentPromise: Promise<string>,
): Promise<{
  originalLineCount: number;
  modifiedLineCount: number;
  originalByteCount: number;
  modifiedByteCount: number;
}> {
  const [originalContent, modifiedContent] = await Promise.all([
    originalContentPromise,
    modifiedContentPromise,
  ]);
  return {
    originalLineCount: countLines(originalContent),
    modifiedLineCount: countLines(modifiedContent),
    originalByteCount: Buffer.byteLength(originalContent, "utf8"),
    modifiedByteCount: Buffer.byteLength(modifiedContent, "utf8"),
  };
}

async function getCommitItemFiles(
  pi: ExtensionAPI,
  repoRoot: string,
  itemId: string,
  sha: string,
  generatedPaths: Set<string>,
): Promise<ReviewItemFile[]> {
  const [output, lineStats, parentRevision] = await Promise.all([
    runGitAllowFailure(pi, repoRoot, [
      "diff-tree",
      "--root",
      "--find-renames",
      "-M",
      "--name-status",
      "--no-commit-id",
      "-r",
      sha,
    ]),
    getCommitItemLineStats(pi, repoRoot, sha),
    getParentRevision(pi, repoRoot, sha),
  ]);

  const rawChanges = parseNameStatus(output).filter((change) =>
    isReviewableFilePath(change.newPath ?? change.oldPath ?? ""),
  );
  const commitGeneratedPaths = await getGeneratedFilePaths(
    pi,
    repoRoot,
    rawChanges.flatMap(changedPathAttributePaths),
  );
  const changes = annotateGeneratedChanges(
    rawChanges,
    new Set([...generatedPaths, ...commitGeneratedPaths]),
  );

  const files = await Promise.all(
    changes.map(async (change) => {
      const path = change.newPath ?? change.oldPath ?? toDisplayPath(change);
      const comparison = toComparison(change);
      const rawLineStats = lineStats.get(path) ?? null;
      const lineCounts = await resolveContentMetrics(
        comparison.oldPath == null || parentRevision == null
          ? Promise.resolve("")
          : getRevisionContent(pi, repoRoot, parentRevision, comparison.oldPath),
        comparison.newPath == null
          ? Promise.resolve("")
          : getRevisionContent(pi, repoRoot, sha, comparison.newPath),
      );
      return toReviewItemFile(
        itemId,
        path,
        change.isGenerated,
        comparison,
        change.newPath != null,
        rawLineStats == null ? null : { ...rawLineStats, ...lineCounts },
      );
    }),
  );

  return files.sort(compareReviewItemFiles);
}

function countLines(content: string): number {
  if (content.length === 0) return 0;
  const newlineCount = content.match(/\n/g)?.length ?? 0;
  return newlineCount + (content.endsWith("\n") ? 0 : 1);
}

async function getWorkingTreeItemLineStats(
  pi: ExtensionAPI,
  repoRoot: string,
  headSha: string | null,
  worktreeChanges: ChangedPath[],
): Promise<Map<string, ReviewLineStats>> {
  const lineStats =
    headSha == null
      ? new Map<string, ReviewLineStats>()
      : parseNumstatZ(
          await runGitAllowFailure(pi, repoRoot, [
            "diff",
            "--find-renames",
            "-M",
            "--numstat",
            "-z",
            "HEAD",
            "--",
          ]),
        );

  for (const change of worktreeChanges) {
    if (change.status !== "added" || change.newPath == null || lineStats.has(change.newPath)) {
      continue;
    }
    const content = await getWorkingTreeContent(repoRoot, change.newPath);
    lineStats.set(change.newPath, {
      addedLines: countLines(content),
      deletedLines: 0,
      originalLineCount: 0,
      modifiedLineCount: countLines(content),
      originalByteCount: 0,
      modifiedByteCount: Buffer.byteLength(content, "utf8"),
    });
  }

  return lineStats;
}

async function buildAggregateItem(
  pi: ExtensionAPI,
  repoRoot: string,
  baseRevision: string | null,
  itemId: string,
  aggregateChanges: ChangedPath[],
): Promise<ReviewItem> {
  const lineStats =
    baseRevision == null
      ? new Map<string, ReviewLineStats>()
      : parseNumstatZ(
          await runGitAllowFailure(pi, repoRoot, [
            "diff",
            "--find-renames",
            "-M",
            "--numstat",
            "-z",
            baseRevision,
            "--",
          ]),
        );

  for (const change of aggregateChanges) {
    if (change.status !== "added" || change.newPath == null || lineStats.has(change.newPath)) {
      continue;
    }
    const content = await getWorkingTreeContent(repoRoot, change.newPath);
    lineStats.set(change.newPath, {
      addedLines: countLines(content),
      deletedLines: 0,
      originalLineCount: 0,
      modifiedLineCount: countLines(content),
      originalByteCount: 0,
      modifiedByteCount: Buffer.byteLength(content, "utf8"),
    });
  }

  const files = await Promise.all(
    aggregateChanges.map(async (change) => {
      const path = change.newPath ?? change.oldPath ?? toDisplayPath(change);
      const comparison = toComparison(change);
      const rawLineStats = lineStats.get(path) ?? null;
      const lineCounts = await resolveContentMetrics(
        comparison.oldPath == null || baseRevision == null
          ? Promise.resolve("")
          : getRevisionContent(pi, repoRoot, baseRevision, comparison.oldPath),
        comparison.newPath == null
          ? Promise.resolve("")
          : getWorkingTreeContent(repoRoot, comparison.newPath),
      );
      return toReviewItemFile(
        itemId,
        path,
        change.isGenerated,
        comparison,
        change.newPath != null,
        rawLineStats == null ? null : { ...rawLineStats, ...lineCounts },
      );
    }),
  );
  files.sort(compareReviewItemFiles);
  const totals = sumItemLineStats(files);

  return {
    id: itemId,
    kind: "aggregate",
    commitSha: null,
    shortSha: null,
    baseRevision,
    title: "All changes",
    subtitle: "Combined diff across stack",
    description: null,
    authorName: null,
    authoredAt: null,
    coAuthors: [],
    addedLines: totals.addedLines,
    deletedLines: totals.deletedLines,
    originalLineCount: totals.originalLineCount,
    modifiedLineCount: totals.modifiedLineCount,
    files,
  };
}

async function buildWorkingTreeItem(
  pi: ExtensionAPI,
  repoRoot: string,
  headSha: string | null,
  itemId: string,
  worktreeChanges: ChangedPath[],
): Promise<ReviewItem> {
  const lineStats = await getWorkingTreeItemLineStats(pi, repoRoot, headSha, worktreeChanges);
  const files = await Promise.all(
    worktreeChanges.map(async (change) => {
      const path = change.newPath ?? change.oldPath ?? toDisplayPath(change);
      const comparison = toComparison(change);
      const rawLineStats = lineStats.get(path) ?? null;
      const lineCounts = await resolveContentMetrics(
        comparison.oldPath == null || headSha == null
          ? Promise.resolve("")
          : getRevisionContent(pi, repoRoot, "HEAD", comparison.oldPath),
        comparison.newPath == null
          ? Promise.resolve("")
          : getWorkingTreeContent(repoRoot, comparison.newPath),
      );
      return toReviewItemFile(
        itemId,
        path,
        change.isGenerated,
        comparison,
        change.newPath != null,
        rawLineStats == null ? null : { ...rawLineStats, ...lineCounts },
      );
    }),
  );
  files.sort(compareReviewItemFiles);
  const totals = sumItemLineStats(files);

  return {
    id: itemId,
    kind: "working-tree",
    commitSha: null,
    shortSha: null,
    baseRevision: null,
    title: "Working tree",
    subtitle: "Uncommitted changes at review start",
    description: null,
    authorName: null,
    authoredAt: null,
    coAuthors: [],
    addedLines: totals.addedLines,
    deletedLines: totals.deletedLines,
    originalLineCount: totals.originalLineCount,
    modifiedLineCount: totals.modifiedLineCount,
    files,
  };
}

async function buildReviewSnapshot(
  pi: ExtensionAPI,
  repoRoot: string,
  headSha: string | null,
  branchDiffBaseRef: string | null,
  branchDiffBaseRevision: string | null,
  worktreeChanges: ChangedPath[],
  aggregateChanges: ChangedPath[],
  generatedPaths: Set<string>,
): Promise<ReviewSnapshot> {
  const items: ReviewItem[] = [];

  if (aggregateChanges.length > 0) {
    items.push(
      await buildAggregateItem(
        pi,
        repoRoot,
        branchDiffBaseRevision,
        "all-changes",
        aggregateChanges,
      ),
    );
  }

  if (headSha != null && branchDiffBaseRevision != null) {
    const commitShas = await listLinearCommitShas(pi, repoRoot, branchDiffBaseRevision, headSha);
    for (const sha of commitShas) {
      const metadata = await getCommitReviewMetadata(pi, repoRoot, sha);
      const itemId = `commit:${metadata.sha}`;
      const files = await getCommitItemFiles(pi, repoRoot, itemId, metadata.sha, generatedPaths);
      const totals = sumItemLineStats(files);
      items.push({
        id: itemId,
        kind: "commit",
        commitSha: metadata.sha,
        shortSha: metadata.shortSha,
        baseRevision: null,
        title: metadata.subject,
        subtitle: `${metadata.shortSha}`,
        description: metadata.description,
        authorName: metadata.authorName,
        authoredAt: metadata.authoredAt,
        coAuthors: metadata.coAuthors,
        addedLines: totals.addedLines,
        deletedLines: totals.deletedLines,
        originalLineCount: totals.originalLineCount,
        modifiedLineCount: totals.modifiedLineCount,
        files,
      });
    }
  }

  if (worktreeChanges.length > 0) {
    items.push(await buildWorkingTreeItem(pi, repoRoot, headSha, "working-tree", worktreeChanges));
  }

  return {
    metadata: {
      baseRef: branchDiffBaseRef,
      mergeBaseSha: branchDiffBaseRevision,
      headSha,
      workingTreeIncluded: worktreeChanges.length > 0,
    },
    items,
  };
}

async function collectReviewData(pi: ExtensionAPI, cwd: string): Promise<CollectedReviewData> {
  const repoRoot = await getRepoRoot(pi, cwd);
  const branchName = await getCurrentBranchName(pi, repoRoot);
  const headSha = await getHeadSha(pi, repoRoot);
  const repositoryHasHead = headSha != null;
  const branchDiffBase = repositoryHasHead ? await resolveBranchDiffBase(pi, repoRoot) : null;

  const trackedDiffOutput = repositoryHasHead
    ? await runGit(pi, repoRoot, ["diff", "--find-renames", "-M", "--name-status", "HEAD", "--"])
    : "";
  const untrackedOutput = await runGitAllowFailure(pi, repoRoot, [
    "ls-files",
    "--others",
    "--exclude-standard",
  ]);
  const trackedFilesOutput = await runGitAllowFailure(pi, repoRoot, ["ls-files", "--cached"]);
  const deletedFilesOutput = await runGitAllowFailure(pi, repoRoot, ["ls-files", "--deleted"]);
  const branchDiffOutput = branchDiffBase
    ? await runGitAllowFailure(pi, repoRoot, [
        "diff",
        "--find-renames",
        "-M",
        "--name-status",
        `${branchDiffBase.mergeBase}..HEAD`,
        "--",
      ])
    : "";
  const lastCommitOutput = repositoryHasHead
    ? await runGitAllowFailure(pi, repoRoot, [
        "diff-tree",
        "--root",
        "--find-renames",
        "-M",
        "--name-status",
        "--no-commit-id",
        "-r",
        "HEAD",
      ])
    : "";

  const rawWorktreeChanges = mergeChangedPaths(
    parseNameStatus(trackedDiffOutput),
    parseUntrackedPaths(untrackedOutput),
  ).filter((change) => isReviewableFilePath(change.newPath ?? change.oldPath ?? ""));
  const deletedPaths = new Set(parseTrackedPaths(deletedFilesOutput));
  const currentPaths = uniquePaths([
    ...parseTrackedPaths(trackedFilesOutput),
    ...parseTrackedPaths(untrackedOutput),
  ])
    .filter((path) => !deletedPaths.has(path))
    .filter(isReviewableFilePath);
  const rawBranchDiffChanges = parseNameStatus(branchDiffOutput).filter((change) =>
    isReviewableFilePath(change.newPath ?? change.oldPath ?? ""),
  );
  const aggregateTrackedOutput = branchDiffBase?.mergeBase
    ? await runGitAllowFailure(pi, repoRoot, [
        "diff",
        "--find-renames",
        "-M",
        "--name-status",
        branchDiffBase.mergeBase,
        "--",
      ])
    : "";
  const rawAggregateChanges = (
    branchDiffBase?.mergeBase
      ? mergeChangedPaths(
          parseNameStatus(aggregateTrackedOutput),
          parseUntrackedPaths(untrackedOutput),
        )
      : rawWorktreeChanges
  ).filter((change) => isReviewableFilePath(change.newPath ?? change.oldPath ?? ""));
  const rawLastCommitChanges = parseNameStatus(lastCommitOutput).filter((change) =>
    isReviewableFilePath(change.newPath ?? change.oldPath ?? ""),
  );
  const generatedPaths = await getGeneratedFilePaths(pi, repoRoot, [
    ...currentPaths,
    ...rawWorktreeChanges.flatMap(changedPathAttributePaths),
    ...rawBranchDiffChanges.flatMap(changedPathAttributePaths),
    ...rawAggregateChanges.flatMap(changedPathAttributePaths),
    ...rawLastCommitChanges.flatMap(changedPathAttributePaths),
  ]);
  const currentGeneratedPaths = new Set(currentPaths.filter((path) => generatedPaths.has(path)));
  const worktreeChanges = annotateGeneratedChanges(rawWorktreeChanges, generatedPaths);
  const branchDiffChanges = annotateGeneratedChanges(rawBranchDiffChanges, generatedPaths);
  const aggregateChanges = annotateGeneratedChanges(rawAggregateChanges, generatedPaths);
  const lastCommitChanges = annotateGeneratedChanges(rawLastCommitChanges, generatedPaths);

  return {
    repoRoot,
    branchName,
    headSha,
    branchDiffBaseRef: branchDiffBase?.baseRef ?? null,
    branchDiffBaseRevision: branchDiffBase?.mergeBase ?? null,
    worktreeChanges,
    currentPaths,
    currentGeneratedPaths,
    generatedPaths,
    aggregateChanges,
    branchDiffChanges,
    lastCommitChanges,
  };
}

async function getRevisionContent(
  pi: ExtensionAPI,
  repoRoot: string,
  revision: string,
  path: string,
): Promise<string> {
  const result = await pi.exec("git", ["show", `${revision}:${path}`], { cwd: repoRoot });
  if (result.code !== 0) {
    return "";
  }
  return result.stdout;
}

async function getWorkingTreeContent(repoRoot: string, path: string): Promise<string> {
  try {
    return await readFile(join(repoRoot, path), "utf8");
  } catch {
    return "";
  }
}

function isReviewableFilePath(path: string): boolean {
  const lowerPath = path.toLowerCase();
  const fileName = lowerPath.split("/").pop() ?? lowerPath;
  const extension = extname(fileName);

  if (fileName.length === 0) return false;

  const binaryExtensions = new Set([
    ".7z",
    ".a",
    ".avi",
    ".avif",
    ".bin",
    ".bmp",
    ".class",
    ".dll",
    ".dylib",
    ".eot",
    ".exe",
    ".gif",
    ".gz",
    ".ico",
    ".jar",
    ".jpeg",
    ".jpg",
    ".lockb",
    ".map",
    ".mov",
    ".mp3",
    ".mp4",
    ".o",
    ".otf",
    ".pdf",
    ".png",
    ".pyc",
    ".so",
    ".svgz",
    ".tar",
    ".ttf",
    ".wasm",
    ".webm",
    ".webp",
    ".woff",
    ".woff2",
    ".zip",
  ]);

  if (binaryExtensions.has(extension)) return false;
  if (fileName.endsWith(".min.js") || fileName.endsWith(".min.css")) return false;

  return true;
}

function compareReviewFiles(a: ReviewFile, b: ReviewFile): number {
  return a.path.localeCompare(b.path);
}

async function resolveBaseBranchRef(pi: ExtensionAPI, repoRoot: string): Promise<string | null> {
  const remoteHead = await runGitAllowFailure(pi, repoRoot, [
    "symbolic-ref",
    "refs/remotes/origin/HEAD",
  ]);
  const candidates = [
    remoteHead.trim(),
    "refs/remotes/origin/main",
    "refs/remotes/origin/master",
    "origin/main",
    "origin/master",
    "main",
    "master",
  ].filter(
    (value, index, self): value is string => value.length > 0 && self.indexOf(value) === index,
  );

  for (const candidate of candidates) {
    const resolved = await runGitAllowFailure(pi, repoRoot, ["rev-parse", "--verify", candidate]);
    if (resolved.trim().length > 0) {
      return candidate;
    }
  }

  return null;
}

async function resolveBranchDiffBase(
  pi: ExtensionAPI,
  repoRoot: string,
): Promise<{ baseRef: string; mergeBase: string } | null> {
  const baseRef = await resolveBaseBranchRef(pi, repoRoot);
  if (baseRef == null) {
    return null;
  }

  const mergeBase = await runGitAllowFailure(pi, repoRoot, ["merge-base", "HEAD", baseRef]);
  const trimmedMergeBase = mergeBase.trim();
  if (trimmedMergeBase.length === 0) {
    return null;
  }

  return { baseRef, mergeBase: trimmedMergeBase };
}

function upsertSeed(
  seeds: Map<string, ReviewFileSeed>,
  key: string,
  create: () => ReviewFileSeed,
): ReviewFileSeed {
  const existing = seeds.get(key);
  if (existing != null) return existing;
  const seed = create();
  seeds.set(key, seed);
  return seed;
}

export async function getReviewWindowData(
  pi: ExtensionAPI,
  cwd: string,
): Promise<{
  repoRoot: string;
  branchName: string | null;
  branchDiffBaseRef: string | null;
  branchDiffBaseRevision: string | null;
  files: ReviewFile[];
  snapshot: ReviewSnapshot;
}> {
  const data = await collectReviewData(pi, cwd);

  const seeds = new Map<string, ReviewFileSeed>();

  for (const path of data.currentPaths) {
    seeds.set(path, {
      path,
      isGenerated: data.currentGeneratedPaths.has(path),
      worktreeStatus: null,
      hasWorkingTreeFile: true,
      inGitDiff: false,
      inBranchDiff: false,
      inLastCommit: false,
      gitDiff: null,
      branchDiff: null,
      lastCommit: null,
    });
  }

  for (const change of data.worktreeChanges) {
    const key = change.newPath ?? change.oldPath ?? toDisplayPath(change);
    const seed = upsertSeed(seeds, key, () => ({
      path: key,
      isGenerated: change.isGenerated,
      worktreeStatus: null,
      hasWorkingTreeFile: change.newPath != null,
      inGitDiff: false,
      inBranchDiff: false,
      inLastCommit: false,
      gitDiff: null,
      branchDiff: null,
      lastCommit: null,
    }));
    seed.isGenerated = seed.isGenerated || change.isGenerated;
    seed.worktreeStatus = change.status;
    seed.hasWorkingTreeFile = change.newPath != null;
    seed.inGitDiff = true;
    seed.gitDiff = toComparison(change);
  }

  for (const change of data.branchDiffChanges) {
    const key = change.newPath ?? change.oldPath ?? toDisplayPath(change);
    const seed = upsertSeed(seeds, key, () => ({
      path: key,
      isGenerated: change.isGenerated,
      worktreeStatus: null,
      hasWorkingTreeFile: change.newPath != null && data.currentPaths.includes(change.newPath),
      inGitDiff: false,
      inBranchDiff: false,
      inLastCommit: false,
      gitDiff: null,
      branchDiff: null,
      lastCommit: null,
    }));
    seed.isGenerated = seed.isGenerated || change.isGenerated;
    seed.inBranchDiff = true;
    seed.branchDiff = toComparison(change);
  }

  for (const change of data.lastCommitChanges) {
    const key = change.newPath ?? change.oldPath ?? toDisplayPath(change);
    const seed = upsertSeed(seeds, key, () => ({
      path: key,
      isGenerated: change.isGenerated,
      worktreeStatus: null,
      hasWorkingTreeFile: change.newPath != null && data.currentPaths.includes(change.newPath),
      inGitDiff: false,
      inBranchDiff: false,
      inLastCommit: false,
      gitDiff: null,
      branchDiff: null,
      lastCommit: null,
    }));
    seed.isGenerated = seed.isGenerated || change.isGenerated;
    seed.inLastCommit = true;
    seed.lastCommit = toComparison(change);
  }

  const files = [...seeds.values()].map(createReviewFile).sort(compareReviewFiles);
  const snapshot = await buildReviewSnapshot(
    pi,
    data.repoRoot,
    data.headSha,
    data.branchDiffBaseRef,
    data.branchDiffBaseRevision,
    data.worktreeChanges,
    data.aggregateChanges,
    data.generatedPaths,
  );

  return {
    repoRoot: data.repoRoot,
    branchName: data.branchName,
    branchDiffBaseRef: data.branchDiffBaseRef,
    branchDiffBaseRevision: data.branchDiffBaseRevision,
    files,
    snapshot,
  };
}

export async function loadReviewFileContents(
  pi: ExtensionAPI,
  repoRoot: string,
  file: ReviewFile,
  scope: ReviewScope,
  branchDiffBaseRevision: string | null = null,
): Promise<ReviewFileContents> {
  if (scope === "all-files") {
    const content = file.hasWorkingTreeFile ? await getWorkingTreeContent(repoRoot, file.path) : "";
    return {
      originalContent: content,
      modifiedContent: content,
    };
  }

  const comparison =
    scope === "git-diff"
      ? file.gitDiff
      : scope === "branch-diff"
        ? file.branchDiff
        : file.lastCommit;
  if (comparison == null) {
    return {
      originalContent: "",
      modifiedContent: "",
    };
  }

  const originalRevision =
    scope === "git-diff" ? "HEAD" : scope === "branch-diff" ? branchDiffBaseRevision : "HEAD^";
  const modifiedRevision = scope === "git-diff" ? null : "HEAD";

  const originalContent =
    comparison.oldPath == null || originalRevision == null
      ? ""
      : await getRevisionContent(pi, repoRoot, originalRevision, comparison.oldPath);
  const modifiedContent =
    comparison.newPath == null
      ? ""
      : modifiedRevision == null
        ? await getWorkingTreeContent(repoRoot, comparison.newPath)
        : await getRevisionContent(pi, repoRoot, modifiedRevision, comparison.newPath);

  return {
    originalContent,
    modifiedContent,
  };
}

async function getParentRevision(
  pi: ExtensionAPI,
  repoRoot: string,
  commitSha: string,
): Promise<string | null> {
  const output = await runGitAllowFailure(pi, repoRoot, [
    "rev-list",
    "--parents",
    "-n",
    "1",
    commitSha,
  ]);
  const parts = output
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0);
  if (parts.length <= 1) {
    return null;
  }
  return parts[1] ?? null;
}

export async function loadReviewItemFileContents(
  pi: ExtensionAPI,
  repoRoot: string,
  item: ReviewItem,
  file: ReviewItemFile,
): Promise<ReviewFileContents> {
  const comparison = file.comparison;

  if (item.kind === "aggregate") {
    const originalContent =
      comparison.oldPath == null || item.baseRevision == null
        ? ""
        : await getRevisionContent(pi, repoRoot, item.baseRevision, comparison.oldPath);
    const modifiedContent =
      comparison.newPath == null ? "" : await getWorkingTreeContent(repoRoot, comparison.newPath);
    return { originalContent, modifiedContent };
  }

  if (item.kind === "working-tree") {
    const originalContent =
      comparison.oldPath == null
        ? ""
        : await getRevisionContent(pi, repoRoot, "HEAD", comparison.oldPath);
    const modifiedContent =
      comparison.newPath == null ? "" : await getWorkingTreeContent(repoRoot, comparison.newPath);
    return { originalContent, modifiedContent };
  }

  if (item.commitSha == null) {
    return { originalContent: "", modifiedContent: "" };
  }

  const parentRevision = await getParentRevision(pi, repoRoot, item.commitSha);
  const originalContent =
    comparison.oldPath == null || parentRevision == null
      ? ""
      : await getRevisionContent(pi, repoRoot, parentRevision, comparison.oldPath);
  const modifiedContent =
    comparison.newPath == null
      ? ""
      : await getRevisionContent(pi, repoRoot, item.commitSha, comparison.newPath);

  return { originalContent, modifiedContent };
}
