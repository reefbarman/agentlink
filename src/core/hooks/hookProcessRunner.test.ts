import { describe, expect, it } from "vitest";

import { runHookProcess } from "./hookProcessRunner";

describe("runHookProcess", () => {
  it("writes JSON stdin and applies environment and command replacements", async () => {
    const result = await runHookProcess({
      command:
        "node -e \"let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>process.stdout.write(process.env.PLUGIN+':'+s))\"",
      input: { hello: "world" },
      env: { PLUGIN: "${PLUGIN_ROOT}" },
      replacements: { "${PLUGIN_ROOT}": "/tmp/plugin" },
      timeoutMs: 2_000,
      maxOutputBytes: 4_096,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('/tmp/plugin:{"hello":"world"}');
  });

  it("times out and cleans up the process", async () => {
    const result = await runHookProcess({
      command: 'node -e "setInterval(()=>{}, 1000)"',
      input: {},
      timeoutMs: 50,
      maxOutputBytes: 4_096,
    });

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
  });

  it("caps combined output and terminates the process", async () => {
    const result = await runHookProcess({
      command:
        "node -e \"process.stdout.write('x'.repeat(10000));setInterval(()=>{},1000)\"",
      input: {},
      timeoutMs: 2_000,
      maxOutputBytes: 64,
    });

    expect(result.outputLimitExceeded).toBe(true);
    expect(
      Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr),
    ).toBeLessThanOrEqual(64);
  });
});
