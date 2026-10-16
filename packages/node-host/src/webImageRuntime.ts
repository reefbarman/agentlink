import { randomBytes } from "node:crypto";
import type {
  ImageAttribution,
  ToolResult,
} from "@agentlink/protocol/tool-result";
import { errorResult } from "@agentlink/protocol/tool-result";
import type { CoreWebImageRetrievalMode } from "@agentlink/protocol/web-access-policy";
import {
  assertContentTypeCompatible,
  sniffStaticImage,
  type SupportedWebImageMimeType,
} from "./webImageFormat.js";
import {
  extractPageImages,
  type PageImageCandidate,
} from "./webImagePageParser.js";
import {
  createPublicWebFetcher,
  formatBytes,
  type PublicWebFetcher,
} from "./webImageTransport.js";
import { boundedText, publishUrl } from "./webImageUrlPublication.js";
import { WebImageError } from "./webImageErrors.js";

export const WEB_IMAGE_TOOL_NAMES = ["inspect_page_images"] as const;
export type WebImageToolName = (typeof WEB_IMAGE_TOOL_NAMES)[number];
/** Tool that made a network request, as shown on approval cards. */
export type WebImageRequestTool = WebImageToolName | "present_images";

export function isWebImageToolName(name: string): name is WebImageToolName {
  return (WEB_IMAGE_TOOL_NAMES as readonly string[]).includes(name);
}

export const WEB_IMAGE_LIMITS = Object.freeze({
  /** Larger pages are read up to this size and parsed as a prefix. */
  maxHtmlBytes: 4 * 1024 * 1024,
  maxImageBytes: 4 * 1024 * 1024,
  maxRedirects: 3,
  deadlineMs: 15_000,
  maxConcurrentPerSession: 2,
  maxInspectionsPerTurn: 6,
  maxFetchesPerTurn: 8,
  maxImportedBytesPerTurn: 16 * 1024 * 1024,
  maxCandidatesPerSession: 100,
  defaultCandidates: 8,
  maxCandidates: 12,
  /** Budgets reset after this idle gap when the host has no turn identity. */
  turnIdleResetMs: 10 * 60_000,
  /** Images retained for transcript display, across sessions. */
  maxDisplayCacheEntries: 48,
  maxDisplayCacheBytes: 64 * 1024 * 1024,
});

/** A web image retrieved for display in a transcript. */
export interface WebDisplayImage {
  mimeType: SupportedWebImageMimeType;
  data: Buffer;
  attribution: ImageAttribution;
}

export interface WebImagePolicy {
  mode: CoreWebImageRetrievalMode;
  allowedDomains: readonly string[];
  blockedDomains: readonly string[];
}

/** Decision values offered by the host approval card. */
export type WebImageApprovalDecision =
  | "accept"
  | "accept-origin"
  | "accept-chat"
  | "reject";

export interface WebImageApprovalRequest {
  sessionId: string;
  toolName: WebImageRequestTool;
  title: string;
  detail: string;
  origin: string;
  /** Publication-safe URL for display (query removed). */
  url?: string;
  choices: Array<{
    label: string;
    value: WebImageApprovalDecision;
    isPrimary?: boolean;
    isDanger?: boolean;
  }>;
}

export interface WebImageApprovalResponse {
  decision: string;
  followUp?: string;
  rejectionReason?: string;
}

/** Everything a host supplies for one tool call. */
export interface WebImageToolCallContext {
  sessionId: string;
  /** Stable logical turn identity, when the host has one. */
  turnId?: string;
  policy: WebImagePolicy;
  signal?: AbortSignal;
  /** Human approval for a new origin. Required when policy mode is "prompt". */
  requestApproval?: (
    request: WebImageApprovalRequest,
    signal?: AbortSignal,
  ) => Promise<WebImageApprovalResponse>;
}

interface StoredCandidate extends PageImageCandidate {
  id: string;
  pageUrl: string;
  pageTitle?: string;
}

interface SessionState {
  candidates: Map<string, StoredCandidate>;
  approvedOrigins: Set<string>;
  chatGrant: boolean;
  /** Serializes approval prompts so parallel calls never stack cards. */
  approvalChain: Promise<void>;
  active: number;
  waiters: Array<() => void>;
  turn: {
    key?: string;
    lastUsedAt: number;
    inspections: number;
    fetches: number;
    importedBytes: number;
  };
}

/**
 * Host-neutral web image retrieval: inspect_page_images, present_images with
 * a URL, and transcript display of Markdown image URLs. The VS Code host, the
 * Browser Ask Agent helper and createNodeHostWebImageTools each own one
 * runtime and call it directly; none routes through another.
 */
export class WebImageToolRuntime {
  private readonly sessions = new Map<string, SessionState>();
  private readonly displayCache = new Map<string, WebDisplayImage>();
  private displayCacheBytes = 0;
  private readonly fetcher: PublicWebFetcher;
  private readonly now: () => number;

  constructor(
    options: { fetcher?: PublicWebFetcher; now?: () => number } = {},
  ) {
    this.fetcher = options.fetcher ?? createPublicWebFetcher();
    this.now = options.now ?? Date.now;
  }

  /** Forget candidates and approvals for a closed or reset session. */
  clearSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  async execute(
    toolName: WebImageToolName,
    input: Record<string, unknown>,
    ctx: WebImageToolCallContext,
  ): Promise<ToolResult> {
    try {
      if (ctx.policy.mode === "disabled") {
        throw new WebImageError(
          "disabled",
          "Web image retrieval is disabled by the host's web access settings.",
        );
      }
      const state = this.session(ctx.sessionId);
      this.rollTurn(state, ctx.turnId);
      await this.acquire(state, ctx.signal);
      try {
        return await this.inspect(state, input, ctx);
      } finally {
        this.release(state);
      }
    } catch (error) {
      return webImageErrorResult(error, toolName);
    }
  }

  /**
   * Retrieve one public image for present_images, so the model can see it.
   * Input is `{ url }` or `{ candidate_id }` from inspect_page_images. The
   * result carries the image block with its source attribution.
   */
  async fetchForModel(
    input: { url?: string; candidate_id?: string },
    ctx: WebImageToolCallContext,
  ): Promise<ToolResult> {
    try {
      if (ctx.policy.mode === "disabled") {
        throw new WebImageError(
          "disabled",
          "Web image retrieval is disabled by the host's web access settings.",
        );
      }
      const state = this.session(ctx.sessionId);
      this.rollTurn(state, ctx.turnId);
      await this.acquire(state, ctx.signal);
      try {
        return await this.fetchImage(state, input, ctx);
      } finally {
        this.release(state);
      }
    } catch (error) {
      return webImageErrorResult(error, "present_images");
    }
  }

  /**
   * Retrieve a public image for transcript display (a Markdown image URL).
   * The host decides whether the user has consented; this applies the
   * public-only transport, domain lists and size limits, and caches results.
   * Images found by inspect_page_images keep their source-page attribution.
   */
  async fetchForDisplay(
    rawUrl: string,
    ctx: { sessionId: string; policy: WebImagePolicy; signal?: AbortSignal },
  ): Promise<WebDisplayImage> {
    if (ctx.policy.mode === "disabled") {
      throw new WebImageError(
        "disabled",
        "Web images are disabled by the host's web access settings.",
      );
    }
    const url = parseInputUrl(rawUrl);
    const cached = this.displayCache.get(url.href);
    if (cached) {
      this.displayCache.delete(url.href);
      this.displayCache.set(url.href, cached);
      return cached;
    }
    const state = this.sessions.get(ctx.sessionId);
    const candidate = state
      ? Array.from(state.candidates.values()).find(
          (entry) => entry.url === url.href,
        )
      : undefined;
    const response = await this.fetcher({
      url,
      accept: "image/webp,image/png,image/jpeg;q=0.9,*/*;q=0.1",
      maxBytes: WEB_IMAGE_LIMITS.maxImageBytes,
      maxRedirects: WEB_IMAGE_LIMITS.maxRedirects,
      deadlineMs: WEB_IMAGE_LIMITS.deadlineMs,
      signal: ctx.signal,
      authorize: async (next) => {
        const host = next.hostname.toLowerCase().replace(/\.$/u, "");
        if (!isDomainAllowed(host, ctx.policy)) {
          throw new WebImageError(
            "blocked_domain",
            `${host} is blocked by the host's web access domain settings`,
          );
        }
      },
    });
    const sniffed = sniffStaticImage(response.body);
    assertContentTypeCompatible(response.contentType, sniffed.mimeType);
    const image: WebDisplayImage = {
      mimeType: sniffed.mimeType,
      data: response.body,
      attribution: buildAttribution({
        candidate,
        requestedImageUrl: url,
        finalImageUrl: response.finalUrl,
        width: sniffed.width,
        height: sniffed.height,
        retrievedAt: new Date(this.now()).toISOString(),
      }),
    };
    this.rememberDisplayImage(url.href, image);
    return image;
  }

  private rememberDisplayImage(key: string, image: WebDisplayImage): void {
    this.displayCache.set(key, image);
    this.displayCacheBytes += image.data.byteLength;
    while (
      this.displayCache.size > WEB_IMAGE_LIMITS.maxDisplayCacheEntries ||
      this.displayCacheBytes > WEB_IMAGE_LIMITS.maxDisplayCacheBytes
    ) {
      const oldest = this.displayCache.keys().next();
      if (oldest.done) break;
      const evicted = this.displayCache.get(oldest.value);
      this.displayCache.delete(oldest.value);
      this.displayCacheBytes -= evicted?.data.byteLength ?? 0;
    }
  }

  private async inspect(
    state: SessionState,
    input: Record<string, unknown>,
    ctx: WebImageToolCallContext,
  ): Promise<ToolResult> {
    const pageUrl = parseInputUrl(input.url);
    const maxResults = clampCount(input.max_results);
    if (state.turn.inspections >= WEB_IMAGE_LIMITS.maxInspectionsPerTurn) {
      throw new WebImageError(
        "turn_budget_exceeded",
        `At most ${WEB_IMAGE_LIMITS.maxInspectionsPerTurn} page inspections per turn`,
      );
    }
    state.turn.inspections++;

    const response = await this.fetcher({
      url: pageUrl,
      accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
      maxBytes: WEB_IMAGE_LIMITS.maxHtmlBytes,
      truncateAtLimit: true,
      maxRedirects: WEB_IMAGE_LIMITS.maxRedirects,
      deadlineMs: WEB_IMAGE_LIMITS.deadlineMs,
      signal: ctx.signal,
      authorize: (url) =>
        this.authorize(state, url, "inspect_page_images", ctx),
    });
    const mime = response.contentType?.split(";")[0]?.trim().toLowerCase();
    if (mime?.startsWith("image/")) {
      throw new WebImageError(
        "not_html",
        "This URL is an image, not a page. Show it to the user with Markdown ![description](url), or call present_images with { urls: [url] } to look at it yourself.",
      );
    }
    if (mime && mime !== "text/html" && mime !== "application/xhtml+xml") {
      throw new WebImageError(
        "not_html",
        `The URL returned ${mime}, not an HTML page`,
      );
    }
    const html = decodeHtml(response.body, response.contentType);
    const extracted = await extractPageImages(
      html,
      response.finalUrl,
      maxResults,
    );
    const publishedPage = publishUrl(response.finalUrl);
    const candidates = extracted.candidates.map((candidate) =>
      this.storeCandidate(state, {
        ...candidate,
        pageUrl: response.finalUrl.href,
        pageTitle: extracted.title,
      }),
    );
    const warnings = [...extracted.warnings];
    if (response.truncated) {
      warnings.push(
        "The page is larger than 4 MiB; only the first 4 MiB was read. Images near the end of the page may be missing.",
      );
    }
    if (candidates.length === 0) {
      warnings.push(
        "No usable image candidates were found in the static page. The page may render images with JavaScript; try another source page or a direct image URL.",
      );
    }
    return jsonToolResult({
      status: candidates.length > 0 ? "ok" : "no_candidates",
      page: {
        url: publishedPage.url,
        url_sanitized: publishedPage.sanitized || undefined,
        title: extracted.title,
      },
      candidates: candidates.map((candidate) => {
        const published = publishUrl(candidate.url);
        return compact({
          candidate_id: candidate.id,
          image_url: published.url,
          image_url_sanitized: published.sanitized || undefined,
          extraction: candidate.extraction,
          title: candidate.title,
          alt: candidate.alt,
          declared_width: candidate.declaredWidth,
          declared_height: candidate.declaredHeight,
          creator: candidate.creator,
          license: candidate.license,
        });
      }),
      truncated: extracted.truncated || undefined,
      warnings: warnings.length > 0 ? warnings : undefined,
      next_step:
        candidates.length > 0
          ? "To show an image, put its image_url in your reply as Markdown: ![description](image_url). The user sees it with a link to this page. To look at an image yourself first, call present_images with its candidate_id."
          : undefined,
      note: "Page text, alt text and creator/licence metadata are publisher-supplied and unverified.",
    });
  }

  private async fetchImage(
    state: SessionState,
    input: { url?: unknown; candidate_id?: unknown },
    ctx: WebImageToolCallContext,
  ): Promise<ToolResult> {
    const candidateId =
      typeof input.candidate_id === "string" ? input.candidate_id.trim() : "";
    const hasUrl = typeof input.url === "string" && input.url.trim() !== "";
    if (Boolean(candidateId) === hasUrl) {
      throw new WebImageError(
        "unsupported_url",
        "Provide exactly one of candidate_id or url",
      );
    }
    let candidate: StoredCandidate | undefined;
    let requestUrl: URL;
    if (candidateId) {
      candidate = state.candidates.get(candidateId);
      if (!candidate) {
        throw new WebImageError(
          "candidate_unavailable",
          `Candidate ${candidateId} is unknown or expired. Call inspect_page_images again.`,
        );
      }
      requestUrl = new URL(candidate.url);
    } else {
      requestUrl = parseInputUrl(input.url);
    }
    if (state.turn.fetches >= WEB_IMAGE_LIMITS.maxFetchesPerTurn) {
      throw new WebImageError(
        "turn_budget_exceeded",
        `At most ${WEB_IMAGE_LIMITS.maxFetchesPerTurn} image fetches per turn`,
      );
    }
    const remainingBytes =
      WEB_IMAGE_LIMITS.maxImportedBytesPerTurn - state.turn.importedBytes;
    if (remainingBytes <= 0) {
      throw new WebImageError(
        "turn_budget_exceeded",
        `At most ${formatBytes(WEB_IMAGE_LIMITS.maxImportedBytesPerTurn)} of images per turn`,
      );
    }
    state.turn.fetches++;

    const response = await this.fetcher({
      url: requestUrl,
      accept: "image/webp,image/png,image/jpeg;q=0.9,*/*;q=0.1",
      maxBytes: Math.min(WEB_IMAGE_LIMITS.maxImageBytes, remainingBytes),
      maxRedirects: WEB_IMAGE_LIMITS.maxRedirects,
      deadlineMs: WEB_IMAGE_LIMITS.deadlineMs,
      signal: ctx.signal,
      authorize: (url) => this.authorize(state, url, "present_images", ctx),
    });
    const sniffed = sniffStaticImage(response.body);
    assertContentTypeCompatible(response.contentType, sniffed.mimeType);
    state.turn.importedBytes += response.body.byteLength;

    const attribution = buildAttribution({
      candidate,
      requestedImageUrl: requestUrl,
      finalImageUrl: response.finalUrl,
      width: sniffed.width,
      height: sniffed.height,
      retrievedAt: new Date(this.now()).toISOString(),
    });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "fetched",
            mime_type: sniffed.mimeType,
            width: sniffed.width,
            height: sniffed.height,
            bytes: response.body.byteLength,
            attribution,
          }),
        },
        {
          type: "image",
          data: response.body.toString("base64"),
          mimeType: sniffed.mimeType,
          attribution,
        },
      ],
    };
  }

  private storeCandidate(
    state: SessionState,
    candidate: Omit<StoredCandidate, "id">,
  ): StoredCandidate {
    for (const existing of state.candidates.values()) {
      if (
        existing.url === candidate.url &&
        existing.pageUrl === candidate.pageUrl
      ) {
        state.candidates.delete(existing.id);
        state.candidates.set(existing.id, existing);
        return existing;
      }
    }
    const stored: StoredCandidate = {
      ...candidate,
      id: `img_${randomBytes(5).toString("hex")}`,
    };
    state.candidates.set(stored.id, stored);
    while (state.candidates.size > WEB_IMAGE_LIMITS.maxCandidatesPerSession) {
      const oldest = state.candidates.keys().next().value;
      if (oldest === undefined) break;
      state.candidates.delete(oldest);
    }
    return stored;
  }

  /** Policy and consent gate evaluated before every connection and redirect. */
  private async authorize(
    state: SessionState,
    url: URL,
    toolName: WebImageRequestTool,
    ctx: WebImageToolCallContext,
  ): Promise<void> {
    const host = url.hostname.toLowerCase().replace(/\.$/u, "");
    if (!isDomainAllowed(host, ctx.policy)) {
      throw new WebImageError(
        "blocked_domain",
        `${host} is blocked by the host's web access domain settings`,
      );
    }
    if (ctx.policy.mode === "enabled" || state.chatGrant) return;
    if (state.approvedOrigins.has(url.origin)) return;
    const requestApproval = ctx.requestApproval;
    if (!requestApproval) {
      throw new WebImageError(
        "approval_rejected",
        "Web image retrieval needs approval, but no approval surface is available",
      );
    }
    const previous = state.approvalChain;
    let release!: () => void;
    state.approvalChain = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await previous;
      if (ctx.signal?.aborted) {
        throw new WebImageError("cancelled", "Retrieval was cancelled");
      }
      // Another call may have been granted while this one waited.
      if (state.chatGrant || state.approvedOrigins.has(url.origin)) return;
      await this.promptForOrigin(
        state,
        url,
        host,
        toolName,
        ctx,
        requestApproval,
      );
    } finally {
      release();
    }
  }

  private async promptForOrigin(
    state: SessionState,
    url: URL,
    host: string,
    toolName: WebImageRequestTool,
    ctx: WebImageToolCallContext,
    requestApproval: NonNullable<WebImageToolCallContext["requestApproval"]>,
  ): Promise<void> {
    const published = publishUrl(url);
    const response = await requestApproval(
      {
        sessionId: ctx.sessionId,
        toolName,
        origin: url.origin,
        url: published.url,
        title:
          toolName === "inspect_page_images"
            ? `Read images from ${host}?`
            : `Download an image from ${host}?`,
        detail: [
          toolName === "inspect_page_images"
            ? "AgentLink will download this public page (without running scripts or sending cookies) to list its images."
            : "AgentLink will download this public image so the agent can see it.",
          `Site: ${url.origin}`,
          published.url
            ? `URL: ${published.url}${published.sanitized ? " (query removed)" : ""}`
            : undefined,
          "",
          "The request comes from this computer. Retrieved images may be sent to the selected model.",
          "Private and local network addresses are always blocked.",
          "Allow public images for this chat covers inspect_page_images and present_images only, for any public site in this chat. Blocked domains and private addresses stay blocked.",
        ]
          .filter((line): line is string => line !== undefined)
          .join("\n"),
        choices: [
          { label: "Allow once", value: "accept", isPrimary: true },
          {
            label: "Allow public images for this chat",
            value: "accept-chat",
          },
          { label: "Deny", value: "reject", isDanger: true },
        ],
      },
      ctx.signal,
    );
    switch (response.decision) {
      case "accept":
        return;
      case "accept-origin":
        state.approvedOrigins.add(url.origin);
        return;
      case "accept-chat":
        state.chatGrant = true;
        return;
      default:
        throw new WebImageError(
          "approval_rejected",
          response.rejectionReason
            ? `The user denied retrieval from ${host}: ${response.rejectionReason}`
            : `The user denied retrieval from ${host}. Do not retry this site through another tool.`,
          response.followUp ? { follow_up: response.followUp } : {},
        );
    }
  }

  private session(sessionId: string): SessionState {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = {
        candidates: new Map(),
        approvedOrigins: new Set(),
        chatGrant: false,
        approvalChain: Promise.resolve(),
        active: 0,
        waiters: [],
        turn: {
          lastUsedAt: 0,
          inspections: 0,
          fetches: 0,
          importedBytes: 0,
        },
      };
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  private rollTurn(state: SessionState, turnId: string | undefined): void {
    const now = this.now();
    const changed =
      turnId !== undefined
        ? state.turn.key !== turnId
        : now - state.turn.lastUsedAt > WEB_IMAGE_LIMITS.turnIdleResetMs;
    if (changed) {
      state.turn = {
        key: turnId,
        lastUsedAt: now,
        inspections: 0,
        fetches: 0,
        importedBytes: 0,
      };
    }
    state.turn.lastUsedAt = now;
  }

  private async acquire(
    state: SessionState,
    signal?: AbortSignal,
  ): Promise<void> {
    while (state.active >= WEB_IMAGE_LIMITS.maxConcurrentPerSession) {
      if (signal?.aborted) {
        throw new WebImageError("cancelled", "Retrieval was cancelled");
      }
      await new Promise<void>((resolve) => state.waiters.push(resolve));
    }
    state.active++;
  }

  private release(state: SessionState): void {
    state.active = Math.max(0, state.active - 1);
    state.waiters.shift()?.();
  }
}

function buildAttribution(params: {
  candidate?: StoredCandidate;
  requestedImageUrl: URL;
  finalImageUrl: URL;
  width: number;
  height: number;
  retrievedAt: string;
}): ImageAttribution {
  if (!params.candidate) {
    // A direct URL's identity is the URL the agent chose (for example
    // coverartarchive.org), not the storage host it redirected to.
    const image = publishUrl(params.requestedImageUrl);
    return compact({
      origin: "web_url" as const,
      imageUrl: image.url,
      sanitized: image.sanitized || undefined,
      extraction: "direct_url" as const,
      width: params.width,
      height: params.height,
      retrievedAt: params.retrievedAt,
    });
  }
  const image = publishUrl(params.finalImageUrl);
  const page = publishUrl(params.candidate.pageUrl);
  return compact({
    origin: "web_page" as const,
    sourceUrl: page.url,
    imageUrl: image.url,
    sanitized: page.sanitized || image.sanitized || undefined,
    title: boundedText(
      params.candidate.title ?? params.candidate.pageTitle,
      500,
    ),
    alt: params.candidate.alt,
    creator: params.candidate.creator,
    license: params.candidate.license,
    extraction: params.candidate.extraction,
    width: params.width,
    height: params.height,
    retrievedAt: params.retrievedAt,
  });
}

function webImageErrorResult(
  error: unknown,
  toolName: WebImageRequestTool,
): ToolResult {
  if (error instanceof WebImageError) {
    return errorResult(error.message, {
      status: error.code,
      tool: toolName,
      ...error.extra,
    });
  }
  return errorResult(error instanceof Error ? error.message : String(error), {
    status: "fetch_failed",
    tool: toolName,
  });
}

export function isDomainAllowed(host: string, policy: WebImagePolicy): boolean {
  const matches = (domain: string) =>
    host === domain || host.endsWith(`.${domain}`);
  if (policy.blockedDomains.some(matches)) return false;
  if (policy.allowedDomains.length > 0) {
    return policy.allowedDomains.some(matches);
  }
  return true;
}

function parseInputUrl(value: unknown): URL {
  if (typeof value !== "string" || !value.trim()) {
    throw new WebImageError("unsupported_url", "url is required");
  }
  try {
    return new URL(value.trim());
  } catch {
    throw new WebImageError(
      "unsupported_url",
      "url must be an absolute http(s) URL",
    );
  }
}

function clampCount(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (value === undefined || !Number.isFinite(numeric)) {
    return WEB_IMAGE_LIMITS.defaultCandidates;
  }
  return Math.max(
    1,
    Math.min(WEB_IMAGE_LIMITS.maxCandidates, Math.floor(numeric)),
  );
}

function decodeHtml(body: Buffer, contentType: string | undefined): string {
  const charset = /charset\s*=\s*"?([\w-]+)/iu.exec(contentType ?? "")?.[1];
  try {
    return new TextDecoder(charset ?? "utf-8").decode(body);
  } catch {
    return new TextDecoder("utf-8").decode(body);
  }
}

function jsonToolResult(payload: Record<string, unknown>): ToolResult {
  const text = JSON.stringify(compact(payload));
  return { content: [{ type: "text", text }] };
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}
