export interface BrowserGatewayRepositoryState {
  revision: string;
  branch: string | null;
  dirty: boolean;
  rootLabel?: string;
}
