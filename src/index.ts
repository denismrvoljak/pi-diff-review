import { existsSync } from "node:fs";
import { basename, resolve as resolvePath } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@mariozechner/pi-tui";
import { open, type GlimpseWindow } from "glimpseui";
import { getRepoRoot, getReviewWindowData, loadReviewItemFileContents } from "./git.js";
import { composeReviewPrompt } from "./prompt.js";
import type {
  ReviewCancelPayload,
  ReviewFileContents,
  ReviewHostMessage,
  ReviewRequestFilePayload,
  ReviewSubmitPayload,
  ReviewWindowMessage,
} from "./types.js";
import { buildReviewHtml } from "./ui.js";

function isSubmitPayload(value: ReviewWindowMessage): value is ReviewSubmitPayload {
  return value.type === "submit";
}

function isCancelPayload(value: ReviewWindowMessage): value is ReviewCancelPayload {
  return value.type === "cancel";
}

function isRequestFilePayload(value: ReviewWindowMessage): value is ReviewRequestFilePayload {
  return value.type === "request-file";
}

type WaitingEditorResult = "escape" | "window-settled";

interface ReviewTarget {
  repoRoot: string;
  label: string;
}

function escapeForInlineScript(value: string): string {
  return value.replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

function usageText(): string {
  return "Usage: /diff-review [path:<repo-or-folder>|<repo-or-folder>]";
}

function parsePathTarget(args: string): string | null {
  const trimmed = args.trim();
  if (trimmed.length === 0) return null;
  return trimmed.startsWith("path:") ? trimmed.slice("path:".length).trim() : trimmed;
}

async function resolveReviewTarget(
  pi: ExtensionAPI,
  cwd: string,
  args: string,
): Promise<ReviewTarget | { error: string }> {
  const pathTarget = parsePathTarget(args);
  if (pathTarget == null) {
    try {
      const repoRoot = await getRepoRoot(pi, cwd);
      return { repoRoot, label: basename(repoRoot) || repoRoot };
    } catch {
      return { error: "Not inside a git repository. " + usageText() };
    }
  }

  if (pathTarget.length === 0) {
    return { error: usageText() };
  }

  const candidatePath = resolvePath(cwd, pathTarget);
  if (!existsSync(candidatePath)) {
    return { error: `Path does not exist: ${candidatePath}` };
  }

  try {
    const repoRoot = await getRepoRoot(pi, candidatePath);
    return { repoRoot, label: basename(repoRoot) || repoRoot };
  } catch {
    return { error: `Path is not inside a git repository: ${candidatePath}` };
  }
}

export default function (pi: ExtensionAPI) {
  let activeWindow: GlimpseWindow | null = null;
  let activeWaitingUIDismiss: (() => void) | null = null;

  function closeActiveWindow(): void {
    if (activeWindow == null) return;
    const windowToClose = activeWindow;
    activeWindow = null;
    try {
      windowToClose.close();
    } catch {}
  }

  function showWaitingUI(ctx: ExtensionCommandContext): {
    promise: Promise<WaitingEditorResult>;
    dismiss: () => void;
  } {
    let settled = false;
    let doneFn: ((result: WaitingEditorResult) => void) | null = null;
    let pendingResult: WaitingEditorResult | null = null;

    const finish = (result: WaitingEditorResult): void => {
      if (settled) return;
      settled = true;
      if (activeWaitingUIDismiss === dismiss) {
        activeWaitingUIDismiss = null;
      }
      if (doneFn != null) {
        doneFn(result);
      } else {
        pendingResult = result;
      }
    };

    const promise = ctx.ui.custom<WaitingEditorResult>((_tui, theme, _kb, done) => {
      doneFn = done;
      if (pendingResult != null) {
        const result = pendingResult;
        pendingResult = null;
        queueMicrotask(() => done(result));
      }

      return {
        render(width: number): string[] {
          const innerWidth = Math.max(24, width - 2);
          const borderTop = theme.fg("border", `╭${"─".repeat(innerWidth)}╮`);
          const borderBottom = theme.fg("border", `╰${"─".repeat(innerWidth)}╯`);
          const lines = [
            theme.fg("accent", theme.bold("Waiting for review")),
            "The native review window is open.",
            "Press Escape to cancel and close the review window.",
          ];
          return [
            borderTop,
            ...lines.map(
              (line) =>
                `${theme.fg("border", "│")}${truncateToWidth(line, innerWidth, "...", true).padEnd(innerWidth, " ")}${theme.fg("border", "│")}`,
            ),
            borderBottom,
          ];
        },
        handleInput(data: string): void {
          if (matchesKey(data, Key.escape)) {
            finish("escape");
          }
        },
        invalidate(): void {},
      };
    });

    const dismiss = (): void => {
      finish("window-settled");
    };

    activeWaitingUIDismiss = dismiss;

    return {
      promise,
      dismiss,
    };
  }

  async function reviewRepository(
    ctx: ExtensionCommandContext,
    target: ReviewTarget,
  ): Promise<void> {
    if (activeWindow != null) {
      ctx.ui.notify("A review window is already open.", "warning");
      return;
    }

    const { repoRoot, branchName, snapshot } = await getReviewWindowData(pi, target.repoRoot);
    if (snapshot.items.length === 0 || snapshot.items.every((item) => item.files.length === 0)) {
      ctx.ui.notify("No reviewable files found.", "info");
      return;
    }

    const html = buildReviewHtml({
      repoLabel: target.label,
      repoRoot,
      branchName,
      snapshot,
    });
    const window = open(html, {
      width: 1680,
      height: 1020,
      title: `pi diff review — ${target.label}`,
    });
    activeWindow = window;

    const waitingUI = showWaitingUI(ctx);
    const itemFileMap = new Map(
      snapshot.items.flatMap((item) => item.files.map((file) => [file.id, { item, file }])),
    );
    const contentCache = new Map<string, Promise<ReviewFileContents>>();

    const sendWindowMessage = (message: ReviewHostMessage): void => {
      if (activeWindow !== window) return;
      const payload = escapeForInlineScript(JSON.stringify(message));
      window.send(`window.__reviewReceive(${payload});`);
    };

    const loadContents = (fileId: string): Promise<ReviewFileContents> => {
      const cached = contentCache.get(fileId);
      if (cached != null) return cached;

      const entry = itemFileMap.get(fileId);
      if (entry == null) {
        return Promise.reject(new Error("Unknown file requested."));
      }

      const pending = loadReviewItemFileContents(pi, repoRoot, entry.item, entry.file);
      contentCache.set(fileId, pending);
      return pending;
    };

    ctx.ui.notify(`Opened native review window for ${target.label}.`, "info");

    try {
      const terminalMessagePromise = new Promise<ReviewSubmitPayload | ReviewCancelPayload | null>(
        (resolve, reject) => {
          let settled = false;

          const cleanup = (): void => {
            window.removeListener("message", onMessage);
            window.removeListener("closed", onClosed);
            window.removeListener("error", onError);
            if (activeWindow === window) {
              activeWindow = null;
            }
          };

          const settle = (value: ReviewSubmitPayload | ReviewCancelPayload | null): void => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(value);
          };

          const handleRequestFile = async (message: ReviewRequestFilePayload): Promise<void> => {
            try {
              const contents = await loadContents(message.fileId);
              sendWindowMessage({
                type: "file-data",
                requestId: message.requestId,
                fileId: message.fileId,
                originalContent: contents.originalContent,
                modifiedContent: contents.modifiedContent,
              });
            } catch (error) {
              const messageText = error instanceof Error ? error.message : String(error);
              sendWindowMessage({
                type: "file-error",
                requestId: message.requestId,
                fileId: message.fileId,
                message: messageText,
              });
            }
          };

          const onMessage = (data: unknown): void => {
            const message = data as ReviewWindowMessage;
            if (isRequestFilePayload(message)) {
              void handleRequestFile(message);
              return;
            }
            if (isSubmitPayload(message) || isCancelPayload(message)) {
              settle(message);
            }
          };

          const onClosed = (): void => {
            settle(null);
          };

          const onError = (error: Error): void => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(error);
          };

          window.on("message", onMessage);
          window.on("closed", onClosed);
          window.on("error", onError);
        },
      );

      const result = await Promise.race([
        terminalMessagePromise.then((message) => ({ type: "window" as const, message })),
        waitingUI.promise.then((reason) => ({ type: "ui" as const, reason })),
      ]);

      if (result.type === "ui" && result.reason === "escape") {
        closeActiveWindow();
        await terminalMessagePromise.catch(() => null);
        ctx.ui.notify("Review cancelled.", "info");
        return;
      }

      const message = result.type === "window" ? result.message : await terminalMessagePromise;

      waitingUI.dismiss();
      await waitingUI.promise;
      closeActiveWindow();

      if (message == null || message.type === "cancel") {
        ctx.ui.notify("Review cancelled.", "info");
        return;
      }

      const prompt = composeReviewPrompt(snapshot, message);
      if (prompt.length === 0) {
        ctx.ui.notify("No review feedback entered; editor left unchanged.", "info");
        return;
      }
      ctx.ui.setEditorText(prompt);
      ctx.ui.notify("Inserted review feedback into the editor.", "info");
    } catch (error) {
      activeWaitingUIDismiss?.();
      closeActiveWindow();
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Review failed: ${message}`, "error");
    }
  }

  pi.registerCommand("diff-review", {
    description: "Open a native stack-aware diff review window",
    handler: async (args, ctx) => {
      const target = await resolveReviewTarget(pi, ctx.cwd, args);
      if ("error" in target) {
        ctx.ui.notify(target.error, "warning");
        return;
      }
      await reviewRepository(ctx, target);
    },
  });

  pi.on("session_shutdown", async () => {
    activeWaitingUIDismiss?.();
    closeActiveWindow();
  });
}
