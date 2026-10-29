import type { ComponentProps } from "preact";
import { FinalMarkerResult } from "./FinalMarkerResult";
import type { RemoteFinalResultDetail } from "@agentlink/protocol/chat-transcript";
import { useRemoteFinalResult } from "./RemoteToolDetail";

type RemoteFinalMarkerResultProps = Omit<
  ComponentProps<typeof FinalMarkerResult>,
  "result"
> & {
  reference: RemoteFinalResultDetail;
};

/** Loads the full browser result only when its transcript row is mounted. */
export function RemoteFinalMarkerResult({
  reference,
  ...props
}: RemoteFinalMarkerResultProps) {
  const { result, loading, error, retry } = useRemoteFinalResult(reference);
  if (error) {
    return (
      <section class="final-marker-result" aria-label="Result">
        <div role="alert">{error}</div>
        <button type="button" onClick={retry}>
          Retry result
        </button>
      </section>
    );
  }
  if (loading || !result) {
    return <div role="status">Loading result…</div>;
  }
  return <FinalMarkerResult {...props} result={result} />;
}
