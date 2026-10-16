import {
  defineTool,
  type AgentPrincipal,
  type CoreModelContentBlock,
  type CoreModelImageMediaType,
  type HostTool,
  type HostToolResolveRequest,
  type HostToolResolver,
  type HostToolResult,
} from "@agentlink/core";
import type {
  ImageAttribution,
  ToolResult,
} from "@agentlink/protocol/tool-result";
import type { CoreWebImageRetrievalMode } from "@agentlink/protocol/web-access-policy";

import {
  WebImageToolRuntime,
  type WebImageApprovalRequest,
  type WebImageApprovalResponse,
  type WebImagePolicy,
  type WebImageToolCallContext,
} from "./webImageRuntime.js";
import {
  createPublicWebFetcher,
  type PublicWebFetcher,
} from "./webImageTransport.js";

/** Per-turn web image policy. Defaults to enabled with no domain lists. */
export interface NodeHostWebImagePolicy {
  readonly mode?: CoreWebImageRetrievalMode;
  readonly allowedDomains?: readonly string[];
  readonly blockedDomains?: readonly string[];
}

export interface NodeHostWebImageApprovalContext<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> {
  readonly principal: TPrincipal;
  readonly sessionId: string;
  readonly turnId: string;
}

export interface CreateNodeHostWebImageToolsOptions<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> {
  /**
   * Resolve the policy for one turn. Return `{ mode: "disabled" }` (or
   * undefined) to omit the tools for that turn. Omit the option to enable
   * public retrieval for every turn. resolveImageSource uses the policy most
   * recently resolved for the session.
   */
  readonly resolvePolicy?: (
    request: HostToolResolveRequest<TPrincipal>,
  ) =>
    | NodeHostWebImagePolicy
    | undefined
    | Promise<NodeHostWebImagePolicy | undefined>;
  /**
   * Human consent for a new site when the policy mode is "prompt". Without it,
   * "prompt" retrieval fails closed.
   */
  readonly requestApproval?: (
    request: WebImageApprovalRequest,
    context: NodeHostWebImageApprovalContext<TPrincipal>,
    signal?: AbortSignal,
  ) => Promise<WebImageApprovalResponse>;
  /**
   * Put base64 image bytes directly in present_images displayContent. By
   * default displayContent carries only image references; read the bytes with
   * getImage(...).
   */
  readonly inlineDisplayImages?: boolean;
  /** Images retained per session for present_images/getImage. Default 16. */
  readonly maxImagesPerSession?: number;
  /** Test seam: replaces the public-only network fetcher. */
  readonly fetcher?: PublicWebFetcher;
  readonly now?: () => number;
}

/** One retained web image, with its bytes and source attribution. */
export interface NodeHostWebImage {
  readonly imageId: string;
  readonly mimeType: CoreModelImageMediaType;
  readonly data: string;
  readonly width?: number;
  readonly height?: number;
  readonly attribution?: ImageAttribution;
}

/** displayContent emitted by present_images. */
export interface NodeHostPresentedImagesDisplay {
  readonly kind: "agentlink.presented_images";
  readonly images: ReadonlyArray<
    Omit<NodeHostWebImage, "data"> & { readonly data?: string }
  >;
}

/** Result of resolveImageSource for one Markdown image in agent output. */
export type NodeHostImageSourceResolution =
  | {
      readonly status: "ready";
      readonly mimeType: string;
      /** Base64 image bytes. */
      readonly data: string;
      readonly imageId?: string;
      readonly attribution?: ImageAttribution;
    }
  | {
      /** A web image that did not come from this session; ask the user first. */
      readonly status: "needs_confirmation";
      readonly host: string;
    }
  | { readonly status: "unavailable"; readonly message: string };

export interface NodeHostImageSourceOptions {
  /** The user chose to load this image (for example by clicking a button). */
  readonly userConfirmed?: boolean;
  readonly signal?: AbortSignal;
}

export interface NodeHostWebImageTools<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> {
  /** Compose into createNodeHostAgent({ tools: { resolveTools } }). */
  readonly resolveTools: HostToolResolver<TPrincipal>;
  /**
   * Read a retained image for rendering. The host must already have
   * authorized the caller for this session.
   */
  getImage(sessionId: string, imageId: string): NodeHostWebImage | undefined;
  /**
   * Resolve the source of a Markdown image (`![alt](source)`) in agent output
   * so the host can render it without loading remote URLs in its UI. Sources
   * are retained image IDs (web_image_N), data:image URLs and public http(s)
   * URLs. A web URL loads automatically only when it already appeared in this
   * session (user input, inspect_page_images or present_images); otherwise
   * the result is needs_confirmation until the user opts in. The host must
   * already have authorized the caller for this session.
   */
  resolveImageSource(
    sessionId: string,
    src: string,
    options?: NodeHostImageSourceOptions,
  ): Promise<NodeHostImageSourceResolution>;
  /** Forget candidates, approvals and images for a closed session. */
  clearSession(sessionId: string): void;
  /** Close the dedicated network pool. */
  dispose(): Promise<void>;
}

export const NODE_HOST_WEB_IMAGE_TOOL_NAMES = [
  "inspect_page_images",
  "present_images",
] as const;

const DEFAULT_MAX_IMAGES_PER_SESSION = 16;
const MAX_SESSIONS = 64;
const MAX_PRESENTED = 8;
const MAX_SEEN_URLS = 500;
const MODEL_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const URL_PATTERN = /https?:\/\/[^\s"'<>()\]\\]+/giu;
const DATA_IMAGE_PATTERN =
  /^data:(image\/(?:png|jpeg|gif|webp));base64,([a-z0-9+/=\s]+)$/iu;

interface SessionImages {
  next: number;
  images: Map<string, NodeHostWebImage>;
  /** URLs that came from the user or tool output in this session. */
  seenUrls: Set<string>;
  policy?: WebImagePolicy;
}

/**
 * Public web image discovery and display for SDK hosts. Agents show images
 * with Markdown `![alt](source)`; render them with resolveImageSource.
 * inspect_page_images lists a page's main images, and present_images
 * retrieves images so the model can see them and marks them for display.
 *
 * Retrieval comes from this process: public addresses only (re-checked per
 * redirect), no scripts, cookies or credentials, static PNG/JPEG/WebP up to
 * 4 MiB, and proxies fail closed. The tools do not search the web; pair them
 * with a search tool.
 */
export function createNodeHostWebImageTools<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
>(
  options: CreateNodeHostWebImageToolsOptions<TPrincipal> = {},
): NodeHostWebImageTools<TPrincipal> {
  const ownedFetcher = options.fetcher ? undefined : createPublicWebFetcher();
  const runtime = new WebImageToolRuntime({
    fetcher: options.fetcher ?? ownedFetcher,
    now: options.now,
  });
  const maxImages = Math.max(
    1,
    Math.floor(options.maxImagesPerSession ?? DEFAULT_MAX_IMAGES_PER_SESSION),
  );
  const sessions = new Map<string, SessionImages>();

  const sessionImages = (sessionId: string): SessionImages => {
    let state = sessions.get(sessionId);
    if (state) {
      sessions.delete(sessionId);
    } else {
      state = { next: 1, images: new Map(), seenUrls: new Set() };
    }
    sessions.set(sessionId, state);
    while (sessions.size > MAX_SESSIONS) {
      const oldest = sessions.keys().next().value;
      if (oldest === undefined) break;
      sessions.delete(oldest);
      runtime.clearSession(oldest);
    }
    return state;
  };

  const rememberUrls = (sessionId: string, text: string): void => {
    const seen = sessionImages(sessionId).seenUrls;
    for (const match of text.matchAll(URL_PATTERN)) {
      seen.add(match[0]);
      seen.add(match[0].replace(/[.,;:!?]+$/u, ""));
    }
    while (seen.size > MAX_SEEN_URLS) {
      const oldest = seen.values().next().value;
      if (oldest === undefined) break;
      seen.delete(oldest);
    }
  };

  const retain = (
    sessionId: string,
    image: Omit<NodeHostWebImage, "imageId">,
  ): NodeHostWebImage => {
    const state = sessionImages(sessionId);
    const stored = { ...image, imageId: `web_image_${state.next++}` };
    state.images.set(stored.imageId, stored);
    while (state.images.size > maxImages) {
      const oldest = state.images.keys().next().value;
      if (oldest === undefined) break;
      state.images.delete(oldest);
    }
    return stored;
  };

  const resolveTools: HostToolResolver<TPrincipal> = async (request) => {
    const resolved = options.resolvePolicy
      ? await options.resolvePolicy(request)
      : {};
    const mode = resolved?.mode ?? "enabled";
    const state = sessionImages(request.sessionId);
    if (!resolved || mode === "disabled") {
      state.policy = {
        mode: "disabled",
        allowedDomains: [],
        blockedDomains: [],
      };
      return [];
    }
    const policy: WebImagePolicy = {
      mode,
      allowedDomains: [...(resolved.allowedDomains ?? [])],
      blockedDomains: [...(resolved.blockedDomains ?? [])],
    };
    state.policy = policy;
    rememberUrls(request.sessionId, safeStringify(request.input));

    const callContext = (context: {
      principal: TPrincipal;
      sessionId: string;
      turnId: string;
      signal: AbortSignal | undefined;
    }): WebImageToolCallContext => ({
      sessionId: context.sessionId,
      turnId: context.turnId,
      policy,
      signal: context.signal,
      requestApproval: options.requestApproval
        ? (approval, signal) =>
            options.requestApproval!(
              approval,
              {
                principal: context.principal,
                sessionId: context.sessionId,
                turnId: context.turnId,
              },
              signal,
            )
        : undefined,
    });

    const tools: HostTool<TPrincipal>[] = [
      defineTool<TPrincipal>({
        name: "inspect_page_images",
        description:
          "List image candidates on one public web page (product, album, artwork or article) found via web search or supplied by the user. Reads static HTML metadata (JSON-LD, Open Graph, Twitter cards) and ordinary img/picture elements without running scripts. Returns image_url values to show with Markdown ![description](image_url), plus candidate_id values for present_images, title, alt text, declared dimensions and publisher-supplied creator/licence (unverified). Does not search the web itself. JavaScript-only, login-protected or anti-bot pages may return no candidates; try another source page.",
        inputSchema: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description:
                "Absolute public http(s) URL of a product, album, artwork or article page.",
            },
            max_results: {
              type: "integer",
              minimum: 1,
              maximum: 12,
              description: "Maximum candidates to return. Default 8.",
            },
          },
          required: ["url"],
          additionalProperties: false,
        },
        effect: "external",
        presentation: { title: "Inspect page images" },
        displayInput: (input) => ({ url: input.url }),
        handler: async (input, context) => {
          const result = await runtime.execute(
            "inspect_page_images",
            input,
            callContext(context),
          );
          if (!result.isError) {
            rememberUrls(context.sessionId, textOf(result));
          }
          return toHostResult(result);
        },
      }),
      defineTool<TPrincipal>({
        name: "present_images",
        description:
          "Look at web images yourself and show them to the user in one step. Sources: public image URLs, inspect_page_images candidate_ids, or image_ids from an earlier present_images call. You do not need this tool just to show an image: Markdown ![description](image_url) in your reply shows it with its source. Use present_images when you also need to see the image, then do not repeat it in Markdown. Never substitute a generated image for an existing one.",
        inputSchema: {
          type: "object",
          properties: {
            urls: {
              type: "array",
              items: { type: "string" },
              maxItems: MAX_PRESENTED,
              description:
                "Direct public http(s) image URLs (PNG, JPEG or WebP up to 4 MiB).",
            },
            candidate_ids: {
              type: "array",
              items: { type: "string" },
              maxItems: MAX_PRESENTED,
              description:
                "candidate_id values from inspect_page_images. These keep the source page as the caption.",
            },
            image_ids: {
              type: "array",
              items: { type: "string" },
              maxItems: MAX_PRESENTED,
              description:
                "image_id values from an earlier present_images call.",
            },
          },
          additionalProperties: false,
        },
        effect: "external",
        presentation: { title: "Present images" },
        displayInput: (input) => ({
          ...(Array.isArray(input.urls) ? { urls: input.urls } : {}),
          ...(Array.isArray(input.candidate_ids)
            ? { candidate_ids: input.candidate_ids }
            : {}),
          ...(Array.isArray(input.image_ids)
            ? { image_ids: input.image_ids }
            : {}),
        }),
        handler: async (input, context) => {
          const urls = stringArray(input.urls);
          const candidateIds = stringArray(input.candidate_ids);
          const imageIds = stringArray(input.image_ids);
          const state = sessionImages(context.sessionId);
          if (urls.length + candidateIds.length + imageIds.length === 0) {
            return errorHost(
              "Provide urls, candidate_ids or image_ids to present.",
            );
          }
          if (
            urls.length + candidateIds.length + imageIds.length >
            MAX_PRESENTED
          ) {
            return errorHost(
              `present_images supports at most ${MAX_PRESENTED} images per call`,
            );
          }
          const missing = imageIds.filter((id) => !state.images.has(id));
          if (missing.length > 0) {
            return errorHost(
              `Unknown image_ids: ${missing.join(", ")}. Available: ${
                [...state.images.keys()].join(", ") || "none"
              }`,
            );
          }
          const selected = imageIds.map((id) => state.images.get(id)!);
          const errors: string[] = [];
          const requests: Array<{ url?: string; candidate_id?: string }> = [
            ...urls.map((url) => ({ url })),
            ...candidateIds.map((candidate_id) => ({ candidate_id })),
          ];
          for (const request of requests) {
            const result = await runtime.fetchForModel(
              request,
              callContext(context),
            );
            const image = result.content.find((item) => item.type === "image");
            if (
              result.isError ||
              !image ||
              image.type !== "image" ||
              !MODEL_IMAGE_TYPES.has(image.mimeType)
            ) {
              errors.push(
                `${request.url ?? request.candidate_id}: ${textOf(result) || "not retrieved"}`,
              );
              continue;
            }
            const summary = parseJsonText(result) ?? {};
            const stored = retain(context.sessionId, {
              mimeType: image.mimeType as CoreModelImageMediaType,
              data: image.data,
              width: numberOrUndefined(summary.width),
              height: numberOrUndefined(summary.height),
              ...(image.attribution ? { attribution: image.attribution } : {}),
            });
            if (request.url) state.seenUrls.add(request.url);
            if (stored.attribution?.imageUrl) {
              state.seenUrls.add(stored.attribution.imageUrl);
            }
            selected.push(stored);
          }
          if (selected.length === 0) {
            return errorHost(errors.join("\n") || "No images were retrieved.");
          }
          const display: NodeHostPresentedImagesDisplay = {
            kind: "agentlink.presented_images",
            images: selected.map((image) => ({
              ...describeImage(image),
              ...(options.inlineDisplayImages ? { data: image.data } : {}),
            })),
          };
          const text = JSON.stringify({
            status: "presented",
            count: selected.length,
            images: selected.map((image) => ({
              image_id: image.imageId,
              ...(image.attribution?.sourceUrl || image.attribution?.imageUrl
                ? {
                    source:
                      image.attribution.sourceUrl ?? image.attribution.imageUrl,
                  }
                : {}),
            })),
            ...(errors.length > 0 ? { errors } : {}),
            note: "The host shows these images with their source; do not also embed them with Markdown. Creator and licence are publisher-supplied and unverified.",
          });
          return {
            modelContent: [
              { type: "text", text },
              ...selected.map(modelImageBlock),
            ],
            displayContent: display,
          };
        },
      }),
    ];
    return tools;
  };

  const resolveImageSource = async (
    sessionId: string,
    src: string,
    sourceOptions: NodeHostImageSourceOptions = {},
  ): Promise<NodeHostImageSourceResolution> => {
    const source = src.trim();
    const state = sessions.get(sessionId);
    const retained = state?.images.get(source);
    if (retained) {
      return {
        status: "ready",
        mimeType: retained.mimeType,
        data: retained.data,
        imageId: retained.imageId,
        ...(retained.attribution ? { attribution: retained.attribution } : {}),
      };
    }
    const inline = DATA_IMAGE_PATTERN.exec(source);
    if (inline) {
      return {
        status: "ready",
        mimeType: inline[1]!.toLowerCase(),
        data: inline[2]!.replace(/\s+/gu, ""),
      };
    }
    let url: URL;
    try {
      url = new URL(source);
    } catch {
      return { status: "unavailable", message: "Unsupported image source." };
    }
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username ||
      url.password
    ) {
      return { status: "unavailable", message: "Unsupported image source." };
    }
    const stored = state
      ? [...state.images.values()]
          .reverse()
          .find((image) => image.attribution?.imageUrl === url.href)
      : undefined;
    if (stored) {
      return {
        status: "ready",
        mimeType: stored.mimeType,
        data: stored.data,
        imageId: stored.imageId,
        ...(stored.attribution ? { attribution: stored.attribution } : {}),
      };
    }
    const policy = state?.policy ?? {
      mode: "enabled" as const,
      allowedDomains: [],
      blockedDomains: [],
    };
    if (policy.mode === "disabled") {
      return { status: "unavailable", message: "Web images are disabled." };
    }
    const seen =
      state?.seenUrls.has(source) === true ||
      state?.seenUrls.has(url.href) === true;
    if (!sourceOptions.userConfirmed && !(policy.mode === "enabled" && seen)) {
      return { status: "needs_confirmation", host: url.hostname };
    }
    try {
      const image = await runtime.fetchForDisplay(url.href, {
        sessionId,
        policy,
        signal: sourceOptions.signal,
      });
      return {
        status: "ready",
        mimeType: image.mimeType,
        data: image.data.toString("base64"),
        attribution: image.attribution,
      };
    } catch (error) {
      return {
        status: "unavailable",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  };

  return {
    resolveTools,
    getImage: (sessionId, imageId) =>
      sessions.get(sessionId)?.images.get(imageId),
    resolveImageSource,
    clearSession: (sessionId) => {
      sessions.delete(sessionId);
      runtime.clearSession(sessionId);
    },
    dispose: async () => {
      sessions.clear();
      await ownedFetcher?.dispose();
    },
  };
}

function toHostResult(result: ToolResult): HostToolResult {
  const blocks: CoreModelContentBlock[] = [];
  for (const item of result.content) {
    if (item.type === "text") blocks.push({ type: "text", text: item.text });
  }
  const parsed = parseJsonText(result);
  return {
    modelContent: blocks,
    ...(parsed ? { displayContent: parsed } : {}),
    ...(result.isError ? { isError: true } : {}),
  };
}

function errorHost(message: string): HostToolResult {
  return {
    modelContent: JSON.stringify({ error: message }),
    displayContent: { error: message },
    isError: true,
  };
}

function modelImageBlock(image: NodeHostWebImage): CoreModelContentBlock {
  return {
    type: "image",
    source: { type: "base64", media_type: image.mimeType, data: image.data },
    ...(image.attribution ? { attribution: image.attribution } : {}),
  };
}

function describeImage(
  image: NodeHostWebImage,
): Omit<NodeHostWebImage, "data"> {
  const { data: _data, ...rest } = image;
  return rest;
}

function textOf(result: ToolResult): string {
  return result.content
    .map((item) => (item.type === "text" ? item.text : ""))
    .join("\n")
    .trim();
}

function parseJsonText(
  result: ToolResult,
): Record<string, unknown> | undefined {
  const first = result.content[0];
  if (first?.type !== "text") return undefined;
  try {
    const parsed: unknown = JSON.parse(first.text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter(isString).map((entry) => entry.trim()))]
    : [];
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}
