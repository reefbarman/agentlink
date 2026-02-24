import type { ComponentChildren } from "preact";

interface Props {
  sessionId: string;
  children: ComponentChildren;
}

export function SessionBlock({ sessionId, children }: Props) {
  const shortId =
    sessionId.length > 12 ? sessionId.substring(0, 12) + "..." : sessionId;

  return (
    <div class="session-block">
      <div class="info-row">
        <span class="label" title={sessionId}>
          Session {shortId}
        </span>
      </div>
      {children}
    </div>
  );
}
