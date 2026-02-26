import type { FindReplaceMatch } from "../types.js";

interface DiffBlockProps {
  match: FindReplaceMatch;
  isAccepted: boolean;
  onToggle: (matchId: string) => void;
}

export function DiffBlock({ match, isAccepted, onToggle }: DiffBlockProps) {
  return (
    <div class={`fr-diff-block ${isAccepted ? "" : "fr-rejected"}`}>
      <div class="fr-diff-header">
        <button
          class={`fr-toggle-btn ${isAccepted ? "fr-accepted" : "fr-excluded"}`}
          onClick={() => onToggle(match.id)}
          title={isAccepted ? "Exclude this change" : "Include this change"}
        >
          <span
            class={`codicon ${isAccepted ? "codicon-check" : "codicon-close"}`}
          />
          {isAccepted ? "Included" : "Excluded"}
        </button>
        <span class="fr-line-label">Line {match.line}</span>
      </div>
      <div class="fr-diff-code">
        {/* Context lines before */}
        {match.contextBefore.map((ln) => (
          <div class="fr-code-line" key={`before-${ln.lineNumber}`}>
            <span class="fr-line-num">{ln.lineNumber}</span>
            <span class="fr-line-text">{ln.text}</span>
          </div>
        ))}
        {/* Old line — deletion */}
        <div class="fr-code-line fr-deletion">
          <span class="fr-line-num">{match.matchLine.lineNumber}</span>
          <span class="fr-line-text">
            {match.matchLine.text.slice(0, match.columnStart)}
            <span class="fr-match-old">{match.matchText}</span>
            {match.matchLine.text.slice(match.columnEnd)}
          </span>
        </div>
        {/* New line — insertion */}
        <div class="fr-code-line fr-insertion">
          <span class="fr-line-num">{match.matchLine.lineNumber}</span>
          <span class="fr-line-text">
            {match.matchLine.text.slice(0, match.columnStart)}
            <span class="fr-match-new">{match.replaceText}</span>
            {match.matchLine.text.slice(match.columnEnd)}
          </span>
        </div>
        {/* Context lines after */}
        {match.contextAfter.map((ln) => (
          <div class="fr-code-line" key={`after-${ln.lineNumber}`}>
            <span class="fr-line-num">{ln.lineNumber}</span>
            <span class="fr-line-text">{ln.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
