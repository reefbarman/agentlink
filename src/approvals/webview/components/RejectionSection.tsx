import { useState, useRef, useEffect } from "preact/hooks";

interface RejectionSectionProps {
  onSubmit: (reason?: string) => void;
  onCancel: () => void;
}

export function RejectionSection({ onSubmit, onCancel }: RejectionSectionProps) {
  const [reason, setReason] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div class="expandable">
      <div class="expandable-title">Rejection Reason (optional)</div>
      <div class="field">
        <textarea
          ref={inputRef}
          class="text-input textarea"
          rows={3}
          value={reason}
          onInput={(e) => setReason((e.target as HTMLTextAreaElement).value)}
          placeholder="Why is this being rejected?"
          onKeyDown={(e) => {
            if (e.key === "Escape") onCancel();
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSubmit(reason || undefined);
            }
          }}
        />
      </div>
      <div class="button-row">
        <button class="btn btn-danger" onClick={() => onSubmit(reason || undefined)}>
          Reject
        </button>
        <button class="btn btn-outline" onClick={() => onSubmit()}>
          Skip Reason
        </button>
        <button class="btn btn-outline" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
