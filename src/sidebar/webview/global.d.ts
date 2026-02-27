// VS Code webview API — available globally in webview context
declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

declare const __DEV_BUILD__: boolean;
