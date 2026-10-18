// The run state of one project: .flow/<skill>/state.json (the active run), log.jsonl (every event,
// append-only) and runs/ (finished and abandoned runs).

import fs from "node:fs";
import path from "node:path";
import { skillName, now } from "./env.mjs";

export function openStore(root) {
  const dir = path.join(root, ".flow", skillName);
  const file = path.join(dir, "state.json");
  const ensure = () => fs.mkdirSync(dir, { recursive: true });
  return {
    dir,
    load() {
      try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return { run: null, suspended: false }; }
    },
    save(state) {
      ensure();
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 2) + "\n");
      fs.renameSync(`${file}.tmp`, file);
    },
    log(event) {
      ensure();
      fs.appendFileSync(path.join(dir, "log.jsonl"), JSON.stringify({ at: now(), ...event }) + "\n");
    },
    archive(run) {
      ensure();
      fs.mkdirSync(path.join(dir, "runs"), { recursive: true });
      fs.writeFileSync(path.join(dir, "runs", `${run.id}.json`), JSON.stringify(run, null, 2) + "\n");
    },
  };
}
