import { useCallback, useState } from "preact/hooks";

import {
  createMcpElicitationInitialValues,
  validateAndCoerceMcpElicitationValues,
  type McpElicitationFieldErrors,
  type McpElicitationValues,
  type McpFormElicitationRequest,
} from "@agentlink/protocol/mcp-elicitation";
import { McpElicitationFormControls } from "../../../shared/ui/McpElicitationFormControls";

interface ElicitationModalProps {
  request: McpFormElicitationRequest;
  onSubmit: (id: string, values: McpElicitationValues) => void;
  onCancel: (id: string) => void;
}

export function ElicitationModal({
  request,
  onSubmit,
  onCancel,
}: ElicitationModalProps) {
  const [values, setValues] = useState<McpElicitationValues>(() =>
    createMcpElicitationInitialValues(request.fields),
  );
  const [errors, setErrors] = useState<McpElicitationFieldErrors>({});

  const handleChange = useCallback((name: string, value: unknown) => {
    setValues((current) => ({ ...current, [name]: value }));
  }, []);

  const handleSubmit = useCallback(() => {
    const result = validateAndCoerceMcpElicitationValues(
      request.fields,
      values,
    );
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }

    setErrors({});
    onSubmit(request.id, result.values);
  }, [onSubmit, request.fields, request.id, values]);

  return (
    <div class="elicit-overlay">
      <form
        class="elicit-modal"
        aria-label={`${request.serverName} form request`}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          handleSubmit();
        }}
      >
        <div class="elicit-header">
          <i class="codicon codicon-server" />
          <span class="elicit-server">{request.serverName}</span>
        </div>
        <p class="elicit-message">{request.message}</p>
        <McpElicitationFormControls
          fields={request.fields}
          values={values}
          errors={errors}
          idPrefix={`mcp-form-${request.id}`}
          onChange={handleChange}
        />
        <div class="elicit-actions">
          <button
            class="elicit-btn elicit-btn-cancel"
            onClick={() => onCancel(request.id)}
            type="button"
          >
            Cancel
          </button>
          <button class="elicit-btn elicit-btn-submit" type="submit">
            Submit
          </button>
        </div>
      </form>
    </div>
  );
}
