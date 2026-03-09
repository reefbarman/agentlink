import { useState, useCallback } from "preact/hooks";

interface ElicitField {
  type: "string" | "number" | "boolean";
  title?: string;
  description?: string;
  enum?: string[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
}

interface ElicitationModalProps {
  id: string;
  serverName: string;
  message: string;
  fields: Record<string, ElicitField>;
  required: string[];
  onSubmit: (id: string, values: Record<string, unknown>) => void;
  onCancel: (id: string) => void;
}

export function ElicitationModal({
  id,
  serverName,
  message,
  fields,
  required,
  onSubmit,
  onCancel,
}: ElicitationModalProps) {
  const fieldEntries = Object.entries(fields);

  const initValues = () => {
    const v: Record<string, unknown> = {};
    for (const [key, field] of fieldEntries) {
      if (field.type === "boolean") v[key] = field.default ?? false;
      else if (field.type === "number") v[key] = field.default ?? "";
      else v[key] = field.default ?? "";
    }
    return v;
  };

  const [values, setValues] = useState<Record<string, unknown>>(initValues);

  const set = useCallback((key: string, val: unknown) => {
    setValues((prev) => ({ ...prev, [key]: val }));
  }, []);

  const handleSubmit = useCallback(() => {
    // Convert number fields
    const coerced: Record<string, unknown> = {};
    for (const [key, field] of fieldEntries) {
      if (field.type === "number") {
        const n = Number(values[key]);
        coerced[key] = isNaN(n) ? values[key] : n;
      } else {
        coerced[key] = values[key];
      }
    }
    onSubmit(id, coerced);
  }, [id, values, fieldEntries, onSubmit]);

  return (
    <div class="elicit-overlay">
      <div class="elicit-modal">
        <div class="elicit-header">
          <i class="codicon codicon-server" />
          <span class="elicit-server">{serverName}</span>
        </div>
        <p class="elicit-message">{message}</p>
        <div class="elicit-fields">
          {fieldEntries.map(([key, field]) => {
            const label = field.title ?? key;
            const isRequired = required.includes(key);
            return (
              <div key={key} class="elicit-field">
                <label class="elicit-label">
                  {label}
                  {isRequired && <span class="elicit-required">*</span>}
                </label>
                {field.description && (
                  <p class="elicit-field-desc">{field.description}</p>
                )}
                {field.type === "boolean" ? (
                  <input
                    type="checkbox"
                    class="elicit-checkbox"
                    checked={!!values[key]}
                    onChange={(e) =>
                      set(key, (e.target as HTMLInputElement).checked)
                    }
                  />
                ) : field.enum ? (
                  <select
                    class="elicit-select"
                    value={String(values[key] ?? "")}
                    onChange={(e) =>
                      set(key, (e.target as HTMLSelectElement).value)
                    }
                  >
                    {!isRequired && <option value="">— Select —</option>}
                    {field.enum.map((opt) => (
                      <option key={opt} value={opt}>
                        {opt}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type={field.type === "number" ? "number" : "text"}
                    class="elicit-input"
                    value={String(values[key] ?? "")}
                    min={field.minimum}
                    max={field.maximum}
                    onInput={(e) =>
                      set(key, (e.target as HTMLInputElement).value)
                    }
                  />
                )}
              </div>
            );
          })}
        </div>
        <div class="elicit-actions">
          <button
            class="elicit-btn elicit-btn-cancel"
            onClick={() => onCancel(id)}
            type="button"
          >
            Cancel
          </button>
          <button
            class="elicit-btn elicit-btn-submit"
            onClick={handleSubmit}
            type="button"
          >
            Submit
          </button>
        </div>
      </div>
    </div>
  );
}
