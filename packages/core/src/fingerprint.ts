import type { Engine } from "./engine.ts";

/** A cheap fingerprint of the source's data; how it is computed belongs to the source's adapter (see source.ts). */
export const fingerprint = (engine: Engine): Promise<string> => engine.adapter.fingerprint(engine);
