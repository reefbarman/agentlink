/**
 * Transient feedback for file-path link clicks.
 *
 * Opening a file is a fire-and-forget request from the webview to the host, so
 * when the host can't open the target (file missing, unresolvable path) the
 * click would otherwise look dead. Click sites record the clicked anchor here;
 * when the host reports a failure the surface resolves it back through this
 * module, which shows a short-lived popup over that anchor.
 *
 * Kept as a module-level registry (not a callback contract) so no data has to
 * be plumbed through the many component seams between the click site and the
 * surface's message listener.
 */

export type OpenFileError = "not_found" | "open_failed";

const RECENT_CLICK_MS = 10_000;
const FEEDBACK_VISIBLE_MS = 2_200;
const FEEDBACK_FADE_MS = 200;
const MAX_PENDING_REQUESTS = 32;

interface RecordedClick {
  element: HTMLElement;
  path: string;
  at: number;
}

let lastClick: RecordedClick | null = null;
const pendingRequests = new Map<string, { path: string }>();
let activePopup: HTMLElement | null = null;
let activePopupTimers: number[] = [];

/** Remember the most recently clicked file link so failures can anchor to it. */
export function recordFileLinkClick(element: HTMLElement, path: string): void {
  lastClick = { element, path, at: Date.now() };
}

/** Track an in-flight open-file request so its result can be correlated. */
export function trackOpenFileRequest(requestId: string, path: string): void {
  pendingRequests.set(requestId, { path });
  if (pendingRequests.size > MAX_PENDING_REQUESTS) {
    const oldest = pendingRequests.keys().next().value;
    if (oldest !== undefined) pendingRequests.delete(oldest);
  }
}

/** Resolve a tracked request; failures surface as a popup over the link. */
export function resolveOpenFileRequest(
  requestId: string,
  ok: boolean,
  error?: OpenFileError,
): void {
  const entry = pendingRequests.get(requestId);
  pendingRequests.delete(requestId);
  if (!entry || ok) return;
  showFileOpenFailure(entry.path, error);
}

export function fileOpenFailureMessage(error?: OpenFileError): string {
  return error === "not_found" ? "File not found" : "Couldn't open this file";
}

/**
 * Show a transient failure popup over the most recently clicked link for
 * `path`. Returns false when no matching recent link is available to anchor to
 * (callers may fall back to their own status surface).
 */
export function showFileOpenFailure(
  path: string,
  error?: OpenFileError,
): boolean {
  const click = lastClick;
  if (
    !click ||
    click.path !== path ||
    Date.now() - click.at > RECENT_CLICK_MS ||
    !click.element.isConnected
  ) {
    return false;
  }

  dismissActivePopup();

  const popup = document.createElement("div");
  popup.className = "file-link-open-feedback";
  popup.setAttribute("role", "status");
  popup.textContent = fileOpenFailureMessage(error);
  document.body.appendChild(popup);

  const anchorRect = click.element.getBoundingClientRect();
  const popupRect = popup.getBoundingClientRect();
  const left = Math.max(
    4,
    Math.min(
      anchorRect.left + anchorRect.width / 2 - popupRect.width / 2,
      window.innerWidth - popupRect.width - 4,
    ),
  );
  const above = anchorRect.top - popupRect.height - 6;
  popup.style.left = `${left}px`;
  popup.style.top = `${above < 4 ? anchorRect.bottom + 6 : above}px`;

  const raf =
    typeof requestAnimationFrame === "function"
      ? requestAnimationFrame
      : (cb: FrameRequestCallback) => window.setTimeout(() => cb(0), 0);
  raf(() => popup.classList.add("visible"));

  activePopup = popup;
  activePopupTimers = [
    window.setTimeout(() => {
      popup.classList.remove("visible");
    }, FEEDBACK_VISIBLE_MS),
    window.setTimeout(() => {
      if (activePopup === popup) {
        activePopup = null;
        activePopupTimers = [];
      }
      popup.remove();
    }, FEEDBACK_VISIBLE_MS + FEEDBACK_FADE_MS),
  ];
  return true;
}

function dismissActivePopup(): void {
  if (!activePopup) return;
  for (const timer of activePopupTimers) window.clearTimeout(timer);
  activePopup.remove();
  activePopup = null;
  activePopupTimers = [];
}

/** Test-only: clear module state between test cases. */
export function resetFileLinkFeedbackForTests(): void {
  dismissActivePopup();
  lastClick = null;
  pendingRequests.clear();
}
