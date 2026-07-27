import type { BrowserGatewayService } from "./BrowserGatewayService.js";
import type { ChatViewProvider } from "../agent/ChatViewProvider.js";

export function wireBrowserGatewayApprovalPolicies(
  service: Pick<BrowserGatewayService, "setCommandApprovalPolicyGetters">,
  provider: Pick<
    ChatViewProvider,
    "getBrowserCommandApprovalPolicy" | "getConfiguredCommandApprovalPolicy"
  >,
): void {
  service.setCommandApprovalPolicyGetters(
    () => provider.getBrowserCommandApprovalPolicy(),
    (projectScope) => provider.getConfiguredCommandApprovalPolicy(projectScope),
  );
}
