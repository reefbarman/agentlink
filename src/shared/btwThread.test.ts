import {
  buildBtwChatMessage,
  parseBtwThreadMessage,
  withBtwThreadBlock,
} from "./btwThread";
import { describe, expect, it } from "vitest";

const thread = [
  { question: "Why?", answer: "Because.\n\n---\n\nMore detail." },
  { question: "And then?", answer: "Ship it." },
];

describe("btwThread", () => {
  it("round-trips the follow-up and every exchange", () => {
    const { text, displayText } = buildBtwChatMessage(" do it ", thread);
    expect(displayText).toBe(text);
    const parsed = parseBtwThreadMessage(text);
    expect(parsed?.text).toBe("do it");
    expect(parsed?.count).toBe(2);
    expect(parsed?.exchanges).toEqual(thread);
  });

  it("hides the default follow-up when the user typed nothing", () => {
    const { text, displayText } = buildBtwChatMessage("  ", thread);
    expect(text).toContain("Take it into account.");
    expect(parseBtwThreadMessage(displayText)?.text).toBe("");
    expect(parseBtwThreadMessage(text)?.text).toBe("");
  });

  it("keeps the thread attached when the follow-up is edited", () => {
    const parsed = parseBtwThreadMessage(
      buildBtwChatMessage("first", thread).text,
    )!;
    const edited = parseBtwThreadMessage(
      withBtwThreadBlock("second", parsed.block),
    );
    expect(edited?.text).toBe("second");
    expect(edited?.exchanges).toEqual(thread);
  });

  it("recognises the legacy indicator without exchanges", () => {
    expect(
      parseBtwThreadMessage("[/btw thread attached: 1 exchange]\nokay go"),
    ).toMatchObject({ text: "okay go", count: 1, exchanges: [] });
  });

  it("ignores ordinary messages", () => {
    expect(parseBtwThreadMessage("hello <btw_side_thread>")).toBeUndefined();
  });
});
