/**
 * Chat Completions requests inline every retained image (and PDF) as a base64
 * `data:` URL, and image-heavy sessions replay hundreds of megabytes of them on
 * every turn. Serializing such a request with `JSON.stringify` keeps two extra
 * copies of all that media on the V8 heap while the response streams: each
 * data URL is flattened into its own string, then the whole body becomes one
 * more giant string. Together with the transcript's own copy, that has been
 * enough to exhaust the extension host heap.
 *
 * Instead, wire media objects are registered here when they are translated.
 * The encoder serializes everything else normally, then writes each media
 * payload straight from the transcript's original base64 string into a single
 * byte buffer. The bytes sent are identical to `JSON.stringify(body)`, but the
 * large copy lives in an off-heap buffer and no intermediate strings are made.
 */

interface InlineMediaSource {
  /** JSON text up to and including the opening quote of the base64 payload. */
  head: string;
  /** Base64 payload, taken unchanged from the transcript. */
  data: string;
  /** JSON text closing the payload string and the media object. */
  tail: string;
}

const inlineMediaSources = new WeakMap<object, InlineMediaSource>();
const BASE64_JSON_SAFE = /^[A-Za-z0-9+/=_-]*$/;

/**
 * Records how to write `target` (an `image_url` or `file` wire object) without
 * materializing its data URL. `fields` lists the object's properties in wire
 * order; exactly one field holds the data URL built from `mediaType` and
 * `data`, so encoded output matches what `JSON.stringify(target)` would give.
 */
export function registerOpenAiCompatibleInlineMedia(
  target: object,
  args: {
    leadingFields?: Readonly<Record<string, string>>;
    dataUrlField: string;
    mediaType: string;
    data: string;
  },
): void {
  const leading = Object.entries(args.leadingFields ?? {})
    .map(([key, value]) => `${JSON.stringify(key)}:${JSON.stringify(value)},`)
    .join("");
  const prefix = JSON.stringify(`data:${args.mediaType};base64,`).slice(0, -1);
  inlineMediaSources.set(target, {
    head: `{${leading}${JSON.stringify(args.dataUrlField)}:${prefix}`,
    data: args.data,
    tail: '"}',
  });
}

/**
 * Encodes a Chat Completions request body. Bodies without registered media are
 * returned as the usual JSON string; bodies with media are returned as UTF-8
 * bytes holding exactly the same JSON.
 */
export function encodeOpenAiCompatibleRequestBody(
  body: unknown,
): string | Uint8Array {
  const media: InlineMediaSource[] = [];
  const token = `agentlink-inline-media-${globalThis.crypto.randomUUID()}`;
  const json = JSON.stringify(body, (_key, value: unknown) => {
    if (typeof value === "object" && value !== null) {
      const source = inlineMediaSources.get(value);
      if (source) {
        media.push(source);
        return `${token}:${media.length - 1}`;
      }
    }
    return value;
  });
  if (media.length === 0) return json;

  const encoder = new TextEncoder();
  const pieces: Array<Uint8Array | string> = [];
  const placeholder = new RegExp(`"${token}:(\\d+)"`, "g");
  let cursor = 0;
  let total = 0;
  const pushText = (text: string) => {
    if (!text) return;
    const bytes = encoder.encode(text);
    pieces.push(bytes);
    total += bytes.byteLength;
  };
  for (const match of json.matchAll(placeholder)) {
    pushText(json.slice(cursor, match.index));
    const source = media[Number(match[1])];
    pushText(source.head);
    // Base64 is ASCII, so its UTF-8 length equals its string length and it
    // needs no JSON escaping. Anything else falls back to normal escaping,
    // which copies but stays correct.
    if (BASE64_JSON_SAFE.test(source.data)) {
      pieces.push(source.data);
      total += source.data.length;
    } else {
      pushText(JSON.stringify(source.data).slice(1, -1));
    }
    pushText(source.tail);
    cursor = match.index + match[0].length;
  }
  pushText(json.slice(cursor));

  const output = new Uint8Array(total);
  let offset = 0;
  for (const piece of pieces) {
    if (typeof piece === "string") {
      const { written } = encoder.encodeInto(
        piece,
        output.subarray(offset, offset + piece.length),
      );
      offset += written;
    } else {
      output.set(piece, offset);
      offset += piece.byteLength;
    }
  }
  return output;
}
