export interface AgentErrorActions {
  signIn?: boolean;
  signInAnotherAccount?: boolean;
  condense?: boolean;
}

/** Serializable error state shared by runtime, persistence, and presentation surfaces. */
export interface AgentRuntimeErrorPresentation {
  message: string;
  retryable: boolean;
  code?: string;
  actions?: AgentErrorActions;
}
