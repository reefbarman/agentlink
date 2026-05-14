import { useEffect, useMemo, useState } from "preact/hooks";

import type { ContentBlock } from "../types";

type PairingCodeData = ContentBlock & { type: "pairing_code" };

interface PairingCodeBlockProps {
  block: PairingCodeData;
}

function formatCountdown(remainingMs: number): string {
  if (remainingMs <= 0) return "0:00";
  const totalSeconds = Math.ceil(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function formatCode(code: string): string {
  if (code.length !== 6) return code;
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}

export function PairingCodeBlock({ block }: PairingCodeBlockProps) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (block.status !== "pending") return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [block.status]);

  const remainingMs = Math.max(0, block.expiresAt - now);
  const countdown = formatCountdown(remainingMs);

  const statusIconClass = useMemo(() => {
    switch (block.status) {
      case "consumed":
        return "codicon-pass-filled";
      case "expired":
      case "cancelled":
        return "codicon-circle-slash";
      default:
        return "codicon-device-mobile";
    }
  }, [block.status]);

  const statusClass = useMemo(() => {
    switch (block.status) {
      case "consumed":
        return "tool-success";
      case "expired":
      case "cancelled":
        return "tool-warning";
      default:
        return "tool-running";
    }
  }, [block.status]);

  const primaryUrl = block.pairingUrls[0] ?? "";
  const fallbackUrls = block.pairingUrls.slice(1);
  const isPending = block.status === "pending" && remainingMs > 0;
  const displayStatus = remainingMs <= 0 && block.status === "pending"
    ? "expired"
    : block.status;

  return (
    <div class={`tool-call-block ${statusClass} pairing-code-block`}>
      <div class="tool-call-header" style={{ cursor: "default" }}>
        <i class={`codicon tool-call-status-icon ${statusIconClass}`} />
        <span class="tool-call-name">pair device</span>
        <span class="tool-call-summary">
          {displayStatus === "consumed"
            ? `paired: ${block.deviceLabel ?? "device"}`
            : displayStatus === "expired"
              ? "code expired"
              : displayStatus === "cancelled"
                ? "cancelled"
                : `expires in ${countdown}`}
        </span>
      </div>

      {isPending && (
        <div class="tool-call-details">
          <div class="pairing-code-body">
            <div class="pairing-code-digits">{formatCode(block.code)}</div>
            <div class="pairing-code-instructions">
              Open this URL on the device you want to pair, then enter the code:
            </div>
            <div class="pairing-code-url-primary">
              <a href={primaryUrl} target="_blank" rel="noreferrer">
                {primaryUrl}
              </a>
            </div>
            {fallbackUrls.length > 0 && (
              <details class="pairing-code-fallback">
                <summary>Other URLs to try</summary>
                <ul>
                  {fallbackUrls.map((url) => (
                    <li key={url}>
                      <a href={url} target="_blank" rel="noreferrer">
                        {url}
                      </a>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
