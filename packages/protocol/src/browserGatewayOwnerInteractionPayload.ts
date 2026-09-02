import type {
  StructuredQuestionRequest as QuestionRequest,
  StructuredQuestionProgress,
} from "./structuredQuestion.js";

import type { ApprovalRequest } from "./approvalTransport.js";
import type { McpFormElicitationRequest } from "./mcpElicitation.js";
import type { McpUrlElicitationRequest } from "./mcpUrlElicitation.js";

export type BrowserGatewayOwnerQuestionProgressPayload = Omit<
  StructuredQuestionProgress,
  "answers"
> & {
  answers: Record<
    string,
    string | readonly string[] | number | boolean | undefined
  >;
};

/**
 * Full browser interaction state attached to one primary interaction summary.
 * Legacy browser state permits these requests to coexist, so the detail must
 * not collapse them into a discriminated union. The aggregate crosses the
 * wire only through an authenticated, expiring, generation-bound interaction
 * detail and is reconstructed field-by-field at both ends of that boundary.
 */
export interface BrowserGatewayOwnerInteractionPayload {
  approval: ApprovalRequest | null;
  question: QuestionRequest | null;
  questionProgress: BrowserGatewayOwnerQuestionProgressPayload | null;
  formElicitation: McpFormElicitationRequest | null;
  urlElicitation: McpUrlElicitationRequest | null;
}
