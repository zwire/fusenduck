---
# Values of fusenduck-flow's bindings for this repository. Lives at .flow/fusenduck-flow/project.md.
typecheck: pnpm typecheck
lint: pnpm lint
test: pnpm test
test-integration: pnpm test:integration
build: pnpm build
bench: pnpm bench
contract-check: pnpm contract:check
security-test: pnpm test:security
repro-check: pnpm repro:check
fixtures-gen: pnpm fixtures:gen
pack-dry-run: pnpm pack:check
smoke-install: pnpm smoke:install
changeset: pnpm changeset
version: pnpm changeset version
real-source-trial: pnpm trial:real-source
publish-npm: pnpm release:npm
publish-ext: pnpm release:ext
push-tags: git push --follow-tags
make-public: gh repo edit --visibility public --accept-visibility-change-consequences
pr-open: gh pr create
pr-merge: gh pr merge --squash --delete-branch
trunk: main
scratch: .scratch
code: [packages/core/**, packages/cli/**, packages/mcp/**, apps/**, tests/unit/**, tests/integration/**, tests/security/**, tests/bench/**]
contract: [packages/protocol/**, tests/contract/**, tests/golden/**]
refs-corpus: tests/contract/refs
fixtures: tests/fixtures
config: [package.json, packages/*/package.json, apps/*/package.json, pnpm-workspace.yaml, pnpm-lock.yaml, tsconfig.base.json, packages/*/tsconfig.json, apps/*/tsconfig.json, eslint.config.js, vitest.config.ts, .gitignore, .nvmrc, .editorconfig, .changeset/**]
ci: [.github/**]
budgets: bench/budgets.json
adr: docs/adr
docs: [docs/**, README.md, CONTRIBUTING.md, CHANGELOG.md, SECURITY.md, LICENSE]
---

# Project notes

Facts about this repository the workflow relies on. They stay here, not in the skill, so the skill stays reusable.

## Toolchain

| Purpose | Command or tool |
|---|---|
| Workspace | pnpm 9 workspaces, Node 24 (`.nvmrc`), TypeScript strict |
| Typecheck | `pnpm typecheck` (exists; runs `tsc --noEmit` per package) |
| Lint, test, build, bench, and the other commands above | Do not exist yet. `tracer-bullet` creates them as the walking skeleton; until then a check that names one fails |
| VCS host and review | GitHub through `gh` (installed). No remote and no commit exist yet; the user creates a private repository before the first change lands |
| Engine | DuckDB through its Node API (to be confirmed by the first spike) |
| Release | changesets for versions; npm and Open VSX are candidates, decided at the first release |

## Where things live

- Packages: `packages/core`, `packages/cli`, `packages/mcp` exist as empty entry points (evidence: `packages/*/src/index.ts`). `packages/protocol` (Ref, protocol messages, MCP tool schemas) does not exist yet; `tracer-bullet` creates it, and `decide` confirms the split in its decision record. `apps/web` and `apps/vscode` come later.
- Design intent: `docs/vision.md` holds the concept, the core abstraction, the safety model and the open questions.
- Contract-bearing paths (`contract`) are outside every other playbook's `writes`, so only `tracer-bullet` and `contract-change` edit them.
- Test data: generated into `tests/fixtures` by `pnpm fixtures:gen`; never edited by hand.
- Scratch: `.scratch/` is ignored by version control.
- Assumptions to confirm: GitHub as the host; license not chosen yet (the user decides; recorded in `LICENSE`); npm scope and Open VSX namespace not yet claimed.
