import type { ImageAttribution } from "@agentlink/protocol/tool-result";

/** Only plain http(s) links are rendered; anything else shows as text. */
export function safeExternalHref(
  value: string | undefined,
): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    if (url.username || url.password) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

function hostLabel(href: string): string {
  try {
    return new URL(href).hostname.replace(/^www\./u, "");
  } catch {
    return href;
  }
}

/**
 * Source line rendered under a web image. Shows host-observed provenance only;
 * creator and licence are labelled as publisher-supplied, never inferred.
 */
export function ImageSourceCaption({
  attribution,
}: {
  attribution?: ImageAttribution;
}) {
  if (!attribution) return null;
  const sourceHref = safeExternalHref(
    attribution.sourceUrl ?? attribution.imageUrl,
  );
  const title = attribution.title ?? attribution.alt;
  const details = [
    attribution.creator ? `by ${attribution.creator}` : undefined,
    attribution.license ? `licence: ${attribution.license}` : undefined,
  ].filter((value): value is string => Boolean(value));
  const sourceKind =
    attribution.origin === "web_page" ? "Source page" : "Image URL";
  return (
    <div class="image-source-caption" data-testid="image-source-caption">
      {title && <span class="image-source-title">{title}</span>}
      <span class="image-source-link-row">
        <i class="codicon codicon-link-external" aria-hidden="true" />
        {sourceHref ? (
          <a
            href={sourceHref}
            target="_blank"
            rel="noreferrer noopener"
            title={`${sourceKind}: ${sourceHref}${attribution.sanitized ? " (tracking or signed parameters removed)" : ""}`}
            aria-label={`${sourceKind}: ${hostLabel(sourceHref)}`}
          >
            {hostLabel(sourceHref)}
          </a>
        ) : (
          <span>Web image (source unavailable)</span>
        )}
      </span>
      {details.length > 0 && (
        <span
          class="image-source-details"
          title="Publisher-supplied metadata, not verified by AgentLink"
        >
          {details.join(" · ")} (unverified)
        </span>
      )}
    </div>
  );
}
