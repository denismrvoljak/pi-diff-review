import type {
  DiffReviewComment,
  ReviewFileNote,
  ReviewItem,
  ReviewItemNote,
  ReviewSnapshot,
  ReviewSubmitPayload,
} from "./types.js";

function shortSha(value: string | null): string {
  if (value == null || value.length === 0) return "none";
  return value.slice(0, 7);
}

function formatProvenanceHeader(snapshot: ReviewSnapshot): string[] {
  const { metadata } = snapshot;
  return [
    "Reviewed snapshot:",
    `- base: ${metadata.baseRef ?? "(none)"} @ ${shortSha(metadata.mergeBaseSha)}`,
    `- head: ${shortSha(metadata.headSha)}`,
    `- working tree: ${metadata.workingTreeIncluded ? "included" : "clean"}`,
  ];
}

function getItemLabel(item: ReviewItem): string {
  if (item.kind === "working-tree") {
    return "Working tree";
  }
  if (item.kind === "aggregate") {
    return item.title;
  }
  return `${item.title} (${item.shortSha ?? shortSha(item.commitSha)})`;
}

function formatItemHeading(index: number, item: ReviewItem): string {
  return `${index}. ${getItemLabel(item)}`;
}

function formatItemNote(note: ReviewItemNote): string {
  return `   Note: ${note.body.trim()}`;
}

function formatFileNote(note: ReviewFileNote): string {
  return `- ${note.filePath} — ${note.body.trim()}`;
}

function formatInlineComment(comment: DiffReviewComment): string {
  const sideSuffix = comment.side === "original" ? " (old)" : " (new)";
  return `   - ${comment.filePath}:${comment.lineNumber}${sideSuffix} — ${comment.body.trim()}`;
}

function buildItemMap(snapshot: ReviewSnapshot): Map<string, ReviewItem> {
  return new Map(snapshot.items.map((item) => [item.id, item]));
}

export function hasReviewFeedback(payload: ReviewSubmitPayload): boolean {
  if (payload.overallComment.trim().length > 0) return true;
  return (
    payload.itemNotes.some((note) => note.body.trim().length > 0) ||
    payload.fileNotes.some((note) => note.body.trim().length > 0) ||
    payload.comments.some((comment) => comment.body.trim().length > 0)
  );
}

export function composeReviewPrompt(
  snapshot: ReviewSnapshot,
  payload: ReviewSubmitPayload,
): string {
  if (!hasReviewFeedback(payload)) return "";

  const itemMap = buildItemMap(snapshot);
  const lines: string[] = [];

  lines.push("Review the diff-viewer feedback below.");
  lines.push(
    "Do not blindly implement every note. If feedback contains questions, ambiguity, contradictions, or anything that does not make sense, pause and close those open loops before changing code. When feedback is clear and actionable, implement the needed changes and validate them.",
  );
  lines.push("");
  lines.push(...formatProvenanceHeader(snapshot));
  lines.push("");

  const fileNotes: ReviewFileNote[] = payload.fileNotes
    .map((note) => ({ ...note, body: note.body.trim() }))
    .filter((note) => note.body.length > 0)
    .sort((a, b) => a.filePath.localeCompare(b.filePath));

  const overallComment = payload.overallComment.trim();
  if (overallComment.length > 0) {
    lines.push("Overall review note:");
    lines.push(overallComment);
    lines.push("");
  }

  if (fileNotes.length > 0) {
    lines.push("File-level notes:");
    for (const note of fileNotes) {
      lines.push(formatFileNote(note));
    }
    lines.push("");
  }

  const itemNotesById = new Map<string, ReviewItemNote>();
  for (const note of payload.itemNotes) {
    const body = note.body.trim();
    if (body.length === 0) continue;
    itemNotesById.set(note.itemId, { ...note, body });
  }

  const commentsByItemId = new Map<string, DiffReviewComment[]>();
  for (const comment of payload.comments) {
    const body = comment.body.trim();
    if (body.length === 0) continue;
    const existing = commentsByItemId.get(comment.itemId) ?? [];
    existing.push({ ...comment, body });
    commentsByItemId.set(comment.itemId, existing);
  }

  let itemIndex = 1;
  for (const item of snapshot.items) {
    const itemNote = itemNotesById.get(item.id);
    const inlineComments = commentsByItemId.get(item.id) ?? [];
    if (itemNote == null && inlineComments.length === 0) {
      continue;
    }

    lines.push(formatItemHeading(itemIndex, item));
    itemIndex += 1;

    if (itemNote != null) {
      lines.push(formatItemNote(itemNote));
    }

    for (const comment of inlineComments) {
      lines.push(formatInlineComment(comment));
    }

    lines.push("");
  }

  for (const note of payload.itemNotes) {
    if (itemMap.has(note.itemId)) continue;
    const body = note.body.trim();
    if (body.length === 0) continue;
    lines.push(`${itemIndex}. Unknown item (${note.itemId})`);
    itemIndex += 1;
    lines.push(formatItemNote({ ...note, body }));
    lines.push("");
  }

  for (const [itemId, itemComments] of commentsByItemId.entries()) {
    if (itemMap.has(itemId)) continue;
    lines.push(`${itemIndex}. Unknown item (${itemId})`);
    itemIndex += 1;
    for (const comment of itemComments) {
      lines.push(formatInlineComment(comment));
    }
    lines.push("");
  }

  return lines.join("\n").trim();
}
