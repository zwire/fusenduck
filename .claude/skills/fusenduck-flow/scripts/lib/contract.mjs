// The file contract every generated skill follows: versions, the runtime's files, the enums of
// playbook and profile frontmatter. Shared by the validator and the runtime.

export const VERSION = "0.3.0";
// Version of the file contract (playbook frontmatter, profile frontmatter). Bump on breaking changes
// and document the migration in references/graph-model.md#schema-versions.
export const SCHEMA = 2;
// The runtime every generated skill carries in its scripts/, copied unchanged from vajra: the two
// entry points and everything in lib/.
export const RUNTIME = [
  "flow.mjs", "validate.mjs",
  ...["contract", "frontmatter", "match", "bindings", "playbook", "profile", "skill", "mermaid",
    "shell", "tools", "protect", "settings", "env", "store", "graph", "run", "status", "cli", "install", "hooks", "mcp", "reply", "ask"].map((m) => `lib/${m}.mjs`),
];

export const PHASES = ["explore", "expand", "extract", "any"];
export const LIFECYCLES = ["throwaway", "tracer", "hardened", "any"];
export const KINDS = ["work", "gate", "service"];
export const ENUMS = { phase: PHASES, lifecycle: LIFECYCLES, kind: KINDS };
export const LIFECYCLE_RANK = { throwaway: 0, tracer: 1, hardened: 2 };
export const RANK_NAME = ["throwaway", "tracer", "hardened"];
export const PLAYBOOK_KEYS = ["id", "title", "phase", "lifecycle", "kind", "promotes", "terminal", "exits", "checks", "writes", "irreversible"];
export const REQUIRED_SECTIONS = ["Purpose", "Steps", "Done when"];
export const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
// SKILL.md frontmatter fields allowed by the Agent Skills specification.
export const SKILL_FIELDS = ["name", "description", "license", "compatibility", "metadata", "allowed-tools"];
export const PROMOTES_RE = /^(throwaway|tracer|hardened)\s*->\s*(throwaway|tracer|hardened)$/;

// Cross-cutting domain traits; see references/facets/. Each one changes evidence, gates or rails.
export const FACETS = [
  "measured-outcome", "perceptual-output", "data-dependence", "stand-in-ladder", "physical-world",
  "shared-contracts", "data-mutation", "external-release", "resource-budgets", "reproducibility",
];
export const RAILS = ["advisory", "standard", "strict"];

// Profile axes stored in profile.md frontmatter. Free-form axes (domains) are checked for shape only.
export const PROFILE_AXES = {
  uncertainty: ["clear", "complicated", "complex", "chaotic"],
  requirements: ["fixed", "shifting", "unknown"],
  journey: ["explore", "expand", "extract"],
  failure_cost: ["throwaway", "internal", "customer", "regulated"],
  artifact_lifetime: ["disposable", "evolving", "long-lived"],
  cadence: ["continuous", "timeboxed", "phase-gated"],
  team: ["solo", "small", "multi-team"],
  verification: ["evidence", "test-after", "tdd", "formal"],
  autonomy: ["high", "medium", "low"],
  parallelism: ["none", "explore-only", "wherever-splittable"],
  domains: null,
  facets: FACETS,
  hardware: ["none", "simulated", "attached", "custom-hardware"],
  invocation: ["explicit", "auto"],
  rails: RAILS,
};
export const LIST_AXES = new Set(["journey", "domains", "facets"]);
