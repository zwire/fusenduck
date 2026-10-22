import { describe, expect, it } from "vitest";
import { Gate } from "../../packages/mcp/src/gate.ts";

const never = () => new Promise<string>(() => undefined);

describe("Gate", () => {
  it("a waiting call whose caller goes away leaves the line, and its place goes to the next caller", async () => {
    const gate = new Gate(1, 1);
    void gate.run(new AbortController().signal, never);
    const leaving = new AbortController();
    const waiting = gate.run(leaving.signal, async () => "ran");
    await expect(gate.run(new AbortController().signal, async () => "ran")).rejects.toThrow(/busy/);
    leaving.abort();
    await expect(waiting).rejects.toThrow(/cancelled/);
    // The place in line is free again.
    const next = gate.run(new AbortController().signal, async () => "ran");
    await expect(Promise.race([next, new Promise((r) => setTimeout(() => r("waiting"), 50))])).resolves.toBe("waiting");
  });

  it("a caller that already went away takes no place in line", async () => {
    const gate = new Gate(1, 1);
    void gate.run(new AbortController().signal, never);
    const gone = new AbortController();
    gone.abort();
    await expect(gate.run(gone.signal, async () => "ran")).rejects.toThrow(/cancelled/);
    const waiting = gate.run(new AbortController().signal, async () => "ran");
    await expect(Promise.race([waiting, new Promise((r) => setTimeout(() => r("waiting"), 50))])).resolves.toBe("waiting");
  });

  it("a freed slot goes to the first caller in line", async () => {
    const gate = new Gate(1, 2);
    let release!: () => void;
    const first = gate.run(new AbortController().signal, () => new Promise<string>((r) => (release = () => r("first"))));
    const second = gate.run(new AbortController().signal, async () => "second");
    release();
    expect(await first).toBe("first");
    expect(await second).toBe("second");
  });
});
