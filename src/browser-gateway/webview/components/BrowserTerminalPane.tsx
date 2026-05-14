import { useEffect, useMemo, useRef, useState } from "preact/hooks";

import type { TerminalBuffer } from "../../../shared/terminalActivity";
import { TerminalInstanceList } from "./TerminalInstanceList";
import { TerminalViewport } from "./TerminalViewport";

interface BrowserTerminalPaneProps {
  buffers: TerminalBuffer[];
  sessionId?: string | null;
  showInstanceList?: boolean;
}

function chooseInitialBuffer(buffers: TerminalBuffer[]): string {
  const running = [...buffers]
    .reverse()
    .find((buffer) => buffer.lastStatus === "running");
  return running?.id ?? buffers.at(-1)?.id ?? "terminal:default";
}

export function BrowserTerminalPane({
  buffers,
  sessionId,
  showInstanceList = true,
}: BrowserTerminalPaneProps) {
  const [selectedBufferId, setSelectedBufferId] = useState(() =>
    chooseInitialBuffer(buffers),
  );
  const knownBufferIdsRef = useRef(new Set(buffers.map((buffer) => buffer.id)));
  const previousSessionIdRef = useRef(sessionId);
  const selectedBuffer = useMemo(
    () =>
      buffers.find((buffer) => buffer.id === selectedBufferId) ??
      buffers.find((buffer) => buffer.lastStatus === "running") ??
      buffers.at(-1) ??
      buffers[0],
    [buffers, selectedBufferId],
  );

  useEffect(() => {
    const currentIds = new Set(buffers.map((buffer) => buffer.id));
    const sessionChanged = previousSessionIdRef.current !== sessionId;
    const addedBuffers = buffers.filter(
      (buffer) => !knownBufferIdsRef.current.has(buffer.id),
    );

    previousSessionIdRef.current = sessionId;
    knownBufferIdsRef.current = currentIds;

    if (sessionChanged) {
      setSelectedBufferId(chooseInitialBuffer(buffers));
      return;
    }

    const newestAdded = addedBuffers.at(-1);
    if (newestAdded) {
      setSelectedBufferId(newestAdded.id);
      return;
    }

    if (!currentIds.has(selectedBufferId)) {
      setSelectedBufferId(chooseInitialBuffer(buffers));
    }
  }, [buffers, selectedBufferId, sessionId]);

  if (!selectedBuffer) return null;

  return (
    <div class="browser-terminal-shell">
      <TerminalViewport buffer={selectedBuffer} sessionId={sessionId} />
      {showInstanceList && (
        <TerminalInstanceList
          buffers={buffers}
          selectedBufferId={selectedBuffer.id}
          onSelectBuffer={setSelectedBufferId}
        />
      )}
    </div>
  );
}
