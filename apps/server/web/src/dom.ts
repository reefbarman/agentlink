/**
 * Tiny element builder. Text is only ever set as text nodes, never parsed as
 * HTML, so model output and server data cannot inject markup.
 */
export type Child = Node | string | null | undefined | false;

type Props = Record<
  string,
  string | number | boolean | null | undefined | ((event: never) => void)
>;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (typeof value === "function") {
      element.addEventListener(
        key.slice(2).toLowerCase(),
        value as unknown as EventListener,
      );
    } else if (key === "class") {
      element.className = String(value);
    } else if (key === "style" || key.toLowerCase().startsWith("on")) {
      // Inline styles and handler attributes are blocked by the CSP.
      throw new Error(`Unsupported attribute: ${key}`);
    } else if (key === "value" && "value" in element) {
      (element as unknown as { value: string }).value = String(value);
    } else {
      element.setAttribute(key, value === true ? "" : String(value));
    }
  }
  append(element, ...children);
  return element;
}

export function append(parent: Node, ...children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(
      typeof child === "string" ? document.createTextNode(child) : child,
    );
  }
}

export function replaceChildren(parent: Element, ...children: Child[]): void {
  parent.replaceChildren();
  append(parent, ...children);
}

export function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay
    ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
}

/** Display a tool input or result value as bounded plain text. */
export function displayValue(value: unknown, maxLength = 4_000): string {
  let text: string;
  if (typeof value === "string") text = value;
  else {
    try {
      text = JSON.stringify(value, null, 2) ?? "";
    } catch {
      text = String(value);
    }
  }
  return text.length > maxLength ? `${text.slice(0, maxLength)}\n…` : text;
}
