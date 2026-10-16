import { boundedText } from "./webImageUrlPublication.js";

export type PageImageExtraction =
  | "json_ld"
  | "open_graph"
  | "twitter"
  | "html_image";

export interface PageImageCandidate {
  /** Exact absolute request URL. Transient host data only. */
  url: string;
  extraction: PageImageExtraction;
  title?: string;
  alt?: string;
  /** Publisher-declared dimensions, not measured. */
  declaredWidth?: number;
  declaredHeight?: number;
  creator?: string;
  license?: string;
}

export interface ExtractedPageImages {
  title?: string;
  candidates: PageImageCandidate[];
  warnings: string[];
  truncated: boolean;
}

/** Minimal structural view of parse5's default tree nodes. */
interface HtmlNode {
  nodeName: string;
  tagName?: string;
  value?: string;
  attrs?: Array<{ name: string; value: string }>;
  childNodes?: HtmlNode[];
  content?: HtmlNode;
}

const MAX_JSON_LD_BLOCKS = 12;
const MAX_JSON_LD_BYTES = 256 * 1024;
const MAX_JSON_LD_DEPTH = 10;
const MAX_JSON_LD_NODES = 4000;
const MAX_HTML_IMAGE_ELEMENTS = 200;
const MAX_TREE_NODES = 200_000;
const MIN_DECLARED_EDGE = 64;
const MAX_TEXT = 500;
const MAX_LABEL = 200;

const IMAGE_BEARING_TYPES = new Set([
  "product",
  "productgroup",
  "musicalbum",
  "musicrelease",
  "musicrecording",
  "visualartwork",
  "painting",
  "photograph",
  "sculpture",
  "creativework",
  "imageobject",
  "book",
  "movie",
  "artwork",
]);

const JSON_LD_SKIPPED_KEYS = new Set([
  "@context",
  "image",
  "logo",
  "publisher",
  "provider",
  "sourceOrganization",
]);

const OBVIOUS_NON_CONTENT =
  /(?:^|[/_.-])(?:spacer|pixel|tracking|1x1|blank)(?:[/_.-]|$)/iu;

/**
 * Extract image candidates from static HTML. The parser never executes
 * scripts or loads subresources, never follows links, and never resolves
 * remote JSON-LD contexts.
 */
export async function extractPageImages(
  html: string,
  pageUrl: URL,
  maxResults: number,
): Promise<ExtractedPageImages> {
  const { parse } = await import("parse5");
  const document = parse(html) as unknown as HtmlNode;
  const warnings: string[] = [];

  let baseUrl = pageUrl;
  let title: string | undefined;
  const meta = new Map<string, string>();
  const jsonLdBlocks: string[] = [];
  const htmlImages: PageImageCandidate[] = [];
  let pictureAlt: string | undefined;
  let visited = 0;
  let treeTruncated = false;

  const visit = (node: HtmlNode, inPicture: boolean): void => {
    if (++visited > MAX_TREE_NODES) {
      treeTruncated = true;
      return;
    }
    const tag = node.tagName?.toLowerCase();
    const attr = (name: string) =>
      node.attrs?.find((entry) => entry.name.toLowerCase() === name)?.value;
    if (tag === "base" && baseUrl === pageUrl) {
      const href = attr("href");
      if (href) {
        try {
          const resolved = new URL(href, pageUrl);
          if (resolved.protocol === "https:" || resolved.protocol === "http:") {
            baseUrl = resolved;
          }
        } catch {
          // Ignore malformed base URLs.
        }
      }
    } else if (tag === "title" && title === undefined) {
      title = boundedText(textOf(node), MAX_TEXT);
    } else if (tag === "meta") {
      const key = (attr("property") ?? attr("name"))?.trim().toLowerCase();
      const content = attr("content");
      if (key && content !== undefined && !meta.has(key))
        meta.set(key, content);
    } else if (tag === "script") {
      const type = attr("type")?.trim().toLowerCase();
      if (type === "application/ld+json") {
        if (jsonLdBlocks.length < MAX_JSON_LD_BLOCKS) {
          jsonLdBlocks.push(textOf(node));
        }
      }
      return;
    } else if (
      (tag === "img" || tag === "source") &&
      htmlImages.length < MAX_HTML_IMAGE_ELEMENTS
    ) {
      const src =
        bestSrcsetCandidate(attr("srcset")) ??
        attr("src") ??
        attr("data-src") ??
        bestSrcsetCandidate(attr("data-srcset"));
      const alt = tag === "img" ? attr("alt") : pictureAlt;
      const width = positiveInt(attr("width"));
      const height = positiveInt(attr("height"));
      if (src && (tag === "img" || inPicture)) {
        htmlImages.push({
          url: src,
          extraction: "html_image",
          alt: boundedText(alt, MAX_TEXT),
          declaredWidth: width,
          declaredHeight: height,
        });
      }
    } else if (tag === "picture") {
      pictureAlt = findPictureAlt(node);
      for (const child of node.childNodes ?? []) visit(child, true);
      pictureAlt = undefined;
      return;
    }
    if (node.content) visit(node.content, inPicture);
    for (const child of node.childNodes ?? []) visit(child, inPicture);
  };
  visit(document, false);
  if (treeTruncated)
    warnings.push("Page structure was truncated during parsing.");

  const ordered: PageImageCandidate[] = [];
  for (const block of jsonLdBlocks) {
    try {
      ordered.push(...extractJsonLdImages(block));
    } catch {
      warnings.push("Skipped a malformed or oversized JSON-LD block.");
    }
  }
  const ogImage =
    meta.get("og:image:secure_url") ??
    meta.get("og:image") ??
    meta.get("og:image:url");
  if (ogImage) {
    ordered.push({
      url: ogImage,
      extraction: "open_graph",
      title: boundedText(meta.get("og:title"), MAX_TEXT),
      alt: boundedText(meta.get("og:image:alt"), MAX_TEXT),
      declaredWidth: positiveInt(meta.get("og:image:width")),
      declaredHeight: positiveInt(meta.get("og:image:height")),
    });
  }
  const twitterImage =
    meta.get("twitter:image") ?? meta.get("twitter:image:src");
  if (twitterImage) {
    ordered.push({
      url: twitterImage,
      extraction: "twitter",
      title: boundedText(meta.get("twitter:title"), MAX_TEXT),
      alt: boundedText(meta.get("twitter:image:alt"), MAX_TEXT),
    });
  }
  ordered.push(...htmlImages);

  const seen = new Set<string>();
  const candidates: PageImageCandidate[] = [];
  let truncated = false;
  for (const candidate of ordered) {
    const resolved = resolveImageUrl(candidate.url, baseUrl);
    if (!resolved) continue;
    const key = resolved.replace(/#.*$/u, "");
    if (seen.has(key)) continue;
    seen.add(key);
    if (isObviousNonContent(resolved, candidate)) continue;
    if (candidates.length >= maxResults) {
      truncated = true;
      break;
    }
    candidates.push({ ...candidate, url: resolved });
  }

  return {
    title: title ?? boundedText(meta.get("og:title"), MAX_TEXT),
    candidates,
    warnings,
    truncated,
  };
}

function textOf(node: HtmlNode): string {
  let text = "";
  const walk = (current: HtmlNode) => {
    if (text.length > MAX_JSON_LD_BYTES) return;
    if (current.nodeName === "#text" && typeof current.value === "string") {
      text += current.value;
    }
    for (const child of current.childNodes ?? []) walk(child);
  };
  walk(node);
  return text;
}

function findPictureAlt(node: HtmlNode): string | undefined {
  for (const child of node.childNodes ?? []) {
    if (child.tagName?.toLowerCase() === "img") {
      return child.attrs?.find((entry) => entry.name === "alt")?.value;
    }
  }
  return undefined;
}

function positiveInt(value: unknown): number | undefined {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseInt(value, 10)
        : NaN;
  return Number.isFinite(parsed) && parsed > 0 && parsed < 100_000
    ? Math.floor(parsed)
    : undefined;
}

/** Prefer the widest srcset candidate up to 2048w, else the widest overall. */
function bestSrcsetCandidate(srcset: string | undefined): string | undefined {
  if (!srcset) return undefined;
  const entries = srcset
    .split(/,\s+/u)
    .map((part) => part.trim().split(/\s+/u))
    .filter((parts) => parts[0])
    .map(([url, descriptor]) => {
      const width = descriptor?.endsWith("w")
        ? Number.parseInt(descriptor, 10)
        : NaN;
      const density = descriptor?.endsWith("x")
        ? Number.parseFloat(descriptor)
        : NaN;
      return {
        url: url!,
        score: Number.isFinite(width)
          ? width
          : Number.isFinite(density)
            ? density * 1000
            : 0,
      };
    });
  if (entries.length === 0) return undefined;
  const bounded = entries.filter((entry) => entry.score <= 2048);
  const pool = bounded.length > 0 ? bounded : entries;
  return pool.reduce((best, entry) => (entry.score > best.score ? entry : best))
    .url;
}

function resolveImageUrl(raw: string, base: URL): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith("data:") || trimmed.startsWith("blob:")) {
    return undefined;
  }
  try {
    const url = new URL(trimmed, base);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    if (url.username || url.password) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

function isObviousNonContent(
  url: string,
  candidate: PageImageCandidate,
): boolean {
  let pathname: string;
  try {
    pathname = new URL(url).pathname.toLowerCase();
  } catch {
    return true;
  }
  if (/\.(?:svg|gif|ico)$/u.test(pathname)) return true;
  if (OBVIOUS_NON_CONTENT.test(pathname)) return true;
  if (
    (candidate.declaredWidth !== undefined &&
      candidate.declaredWidth < MIN_DECLARED_EDGE) ||
    (candidate.declaredHeight !== undefined &&
      candidate.declaredHeight < MIN_DECLARED_EDGE)
  ) {
    return true;
  }
  return false;
}

function extractJsonLdImages(block: string): PageImageCandidate[] {
  if (block.length > MAX_JSON_LD_BYTES) throw new Error("json_ld_too_large");
  const parsed = JSON.parse(block) as unknown;
  const results: PageImageCandidate[] = [];
  let nodes = 0;

  const visit = (value: unknown, depth: number): void => {
    if (depth > MAX_JSON_LD_DEPTH || ++nodes > MAX_JSON_LD_NODES) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    const types = (
      Array.isArray(record["@type"]) ? record["@type"] : [record["@type"]]
    )
      .filter((type): type is string => typeof type === "string")
      .map((type) => type.replace(/^.*[/#:]/u, "").toLowerCase());
    const isImageBearing = types.some((type) => IMAGE_BEARING_TYPES.has(type));
    if (isImageBearing) {
      const title = boundedText(record.name ?? record.headline, MAX_TEXT);
      const creator = personName(
        record.creator ??
          record.author ??
          record.byArtist ??
          record.artist ??
          record.brand,
      );
      const license = licenseLabel(record.license);
      if (types.includes("imageobject")) {
        const image = imageObject(record, { title, creator, license });
        if (image) results.push(image);
      }
      for (const image of imageValues(record.image, {
        title,
        creator,
        license,
      })) {
        results.push(image);
      }
    }
    for (const [key, child] of Object.entries(record)) {
      // Publisher/site logos (for example Wikipedia's Wikimedia logo) are
      // never the content image.
      if (JSON_LD_SKIPPED_KEYS.has(key)) continue;
      if (child && typeof child === "object") visit(child, depth + 1);
    }
  };
  visit(parsed, 0);
  return results;
}

function imageValues(
  value: unknown,
  inherited: { title?: string; creator?: string; license?: string },
): PageImageCandidate[] {
  const values = Array.isArray(value) ? value.slice(0, 12) : [value];
  const results: PageImageCandidate[] = [];
  for (const item of values) {
    if (typeof item === "string") {
      results.push({ url: item, extraction: "json_ld", ...compact(inherited) });
    } else if (item && typeof item === "object") {
      const image = imageObject(item as Record<string, unknown>, inherited);
      if (image) results.push(image);
    }
  }
  return results;
}

function imageObject(
  record: Record<string, unknown>,
  inherited: { title?: string; creator?: string; license?: string },
): PageImageCandidate | undefined {
  const url = [record.contentUrl, record.url].find(
    (value): value is string => typeof value === "string",
  );
  if (!url) return undefined;
  return {
    url,
    extraction: "json_ld",
    ...compact({
      title: boundedText(record.name, MAX_TEXT) ?? inherited.title,
      alt: boundedText(record.caption ?? record.description, MAX_TEXT),
      declaredWidth: positiveInt(dimension(record.width)),
      declaredHeight: positiveInt(dimension(record.height)),
      creator:
        personName(record.creator ?? record.author ?? record.copyrightHolder) ??
        inherited.creator,
      license: licenseLabel(record.license) ?? inherited.license,
    }),
  };
}

function dimension(value: unknown): unknown {
  if (value && typeof value === "object") {
    return (value as Record<string, unknown>).value;
  }
  return value;
}

function personName(value: unknown): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  if (typeof first === "string") return boundedText(first, MAX_LABEL);
  if (first && typeof first === "object") {
    return boundedText((first as Record<string, unknown>).name, MAX_LABEL);
  }
  return undefined;
}

function licenseLabel(value: unknown): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  if (typeof first === "string") return boundedText(first, MAX_LABEL);
  if (first && typeof first === "object") {
    const record = first as Record<string, unknown>;
    return boundedText(record.name ?? record.url ?? record["@id"], MAX_LABEL);
  }
  return undefined;
}

function compact<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
}
