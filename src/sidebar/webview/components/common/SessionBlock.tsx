import type { ComponentChildren } from "preact";

interface Props {
  sessionId: string;
  clientName?: string;
  clientVersion?: string;
  agentId?: string;
  children: ComponentChildren;
}

export function SessionBlock({
  sessionId,
  clientName,
  clientVersion,
  agentId,
  children,
}: Props) {
  const shortId =
    sessionId.length > 12 ? sessionId.substring(0, 12) + "..." : sessionId;

  const displayName = agentId
    ? (clientName ?? agentId) +
      (clientVersion ? ` v${clientVersion}` : "")
    : clientName
      ? clientName + (clientVersion ? ` v${clientVersion}` : "")
      : `Session ${shortId}`;

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
