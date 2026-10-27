import {
  DEFAULT_ASSISTANT_NAME,
  isPersonaChangeDisplay,
  openPersonaStore,
} from "./persona.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPersonaTools, toPatchInput } from "./personaTools.js";

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "persona-tools-"));
  cleanup.push(() =>
    fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
  );
  const store = await openPersonaStore({
    file: path.join(dir, "persona.json"),
    defaultTimeZone: "Australia/Brisbane",
  });
  const onChanged = vi.fn();
  let clock = 1_000;
  const tools = createPersonaTools({
    store,
    onChanged,
    now: () => (clock += 1),
  });
  const [tool] = tools.resolveTools({} as never) as unknown as Array<{
    definition: { name: string };
    validate(input: unknown): { valid: boolean };
    executeValidated(
      input: Record<string, unknown>,
      context: never,
    ): Promise<{ modelContent: unknown; isError?: boolean }>;
  }>;
  const prepare = async (input: Record<string, unknown>) =>
    await tools.prepare({ toolName: "propose_persona_change", input } as never);
  const approve = async (approval: Awaited<ReturnType<typeof prepare>>) => {
    if (approval.decision !== "require_user" || !approval.preparedInput) {
      throw new Error("not awaiting approval");
    }
    const pending = await tools.validatePending?.({
      sessionId: "s",
      toolName: "propose_persona_change",
      input: approval.preparedInput,
    });
    return {
      pending,
      result: await tool!.executeValidated(
        { ...approval.preparedInput },
        {} as never,
      ),
    };
  };
  return { store, tools, tool: tool!, onChanged, prepare, approve };
}

describe("propose_persona_change", () => {
  it("always asks the owner, showing old and new values, then applies exactly that", async () => {
    const { store, tool, onChanged, prepare, approve } = await setup();
    expect(tool.definition.name).toBe("propose_persona_change");
    const input = { name: "Matey", ownerName: "Tristan" };
    expect(tool.validate(input).valid).toBe(true);

    const approval = await prepare(input);
    expect(approval).toMatchObject({
      decision: "require_user",
      summary: "Change the Assistant's persona settings?",
    });
    if (approval.decision !== "require_user") throw new Error("denied");
    expect(isPersonaChangeDisplay(approval.displayContent)).toBe(true);
    expect(
      (approval.displayContent as { text: string }).text.split("\n"),
    ).toEqual([
      "Change how the Assistant sounds and works:",
      "",
      `Name: ${DEFAULT_ASSISTANT_NAME} → Matey`,
      "Your name: (not set) → Tristan",
    ]);
    expect(store.get().name).toBe(DEFAULT_ASSISTANT_NAME);

    const { pending, result } = await approve(approval);
    expect(pending).toEqual({ ok: true });
    expect(result.isError).toBeUndefined();
    expect(store.get()).toMatchObject({ name: "Matey", ownerName: "Tristan" });
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("refuses an approved change when the settings changed meanwhile", async () => {
    const { store, prepare, approve } = await setup();
    const approval = await prepare({ name: "Matey" });
    await store.update({ ownerName: "Someone" }, 5_000);
    const { pending, result } = await approve(approval);
    expect(pending).toMatchObject({ ok: false });
    expect(result).toMatchObject({ isError: true });
    expect(store.get().name).toBe(DEFAULT_ASSISTANT_NAME);
  });

  it("denies invalid input and changes that set nothing new", async () => {
    const { prepare } = await setup();
    expect(await prepare({ timeZone: "Mars/Olympus" })).toMatchObject({
      decision: "deny",
      reason: expect.stringContaining("IANA"),
    });
    expect(await prepare({ name: DEFAULT_ASSISTANT_NAME })).toEqual({
      decision: "deny",
      reason: "the change sets nothing new",
    });
  });

  it("will not run without a prepared, approved change", async () => {
    const { store, tool } = await setup();
    const result = await tool.executeValidated({ name: "Sneaky" }, {} as never);
    expect(result).toMatchObject({ isError: true });
    expect(store.get().name).toBe(DEFAULT_ASSISTANT_NAME);
  });

  it("turns quiet hours off and resets fields from its plain inputs", async () => {
    expect(
      toPatchInput({ persona: "", ownerName: "", quietHoursOff: true }),
    ).toEqual({ persona: null, ownerName: null, quietHours: null });
    expect(toPatchInput({ quietHoursOff: false, name: "A" })).toEqual({
      name: "A",
    });
    const { prepare, approve, store } = await setup();
    await approve(await prepare({ quietHoursOff: true }));
    expect(store.get().quietHours).toBeUndefined();
  });
});
