export const MAX_MCP_ELICITATION_FIELDS = 100;
export const MAX_MCP_ELICITATION_OPTIONS = 200;
export const MAX_MCP_ELICITATION_FIELD_NAME_LENGTH = 256;
export const MAX_MCP_ELICITATION_OPTION_VALUE_LENGTH = 2_048;
export const MAX_MCP_ELICITATION_STRING_VALUE_LENGTH = 100_000;
export const MAX_MCP_ELICITATION_TITLE_LENGTH = 500;
export const MAX_MCP_ELICITATION_DESCRIPTION_LENGTH = 4_000;

export type McpElicitationStringFormat = "email" | "uri" | "date" | "date-time";

export interface McpElicitationOption {
  value: string;
  title?: string;
}

interface McpElicitationFieldBase {
  name: string;
  title?: string;
  description?: string;
  required: boolean;
}

export interface McpElicitationStringField extends McpElicitationFieldBase {
  kind: "string";
  default?: string;
  format?: McpElicitationStringFormat;
  minLength?: number;
  maxLength?: number;
}

export interface McpElicitationNumberField extends McpElicitationFieldBase {
  kind: "number";
  default?: number;
  minimum?: number;
  maximum?: number;
}

export interface McpElicitationIntegerField extends McpElicitationFieldBase {
  kind: "integer";
  default?: number;
  minimum?: number;
  maximum?: number;
}

export interface McpElicitationBooleanField extends McpElicitationFieldBase {
  kind: "boolean";
  default?: boolean;
}

export interface McpElicitationSingleSelectField extends McpElicitationFieldBase {
  kind: "single-select";
  default?: string;
  options: McpElicitationOption[];
}

export interface McpElicitationMultiSelectField extends McpElicitationFieldBase {
  kind: "multi-select";
  default?: string[];
  options: McpElicitationOption[];
  minItems?: number;
  maxItems?: number;
}

export type McpElicitationField =
  | McpElicitationStringField
  | McpElicitationNumberField
  | McpElicitationIntegerField
  | McpElicitationBooleanField
  | McpElicitationSingleSelectField
  | McpElicitationMultiSelectField;

export interface McpElicitationFormSchema {
  fields: McpElicitationField[];
}

export interface McpFormElicitationRequest {
  id: string;
  serverName: string;
  message: string;
  fields: McpElicitationField[];
}

export type McpFormElicitationInput = Omit<McpFormElicitationRequest, "id">;

export type McpFormElicitationResponse =
  | { id: string; action: "accept"; values: McpElicitationValues }
  | { id: string; action: "cancel" | "decline" };

export type McpElicitationValues = Record<string, unknown>;
export type McpElicitationFieldErrors = Record<string, string>;

export type McpElicitationSchemaNormalizationResult =
  | { ok: true; schema: McpElicitationFormSchema }
  | { ok: false; error: string };

export type McpElicitationValidationResult =
  | { ok: true; values: McpElicitationValues }
  | { ok: false; errors: McpElicitationFieldErrors };

class NormalizationError extends Error {}

export function normalizeMcpElicitationSchema(
  requestedSchema: unknown,
): McpElicitationSchemaNormalizationResult {
  try {
    const schema = requireRecord(requestedSchema, "Requested schema");
    if (schema.type !== "object") {
      throw new NormalizationError('Requested schema must have type "object".');
    }

    const properties = requireRecord(
      schema.properties,
      "Requested schema properties",
    );
    const entries = Object.entries(properties);
    if (entries.length > MAX_MCP_ELICITATION_FIELDS) {
      throw new NormalizationError(
        `Requested schema exceeds the ${MAX_MCP_ELICITATION_FIELDS}-field limit.`,
      );
    }

    const propertyNames = new Set(entries.map(([name]) => name));
    const required = normalizeRequired(schema.required, propertyNames);
    const fields = entries.map(([name, definition]) =>
      normalizeField(name, definition, required.has(name)),
    );

    return { ok: true, schema: { fields } };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof NormalizationError
          ? error.message
          : "Requested schema could not be normalized.",
    };
  }
}

export function createMcpElicitationInitialValues(
  fields: readonly McpElicitationField[],
): McpElicitationValues {
  const values: McpElicitationValues = Object.create(
    null,
  ) as McpElicitationValues;

  for (const field of fields) {
    if (field.default !== undefined) {
      values[field.name] = Array.isArray(field.default)
        ? [...field.default]
        : field.default;
      continue;
    }

    switch (field.kind) {
      case "boolean":
        values[field.name] = false;
        break;
      case "multi-select":
        values[field.name] = [];
        break;
      case "string":
      case "number":
      case "integer":
      case "single-select":
        values[field.name] = "";
        break;
    }
  }

  return values;
}

export function validateAndCoerceMcpElicitationValues(
  fields: readonly McpElicitationField[],
  input: Readonly<McpElicitationValues>,
): McpElicitationValidationResult {
  const values: McpElicitationValues = Object.create(
    null,
  ) as McpElicitationValues;
  const errors: McpElicitationFieldErrors = Object.create(
    null,
  ) as McpElicitationFieldErrors;

  for (const field of fields) {
    const inputValue = Object.prototype.hasOwnProperty.call(input, field.name)
      ? input[field.name]
      : undefined;
    const result = validateAndCoerceField(field, inputValue);
    if (result.ok) {
      if (result.present) values[field.name] = result.value;
    } else {
      errors[field.name] = result.error;
    }
  }

  return Object.keys(errors).length > 0
    ? { ok: false, errors }
    : { ok: true, values };
}

type FieldValidationResult =
  | { ok: true; present: false }
  | { ok: true; present: true; value: string | number | boolean | string[] }
  | { ok: false; error: string };

function normalizeField(
  name: string,
  value: unknown,
  required: boolean,
): McpElicitationField {
  validateBoundedString(
    name,
    `Property name`,
    MAX_MCP_ELICITATION_FIELD_NAME_LENGTH,
    false,
  );
  const definition = requireRecord(value, `Field "${name}"`);
  const common = {
    name,
    required,
    ...optionalTextProperties(definition, name),
  };

  if (definition.type === "array") {
    const options = normalizeMultiSelectOptions(definition, name);
    const field: McpElicitationMultiSelectField = {
      ...common,
      kind: "multi-select",
      options,
      ...optionalItemConstraints(definition, name),
      ...optionalMultiDefault(definition, name),
    };
    validateConstraintOrder(field.minItems, field.maxItems, name, "item");
    if (field.minItems !== undefined && field.minItems > options.length) {
      throw new NormalizationError(
        `Field "${name}" requires more selections than it provides options.`,
      );
    }
    validateNormalizedDefault(field);
    return field;
  }

  if (definition.type === "boolean") {
    const field: McpElicitationBooleanField = {
      ...common,
      kind: "boolean",
      ...optionalBooleanDefault(definition, name),
    };
    validateNormalizedDefault(field);
    return field;
  }

  if (definition.type === "number" || definition.type === "integer") {
    const constraints = optionalNumericConstraints(definition, name);
    validateConstraintOrder(
      constraints.minimum,
      constraints.maximum,
      name,
      "numeric",
    );
    const defaultValue = optionalNumberDefault(definition, name);
    const field: McpElicitationNumberField | McpElicitationIntegerField = {
      ...common,
      kind: definition.type,
      ...constraints,
      ...defaultValue,
    };
    validateNormalizedDefault(field);
    return field;
  }

  if (definition.type !== "string") {
    throw new NormalizationError(`Field "${name}" has an unsupported type.`);
  }

  if (Array.isArray(definition.enum) || Array.isArray(definition.oneOf)) {
    const options = normalizeSingleSelectOptions(definition, name);
    const field: McpElicitationSingleSelectField = {
      ...common,
      kind: "single-select",
      options,
      ...optionalStringDefault(definition, name),
    };
    validateNormalizedDefault(field);
    return field;
  }

  const constraints = optionalStringConstraints(definition, name);
  validateConstraintOrder(
    constraints.minLength,
    constraints.maxLength,
    name,
    "length",
  );
  const field: McpElicitationStringField = {
    ...common,
    kind: "string",
    ...constraints,
    ...optionalStringDefault(definition, name),
  };
  validateNormalizedDefault(field);
  return field;
}

function normalizeRequired(
  value: unknown,
  propertyNames: ReadonlySet<string>,
): Set<string> {
  if (value === undefined) return new Set();
  if (!Array.isArray(value)) {
    throw new NormalizationError("Requested schema required must be an array.");
  }
  if (value.length > MAX_MCP_ELICITATION_FIELDS) {
    throw new NormalizationError(
      `Requested schema required exceeds the ${MAX_MCP_ELICITATION_FIELDS}-field limit.`,
    );
  }

  const required = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string" || !propertyNames.has(entry)) {
      throw new NormalizationError(
        "Requested schema required contains an unknown property.",
      );
    }
    if (required.has(entry)) {
      throw new NormalizationError(
        "Requested schema required contains a duplicate property.",
      );
    }
    required.add(entry);
  }
  return required;
}

function normalizeSingleSelectOptions(
  definition: Record<string, unknown>,
  name: string,
): McpElicitationOption[] {
  if (Array.isArray(definition.oneOf)) {
    return normalizeTitledOptions(definition.oneOf, name, "oneOf");
  }

  const values = normalizeOptionValues(definition.enum, name);
  if (definition.enumNames === undefined) {
    return values.map((value) => ({ value }));
  }
  if (
    !Array.isArray(definition.enumNames) ||
    definition.enumNames.length !== values.length
  ) {
    throw new NormalizationError(
      `Field "${name}" has invalid legacy enumNames.`,
    );
  }

  const titles = definition.enumNames as unknown[];
  return values.map((value, index) => {
    const title = titles[index];
    if (typeof title !== "string") {
      throw new NormalizationError(
        `Field "${name}" has a non-string enum title.`,
      );
    }
    validateBoundedString(
      title,
      `Field "${name}" option title`,
      MAX_MCP_ELICITATION_TITLE_LENGTH,
      true,
    );
    return { value, title };
  });
}

function normalizeMultiSelectOptions(
  definition: Record<string, unknown>,
  name: string,
): McpElicitationOption[] {
  const items = requireRecord(definition.items, `Field "${name}" items`);
  if (Array.isArray(items.anyOf)) {
    return normalizeTitledOptions(items.anyOf, name, "items.anyOf");
  }
  if (items.type !== "string") {
    throw new NormalizationError(
      `Field "${name}" multi-select items must have type "string".`,
    );
  }
  return normalizeOptionValues(items.enum, name).map((value) => ({ value }));
}

function normalizeTitledOptions(
  input: unknown[],
  name: string,
  source: string,
): McpElicitationOption[] {
  assertOptionCount(input, name);
  const options = input.map((entry) => {
    const option = requireRecord(entry, `Field "${name}" ${source} option`);
    if (typeof option.const !== "string" || typeof option.title !== "string") {
      throw new NormalizationError(
        `Field "${name}" has an invalid titled option.`,
      );
    }
    validateBoundedString(
      option.const,
      `Field "${name}" option value`,
      MAX_MCP_ELICITATION_OPTION_VALUE_LENGTH,
      false,
    );
    validateBoundedString(
      option.title,
      `Field "${name}" option title`,
      MAX_MCP_ELICITATION_TITLE_LENGTH,
      true,
    );
    return { value: option.const, title: option.title };
  });
  assertUniqueOptions(options, name);
  return options;
}

function normalizeOptionValues(value: unknown, name: string): string[] {
  if (!Array.isArray(value)) {
    throw new NormalizationError(`Field "${name}" options must be an array.`);
  }
  assertOptionCount(value, name);
  const values = value.map((option) => {
    if (typeof option !== "string") {
      throw new NormalizationError(`Field "${name}" has a non-string option.`);
    }
    validateBoundedString(
      option,
      `Field "${name}" option value`,
      MAX_MCP_ELICITATION_OPTION_VALUE_LENGTH,
      false,
    );
    return option;
  });
  assertUniqueOptions(
    values.map((option) => ({ value: option })),
    name,
  );
  return values;
}

function assertOptionCount(options: unknown[], name: string): void {
  if (options.length === 0) {
    throw new NormalizationError(`Field "${name}" must provide an option.`);
  }
  if (options.length > MAX_MCP_ELICITATION_OPTIONS) {
    throw new NormalizationError(
      `Field "${name}" exceeds the ${MAX_MCP_ELICITATION_OPTIONS}-option limit.`,
    );
  }
}

function assertUniqueOptions(
  options: readonly McpElicitationOption[],
  name: string,
): void {
  if (new Set(options.map((option) => option.value)).size !== options.length) {
    throw new NormalizationError(
      `Field "${name}" contains duplicate option values.`,
    );
  }
}

function optionalTextProperties(
  definition: Record<string, unknown>,
  name: string,
): { title?: string; description?: string } {
  const result: { title?: string; description?: string } = {};
  if (definition.title !== undefined) {
    if (typeof definition.title !== "string") {
      throw new NormalizationError(`Field "${name}" has an invalid title.`);
    }
    validateBoundedString(
      definition.title,
      `Field "${name}" title`,
      MAX_MCP_ELICITATION_TITLE_LENGTH,
      true,
    );
    result.title = definition.title;
  }
  if (definition.description !== undefined) {
    if (typeof definition.description !== "string") {
      throw new NormalizationError(
        `Field "${name}" has an invalid description.`,
      );
    }
    validateBoundedString(
      definition.description,
      `Field "${name}" description`,
      MAX_MCP_ELICITATION_DESCRIPTION_LENGTH,
      true,
    );
    result.description = definition.description;
  }
  return result;
}

function optionalStringConstraints(
  definition: Record<string, unknown>,
  name: string,
): Pick<McpElicitationStringField, "minLength" | "maxLength" | "format"> {
  const result: Pick<
    McpElicitationStringField,
    "minLength" | "maxLength" | "format"
  > = {};
  if (definition.minLength !== undefined) {
    result.minLength = requireBoundedLength(
      definition.minLength,
      name,
      "minLength",
    );
  }
  if (definition.maxLength !== undefined) {
    result.maxLength = requireBoundedLength(
      definition.maxLength,
      name,
      "maxLength",
    );
  }
  if (definition.format !== undefined) {
    if (!isStringFormat(definition.format)) {
      throw new NormalizationError(`Field "${name}" has an invalid format.`);
    }
    result.format = definition.format;
  }
  return result;
}

function optionalNumericConstraints(
  definition: Record<string, unknown>,
  name: string,
): Pick<McpElicitationNumberField, "minimum" | "maximum"> {
  const result: Pick<McpElicitationNumberField, "minimum" | "maximum"> = {};
  if (definition.minimum !== undefined) {
    result.minimum = requireFiniteNumber(definition.minimum, name, "minimum");
  }
  if (definition.maximum !== undefined) {
    result.maximum = requireFiniteNumber(definition.maximum, name, "maximum");
  }
  return result;
}

function optionalItemConstraints(
  definition: Record<string, unknown>,
  name: string,
): Pick<McpElicitationMultiSelectField, "minItems" | "maxItems"> {
  const result: Pick<McpElicitationMultiSelectField, "minItems" | "maxItems"> =
    {};
  if (definition.minItems !== undefined) {
    result.minItems = requireNonNegativeInteger(
      definition.minItems,
      name,
      "minItems",
    );
  }
  if (definition.maxItems !== undefined) {
    result.maxItems = requireNonNegativeInteger(
      definition.maxItems,
      name,
      "maxItems",
    );
  }
  return result;
}

function optionalStringDefault(
  definition: Record<string, unknown>,
  name: string,
): { default?: string } {
  if (definition.default === undefined) return {};
  if (typeof definition.default !== "string") {
    throw new NormalizationError(`Field "${name}" has an invalid default.`);
  }
  validateBoundedString(
    definition.default,
    `Field "${name}" default`,
    MAX_MCP_ELICITATION_STRING_VALUE_LENGTH,
    true,
  );
  return { default: definition.default };
}

function optionalNumberDefault(
  definition: Record<string, unknown>,
  name: string,
): { default?: number } {
  if (definition.default === undefined) return {};
  return {
    default: requireFiniteNumber(definition.default, name, "default"),
  };
}

function optionalBooleanDefault(
  definition: Record<string, unknown>,
  name: string,
): { default?: boolean } {
  if (definition.default === undefined) return {};
  if (typeof definition.default !== "boolean") {
    throw new NormalizationError(`Field "${name}" has an invalid default.`);
  }
  return { default: definition.default };
}

function optionalMultiDefault(
  definition: Record<string, unknown>,
  name: string,
): { default?: string[] } {
  if (definition.default === undefined) return {};
  if (
    !Array.isArray(definition.default) ||
    definition.default.length > MAX_MCP_ELICITATION_OPTIONS ||
    definition.default.some((value) => typeof value !== "string")
  ) {
    throw new NormalizationError(`Field "${name}" has an invalid default.`);
  }
  return { default: [...definition.default] as string[] };
}

function validateNormalizedDefault(field: McpElicitationField): void {
  if (field.default === undefined) return;

  let valid = true;
  switch (field.kind) {
    case "string":
      valid =
        (!field.required || field.default.length > 0) &&
        (field.minLength === undefined ||
          field.default.length >= field.minLength) &&
        (field.maxLength === undefined ||
          field.default.length <= field.maxLength) &&
        (!field.format || matchesStringFormat(field.default, field.format));
      break;
    case "number":
    case "integer":
      valid =
        (field.kind !== "integer" || Number.isInteger(field.default)) &&
        (field.minimum === undefined || field.default >= field.minimum) &&
        (field.maximum === undefined || field.default <= field.maximum);
      break;
    case "boolean":
      break;
    case "single-select":
      valid = field.options.some((option) => option.value === field.default);
      break;
    case "multi-select": {
      const allowed = new Set(field.options.map((option) => option.value));
      valid =
        (!field.required || field.default.length > 0) &&
        new Set(field.default).size === field.default.length &&
        field.default.every((value) => allowed.has(value)) &&
        (field.minItems === undefined ||
          field.default.length >= field.minItems) &&
        (field.maxItems === undefined ||
          field.default.length <= field.maxItems);
      break;
    }
  }

  if (!valid) {
    throw new NormalizationError(
      `Field "${field.name}" has a default that violates its schema.`,
    );
  }
}

function validateAndCoerceField(
  field: McpElicitationField,
  input: unknown,
): FieldValidationResult {
  const label = field.title ?? field.name;

  if (field.kind === "boolean") {
    if (input === undefined || input === null || input === "") {
      return field.required
        ? { ok: false, error: `${label} is required.` }
        : { ok: true, present: false };
    }
    return typeof input === "boolean"
      ? { ok: true, present: true, value: input }
      : { ok: false, error: `${label} must be true or false.` };
  }

  if (field.kind === "multi-select") {
    if (!Array.isArray(input)) {
      return input === undefined || input === null || input === ""
        ? field.required
          ? { ok: false, error: `${label} is required.` }
          : { ok: true, present: false }
        : { ok: false, error: `${label} must be a list of selections.` };
    }
    if (input.some((value) => typeof value !== "string")) {
      return { ok: false, error: `${label} contains an invalid selection.` };
    }
    const selected = input as string[];
    if (selected.length === 0) {
      return field.required
        ? { ok: false, error: `${label} is required.` }
        : { ok: true, present: false };
    }
    const allowed = new Set(field.options.map((option) => option.value));
    if (
      new Set(selected).size !== selected.length ||
      selected.length > field.options.length ||
      selected.some((value) => !allowed.has(value))
    ) {
      return { ok: false, error: `${label} contains an invalid selection.` };
    }
    if (field.minItems !== undefined && selected.length < field.minItems) {
      return {
        ok: false,
        error: `${label} requires at least ${field.minItems} selection${field.minItems === 1 ? "" : "s"}.`,
      };
    }
    if (field.maxItems !== undefined && selected.length > field.maxItems) {
      return {
        ok: false,
        error: `${label} allows at most ${field.maxItems} selection${field.maxItems === 1 ? "" : "s"}.`,
      };
    }
    return { ok: true, present: true, value: [...selected] };
  }

  if (input === undefined || input === null || input === "") {
    return field.required
      ? { ok: false, error: `${label} is required.` }
      : { ok: true, present: false };
  }

  if (field.kind === "number" || field.kind === "integer") {
    if (typeof input === "string" && input.trim() === "") {
      return field.required
        ? { ok: false, error: `${label} is required.` }
        : { ok: true, present: false };
    }
    const numericInput =
      typeof input === "string"
        ? isDecimalNumber(input)
          ? input.trim()
          : Number.NaN
        : input;
    const number =
      typeof numericInput === "number" || typeof numericInput === "string"
        ? Number(numericInput)
        : Number.NaN;
    if (!Number.isFinite(number)) {
      return { ok: false, error: `${label} must be a number.` };
    }
    if (field.kind === "integer" && !Number.isInteger(number)) {
      return { ok: false, error: `${label} must be an integer.` };
    }
    if (field.minimum !== undefined && number < field.minimum) {
      return {
        ok: false,
        error: `${label} must be at least ${field.minimum}.`,
      };
    }
    if (field.maximum !== undefined && number > field.maximum) {
      return {
        ok: false,
        error: `${label} must be at most ${field.maximum}.`,
      };
    }
    return { ok: true, present: true, value: number };
  }

  if (typeof input !== "string") {
    return { ok: false, error: `${label} must be text.` };
  }

  if (field.kind === "single-select") {
    return field.options.some((option) => option.value === input)
      ? { ok: true, present: true, value: input }
      : { ok: false, error: `${label} has an invalid selection.` };
  }

  if (input.length > MAX_MCP_ELICITATION_STRING_VALUE_LENGTH) {
    return { ok: false, error: `${label} is too long.` };
  }
  if (field.minLength !== undefined && input.length < field.minLength) {
    return {
      ok: false,
      error: `${label} must be at least ${field.minLength} character${field.minLength === 1 ? "" : "s"}.`,
    };
  }
  if (field.maxLength !== undefined && input.length > field.maxLength) {
    return {
      ok: false,
      error: `${label} must be at most ${field.maxLength} character${field.maxLength === 1 ? "" : "s"}.`,
    };
  }
  if (field.format && !matchesStringFormat(input, field.format)) {
    return { ok: false, error: `${label} must be a valid ${field.format}.` };
  }
  return { ok: true, present: true, value: input };
}

function matchesStringFormat(
  value: string,
  format: McpElicitationStringFormat,
): boolean {
  switch (format) {
    case "email":
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
    case "uri":
      try {
        const uri = new URL(value);
        return uri.protocol.length > 1;
      } catch {
        return false;
      }
    case "date": {
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
      if (!match) return false;
      const year = Number(match[1]);
      const month = Number(match[2]);
      const day = Number(match[3]);
      const date = new Date(Date.UTC(year, month - 1, day));
      return (
        date.getUTCFullYear() === year &&
        date.getUTCMonth() === month - 1 &&
        date.getUTCDate() === day
      );
    }
    case "date-time":
      return (
        matchesStringFormat(value.slice(0, 10), "date") &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(
          value,
        ) &&
        !Number.isNaN(Date.parse(value))
      );
  }
}

function isDecimalNumber(value: string): boolean {
  return /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim());
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new NormalizationError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireFiniteNumber(
  value: unknown,
  name: string,
  property: string,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new NormalizationError(`Field "${name}" has an invalid ${property}.`);
  }
  return value;
}

function requireBoundedLength(
  value: unknown,
  name: string,
  property: string,
): number {
  const length = requireNonNegativeInteger(value, name, property);
  if (length > MAX_MCP_ELICITATION_STRING_VALUE_LENGTH) {
    throw new NormalizationError(`Field "${name}" has an invalid ${property}.`);
  }
  return length;
}

function requireNonNegativeInteger(
  value: unknown,
  name: string,
  property: string,
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new NormalizationError(`Field "${name}" has an invalid ${property}.`);
  }
  return value;
}

function validateConstraintOrder(
  minimum: number | undefined,
  maximum: number | undefined,
  name: string,
  kind: string,
): void {
  if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
    throw new NormalizationError(
      `Field "${name}" has inconsistent ${kind} constraints.`,
    );
  }
}

function validateBoundedString(
  value: string,
  label: string,
  maximumLength: number,
  allowEmpty: boolean,
): void {
  if ((!allowEmpty && value.length === 0) || value.length > maximumLength) {
    throw new NormalizationError(`${label} has an invalid length.`);
  }
}

function isStringFormat(value: unknown): value is McpElicitationStringFormat {
  return (
    value === "email" ||
    value === "uri" ||
    value === "date" ||
    value === "date-time"
  );
}
