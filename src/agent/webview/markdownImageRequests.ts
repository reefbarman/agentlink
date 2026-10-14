import type {
  MarkdownImageResolution,
  MarkdownImageResolveRequest,
} from "../../shared/markdownImageSource";

import { randomId } from "../../shared/randomId";

const REQUEST_TIMEOUT_MS = 30_000;
const pending = new Map<string, (result: MarkdownImageResolution) => void>();

/**
 * Asks the extension host to resolve a Markdown image source. The reply
 * arrives as an `agentMarkdownImageResolved` message.
 */
export function requestMarkdownImage(
  postMessage: (message: unknown) => void,
  request: MarkdownImageResolveRequest,
): Promise<MarkdownImageResolution> {
  const requestId = randomId();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      resolve({
        status: "unavailable",
        message: "Loading the image timed out.",
      });
    }, REQUEST_TIMEOUT_MS);
    pending.set(requestId, (result) => {
      clearTimeout(timer);
      pending.delete(requestId);
      resolve(result);
    });
    postMessage({
      command: "agentResolveMarkdownImage",
      requestId,
      ...request,
    });
  });
}

export function settleMarkdownImageRequest(
  requestId: string,
  result: MarkdownImageResolution,
): void {
  pending.get(requestId)?.(result);
}
