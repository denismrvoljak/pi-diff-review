export type ReviewScope = "git-diff" | "branch-diff" | "last-commit" | "all-files";

export type ChangeStatus = "modified" | "added" | "deleted" | "renamed";

export interface ReviewFileComparison {
  status: ChangeStatus;
  oldPath: string | null;
  newPath: string | null;
  displayPath: string;
  hasOriginal: boolean;
  hasModified: boolean;
}

export interface ReviewFile {
  id: string;
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

export interface ReviewFileContents {
  originalContent: string;
  modifiedContent: string;
}

export type ReviewItemKind = "aggregate" | "commit" | "working-tree";

export interface ReviewLineStats {
  addedLines: number | null;
  deletedLines: number | null;
  originalLineCount: number | null;
  modifiedLineCount: number | null;
  originalByteCount: number | null;
  modifiedByteCount: number | null;
}

export interface ReviewItemFile {
  id: string;
  path: string;
  isGenerated: boolean;
  comparison: ReviewFileComparison;
  hasWorkingTreeFile: boolean;
  lineStats: ReviewLineStats | null;
}

export interface ReviewSnapshotMetadata {
  baseRef: string | null;
  mergeBaseSha: string | null;
  headSha: string | null;
  workingTreeIncluded: boolean;
}

export interface ReviewItem {
  id: string;
  kind: ReviewItemKind;
  commitSha: string | null;
  shortSha: string | null;
  baseRevision: string | null;
  title: string;
  subtitle: string;
  description: string | null;
  authorName: string | null;
  authoredAt: string | null;
  coAuthors: string[];
  addedLines: number;
  deletedLines: number;
  originalLineCount: number;
  modifiedLineCount: number;
  files: ReviewItemFile[];
}

export interface ReviewSnapshot {
  metadata: ReviewSnapshotMetadata;
  items: ReviewItem[];
}

export type ReviewCommentSide = "original" | "modified";

export interface ReviewItemNote {
  id: string;
  itemId: string;
  itemKind: ReviewItemKind;
  commitSha: string | null;
  body: string;
}

export interface DiffReviewComment {
  id: string;
  itemId: string;
  itemKind: ReviewItemKind;
  commitSha: string | null;
  filePath: string;
  side: ReviewCommentSide;
  lineNumber: number;
  body: string;
}

export interface ReviewSubmitPayload {
  type: "submit";
  overallComment: string;
  itemNotes: ReviewItemNote[];
  comments: DiffReviewComment[];
}

export interface ReviewCancelPayload {
  type: "cancel";
}

export interface ReviewRequestFilePayload {
  type: "request-file";
  requestId: string;
  fileId: string;
}

export type ReviewWindowMessage =
  | ReviewSubmitPayload
  | ReviewCancelPayload
  | ReviewRequestFilePayload;

export interface ReviewFileDataMessage {
  type: "file-data";
  requestId: string;
  fileId: string;
  originalContent: string;
  modifiedContent: string;
}

export interface ReviewFileErrorMessage {
  type: "file-error";
  requestId: string;
  fileId: string;
  message: string;
}

export type ReviewHostMessage = ReviewFileDataMessage | ReviewFileErrorMessage;

export interface ReviewWindowData {
  repoLabel: string;
  repoRoot: string;
  branchName: string | null;
  snapshot: ReviewSnapshot;
}
