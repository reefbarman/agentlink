interface AttachmentChipProps {
  path: string;
  onRemove: (path: string) => void;
}

export function AttachmentChip({ path, onRemove }: AttachmentChipProps) {
  const parts = path.split("/");
  const name = parts.pop()!;

  return (
    <span class="attachment-chip" title={path}>
      <i class="codicon codicon-file" />
      <span class="attachment-chip-name">{name}</span>
      <button
        class="attachment-chip-remove"
        onClick={() => onRemove(path)}
        title="Remove"
        type="button"
      >
        <i class="codicon codicon-close" />
      </button>
    </span>
  );
}
