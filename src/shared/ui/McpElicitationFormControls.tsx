import type {
  McpElicitationField,
  McpElicitationFieldErrors,
  McpElicitationMultiSelectField,
  McpElicitationStringField,
  McpElicitationValues,
} from "../mcpElicitation.js";

export interface McpElicitationFormControlsProps {
  fields: readonly McpElicitationField[];
  values: Readonly<McpElicitationValues>;
  errors?: Readonly<McpElicitationFieldErrors>;
  disabled?: boolean;
  idPrefix?: string;
  onChange: (name: string, value: unknown) => void;
}

export function McpElicitationFormControls({
  fields,
  values,
  errors = {},
  disabled = false,
  idPrefix = "mcp-elicitation",
  onChange,
}: McpElicitationFormControlsProps) {
  return (
    <div class="mcp-elicitation-fields">
      {fields.map((field, index) => (
        <McpElicitationFormControl
          key={field.name}
          field={field}
          value={getOwnValue(values, field.name)}
          error={getOwnValue(errors, field.name)}
          disabled={disabled}
          inputId={`${idPrefix}-${index}`}
          onChange={(value) => onChange(field.name, value)}
        />
      ))}
    </div>
  );
}

function getOwnValue<T extends Record<string, unknown>>(
  record: Readonly<T>,
  name: string,
): T[string] | undefined {
  return Object.prototype.hasOwnProperty.call(record, name)
    ? (record[name] as T[string])
    : undefined;
}

interface McpElicitationFormControlProps {
  field: McpElicitationField;
  value: unknown;
  error?: string;
  disabled: boolean;
  inputId: string;
  onChange: (value: unknown) => void;
}

function McpElicitationFormControl({
  field,
  value,
  error,
  disabled,
  inputId,
  onChange,
}: McpElicitationFormControlProps) {
  const descriptionId = field.description
    ? `${inputId}-description`
    : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  const describedBy =
    [descriptionId, errorId].filter(Boolean).join(" ") || undefined;
  const label = field.title ?? field.name;

  return (
    <div class="mcp-elicitation-field">
      <label class="mcp-elicitation-label" for={inputId}>
        {label}
        {field.required && (
          <span class="mcp-elicitation-required" aria-hidden="true">
            *
          </span>
        )}
      </label>
      {field.description && (
        <p id={descriptionId} class="mcp-elicitation-description">
          {field.description}
        </p>
      )}
      {renderControl(field, value, {
        id: inputId,
        disabled,
        describedBy,
        invalid: Boolean(error),
        onChange,
      })}
      {error && (
        <p id={errorId} class="mcp-elicitation-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

interface ControlProps {
  id: string;
  disabled: boolean;
  describedBy?: string;
  invalid: boolean;
  onChange: (value: unknown) => void;
}

function renderControl(
  field: McpElicitationField,
  value: unknown,
  props: ControlProps,
) {
  const accessibilityProps = {
    id: props.id,
    disabled: props.disabled,
    "aria-describedby": props.describedBy,
    "aria-invalid": props.invalid || undefined,
    "aria-required": field.required || undefined,
  };

  switch (field.kind) {
    case "boolean":
      return (
        <input
          {...accessibilityProps}
          class="mcp-elicitation-checkbox"
          type="checkbox"
          checked={value === true}
          onInput={(event) => props.onChange(event.currentTarget.checked)}
        />
      );
    case "single-select":
      return (
        <select
          {...accessibilityProps}
          class="mcp-elicitation-select"
          value={typeof value === "string" ? value : ""}
          onInput={(event) => props.onChange(event.currentTarget.value)}
        >
          <option value="">— Select —</option>
          {field.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.title ?? option.value}
            </option>
          ))}
        </select>
      );
    case "multi-select":
      return renderMultiSelect(field, value, props, accessibilityProps);
    case "number":
    case "integer":
      return (
        <input
          {...accessibilityProps}
          class="mcp-elicitation-input"
          type="number"
          value={
            typeof value === "number" || typeof value === "string" ? value : ""
          }
          min={field.minimum}
          max={field.maximum}
          step={field.kind === "integer" ? 1 : "any"}
          onInput={(event) => props.onChange(event.currentTarget.value)}
        />
      );
    case "string":
      return (
        <input
          {...accessibilityProps}
          class="mcp-elicitation-input"
          type={inputTypeForStringField(field)}
          value={typeof value === "string" ? value : ""}
          minLength={field.minLength}
          maxLength={field.maxLength}
          onInput={(event) => props.onChange(event.currentTarget.value)}
        />
      );
  }
}

function renderMultiSelect(
  field: McpElicitationMultiSelectField,
  value: unknown,
  props: ControlProps,
  accessibilityProps: Record<string, unknown>,
) {
  const selected = Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];

  return (
    <select
      {...accessibilityProps}
      class="mcp-elicitation-select"
      multiple
      size={Math.min(Math.max(field.options.length, 2), 8)}
      onInput={(event) => {
        const values = Array.from(event.currentTarget.selectedOptions).map(
          (option) => option.value,
        );
        props.onChange(values);
      }}
    >
      {field.options.map((option) => (
        <option
          key={option.value}
          value={option.value}
          selected={selected.includes(option.value)}
        >
          {option.title ?? option.value}
        </option>
      ))}
    </select>
  );
}

function inputTypeForStringField(field: McpElicitationStringField): string {
  switch (field.format) {
    case "email":
      return "email";
    case "uri":
      return "url";
    case "date":
      return "date";
    case "date-time":
    default:
      return "text";
  }
}
