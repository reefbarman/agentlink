import { useState, useCallback, useRef, useEffect } from "preact/hooks";

interface CheckpointRowProps {
  checkpointId: string;
  sessionId: string | null;
  onRevert: (sessionId: string, checkpointId: string) => void;
  onViewDiff?: (
    sessionId: string,
    checkpointId: string,
    scope: "turn" | "all",
  ) => void;
}

/**
 * Full-width separator row shown after each user message that has a checkpoint.
 * Modelled on Roo Code's CheckpointSaved design:
 *   [git-commit icon] Checkpoint ─────── gradient line ────── [actions on hover]
 */
export function CheckpointRow({
  checkpointId,
  sessionId,
  onRevert,
  onViewDiff,
}: CheckpointRowProps) {
  const [isHovering, setIsHovering] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [menuClosing, setMenuClosing] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Visible while hovering, menu open, or briefly after menu closes (prevents jump)
  const actionsVisible = isHovering || menuOpen || menuClosing;

  useEffect(() => {
    return () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    };
  }, []);

  const handleMenuOpen = useCallback(() => {
    setMenuOpen(true);
    setMenuClosing(false);
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  const handleMenuClose = useCallback(() => {
    setMenuOpen(false);
    setConfirming(false);
    setMenuClosing(true);
    closeTimer.current = setTimeout(() => {
      setMenuClosing(false);
      closeTimer.current = null;
    }, 200);
  }, []);

  // Close menu when clicking outside
  useEffect(() => {
    if (!menuOpen) return;
    const onOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        handleMenuClose();
      }
    };
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [menuOpen, handleMenuClose]);

  const handleRestore = useCallback(() => {
    if (!sessionId) return;
    onRevert(sessionId, checkpointId);
    handleMenuClose();
  }, [sessionId, checkpointId, onRevert, handleMenuClose]);

  const handleViewTurnDiff = useCallback(() => {
    if (!sessionId || !onViewDiff) return;
    onViewDiff(sessionId, checkpointId, "turn");
  }, [sessionId, checkpointId, onViewDiff]);

  const handleViewAllDiff = useCallback(() => {
    if (!sessionId || !onViewDiff) return;
    onViewDiff(sessionId, checkpointId, "all");
  }, [sessionId, checkpointId, onViewDiff]);

  return (
    <div
      class="checkpoint-row"
      onMouseEnter={() => setIsHovering(true)}
      onMouseLeave={() => setIsHovering(false)}
    >
      {/* Left: icon + label */}
      <div class="checkpoint-row-label">
        <i class="codicon codicon-git-commit checkpoint-row-icon" />
        <span>Checkpoint</span>
      </div>

      {/* Center: gradient line */}
      <span class="checkpoint-row-line" aria-hidden="true" />

      {/* Right: action buttons (revealed on hover) */}
      <div
        class={`checkpoint-row-actions${actionsVisible ? " visible" : ""}`}
        ref={menuRef}
      >
        {/* View turn diff */}
        {onViewDiff && (
          <button
            class="checkpoint-action-btn"
            title="View changes since last checkpoint"
            onClick={handleViewTurnDiff}
          >
            <i class="codicon codicon-diff" />
          </button>
        )}

        {/* View all diff */}
        {onViewDiff && (
          <button
            class="checkpoint-action-btn"
            title="View all changes since session start"
            onClick={handleViewAllDiff}
          >
            <i class="codicon codicon-diff-multiple" />
          </button>
        )}

        {/* Restore button */}
        <button
          class="checkpoint-action-btn"
          title="Restore to this checkpoint"
          onClick={menuOpen ? handleMenuClose : handleMenuOpen}
          aria-expanded={menuOpen}
        >
          <i class="codicon codicon-history" />
        </button>

        {/* Inline restore popover */}
        {(menuOpen || menuClosing) && (
          <div class={`checkpoint-popover${menuClosing ? " closing" : ""}`}>
            {!confirming ? (
              <>
                <p class="checkpoint-popover-desc">
                  Restore workspace files and conversation to this point.
                </p>
                <button
                  class="checkpoint-popover-btn checkpoint-popover-btn-primary"
                  onClick={() => setConfirming(true)}
                >
                  Restore files &amp; conversation
                </button>
              </>
            ) : (
              <>
                <p class="checkpoint-popover-warning">
                  This cannot be undone. Workspace files and all messages after
                  this point will be permanently removed.
                </p>
                <div class="checkpoint-popover-confirm-row">
                  <button
                    class="checkpoint-popover-btn checkpoint-popover-btn-danger"
                    onClick={handleRestore}
                  >
                    <i class="codicon codicon-check" />
                    Confirm
                  </button>
                  <button
                    class="checkpoint-popover-btn"
                    onClick={() => setConfirming(false)}
                  >
                    <i class="codicon codicon-close" />
                    Cancel
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
