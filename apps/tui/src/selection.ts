import type { Range } from "@fusenduck/web/view";

// The rows picked so far, as positions in the file. The Ref's predicate is built from their ranges.
export class Selection {
  readonly #positions = new Set<number>();

  get size(): number {
    return this.#positions.size;
  }

  has(pos: number): boolean {
    return this.#positions.has(pos);
  }

  toggle(pos: number): void {
    if (!this.#positions.delete(pos)) this.#positions.add(pos);
  }

  /** Adds every position from `a` to `b`, either way round. */
  addRange(a: number, b: number): void {
    for (let p = Math.min(a, b); p <= Math.max(a, b); p++) this.#positions.add(p);
  }

  clear(): void {
    this.#positions.clear();
  }

  /** The positions as sorted ranges that touch nothing else. */
  ranges(): Range[] {
    const sorted = [...this.#positions].sort((x, y) => x - y);
    const out: Range[] = [];
    for (const p of sorted) {
      const last = out.at(-1);
      if (last && p === last[1] + 1) last[1] = p;
      else out.push([p, p]);
    }
    return out;
  }

  /** A copy, so a state update sees a new object. */
  copy(): Selection {
    const next = new Selection();
    for (const p of this.#positions) next.#positions.add(p);
    return next;
  }
}
