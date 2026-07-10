import type { ComponentChildren } from "preact";

interface Props {
  sessionId: string;
  children: ComponentChildren;
}

export function SessionBlock({ sessionId, children }: Props) {
  const shortId =
    sessionId.length > 12 ? sessionId.substring(0, 12) + "..." : sessionId;
  const displayName = `Session ${shortId}`;

  return (
    <div class="session-block">
      <div class="info-row">
        <span class="label" title={`Session: ${sessionId}`}>
          {displayName}
        </span>
      </div>
      {children}
    </div>
  );
}
