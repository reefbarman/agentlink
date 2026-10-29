import type { FinalMessageMarker } from "@agentlink/protocol/final-status";
import type { CoreWebCitation } from "@agentlink/protocol/web-activity";
import { StreamingText } from "./StreamingText";

interface FinalMarkerResultProps {
  result: NonNullable<FinalMessageMarker["result"]>;
  summary?: string;
  citations: readonly CoreWebCitation[];
  onOpenFile?: (path: string, line?: number) => void;
  onOpenSpecialBlockPanel?: (block: {
    kind: "mermaid" | "vega" | "vega-lite";
    source: string;
  }) => void;
}

/** Render the coordinator-facing result without hiding content behind its summary. */
export function FinalMarkerResult({
  result,
  summary,
  citations,
  onOpenFile,
  onOpenSpecialBlockPanel,
}: FinalMarkerResultProps) {
  const prose = (text: string) => (
    <StreamingText
      text={text}
      streaming={false}
      citations={citations}
      onOpenFile={onOpenFile}
      onOpenSpecialBlockPanel={onOpenSpecialBlockPanel}
    />
  );
  const distinctText = (text: string) =>
    text.trim() && text.trim() !== summary?.trim() ? prose(text) : null;
  const fileLink = (path: string, line?: number) =>
    onOpenFile ? (
      <button
        class="final-marker-file-link"
        type="button"
        onClick={() => onOpenFile(path, line)}
      >
        {path}
        {line !== undefined ? `:${line}` : ""}
      </button>
    ) : (
      <code>
        {path}
        {line !== undefined ? `:${line}` : ""}
      </code>
    );

  if (result.type === "text") {
    const content = distinctText(result.text);
    return content ? (
      <section class="final-marker-result" aria-label="Result">
        <div class="final-marker-section-label">Result</div>
        {content}
      </section>
    ) : null;
  }

  return (
    <section class="final-marker-result" aria-label="Result">
      <div class="final-marker-section-label">
        {result.type === "review_findings"
          ? "Review findings"
          : result.type === "patch"
            ? "Patch result"
            : "Verification result"}
      </div>
      {result.type === "review_findings" ? (
        <>
          {result.reviewedScope && (
            <div>
              Reviewed scope: <code>{result.reviewedScope}</code>
            </div>
          )}
          {result.emptyDiff === true && (
            <div>No diff was available to review.</div>
          )}
          {!result.findings.length && result.emptyDiff !== true && (
            <div>No findings reported.</div>
          )}
          <ul class="final-marker-result-list">
            {result.findings.map((finding, index) => (
              <li key={index}>
                <strong
                  class={`final-marker-severity final-marker-severity-${finding.severity}`}
                >
                  {finding.severity}
                </strong>
                {finding.path ? (
                  <div>{fileLink(finding.path, finding.line)}</div>
                ) : finding.line !== undefined ? (
                  <div>Line {finding.line}</div>
                ) : null}
                {prose(finding.message)}
              </li>
            ))}
          </ul>
        </>
      ) : result.type === "patch" ? (
        <>
          {distinctText(result.summary)}
          <div class="final-marker-section-label">Changed files</div>
          {result.files.length ? (
            <ul class="final-marker-result-list">
              {result.files.map((path, index) => (
                <li key={index}>{fileLink(path)}</li>
              ))}
            </ul>
          ) : (
            <div>No files reported.</div>
          )}
          {result.verification && (
            <div>
              <div class="final-marker-section-label">Verification</div>
              {prose(result.verification)}
            </div>
          )}
        </>
      ) : (
        <>
          <div
            class={`final-marker-verification-${result.passed ? "passed" : "failed"}`}
          >
            {result.passed ? "Passed" : "Failed"}
          </div>
          {distinctText(result.summary)}
          {!!result.screenshots?.length && (
            <div>
              <div class="final-marker-section-label">Screenshots</div>
              <ul class="final-marker-result-list">
                {result.screenshots.map((path, index) => (
                  <li key={index}>{fileLink(path)}</li>
                ))}
              </ul>
            </div>
          )}
          {!!result.logs?.length && (
            <div>
              <div class="final-marker-section-label">Logs</div>
              {result.logs.map((log, index) => (
                <pre class="final-marker-result-log" key={index}>
                  {log}
                </pre>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
