import { FusenError } from "@fusenduck/core";

/**
 * Bounds how many tool calls run at once. Each call opens its own engine (up to its memory limit),
 * so a client that sends many calls together could otherwise use up the machine's memory. Calls
 * past the limit wait in line; calls past the line are refused with a message to try again. A
 * call whose client goes away while it waits leaves the line.
 */
export class Gate {
  #running = 0;
  readonly #waiting: (() => void)[] = [];
  readonly maxRunning: number;
  readonly maxWaiting: number;

  constructor(maxRunning: number, maxWaiting: number) {
    this.maxRunning = maxRunning;
    this.maxWaiting = maxWaiting;
  }

  async run<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    if (signal.aborted) throw new FusenError("the request was cancelled");
    if (this.#running < this.maxRunning) {
      this.#running += 1;
    } else {
      if (this.#waiting.length >= this.maxWaiting) {
        throw new FusenError(
          `the server is busy (${this.maxRunning} calls running, ${this.maxWaiting} waiting). Try again shortly.`,
        );
      }
      // The slot is handed over by the call that frees it, so the count does not change here.
      await new Promise<void>((resolve, reject) => {
        const go = () => {
          signal.removeEventListener("abort", leave);
          resolve();
        };
        const leave = () => {
          const at = this.#waiting.indexOf(go);
          if (at >= 0) this.#waiting.splice(at, 1);
          reject(new FusenError("the request was cancelled"));
        };
        signal.addEventListener("abort", leave, { once: true });
        this.#waiting.push(go);
      });
    }
    try {
      return await work();
    } finally {
      const next = this.#waiting.shift();
      if (next) next();
      else this.#running -= 1;
    }
  }
}
