# Contributing to ilinxa capture

Thanks for your interest in contributing! This document covers the local
setup, project conventions, and the pull-request workflow.

## Prerequisites

- **Node.js 22+**
- **FFmpeg** (with `ffprobe`) on `PATH` — required to run the app and the
  integration tests
- **yt-dlp** on `PATH` — required for video-download features
- **npm** (this project does not use pnpm or yarn)

## Getting started

```bash
git clone https://github.com/ilinxa/ilinxa-capture.git
cd ilinxa-capture

# Backend
npm ci
npm run dev          # tsx watch on :3000

# Web UI (separate terminal — it is its own npm project)
cd ui && npm ci
npm run dev          # Vite on :5173, proxies /api to :3000
```

## Project layout

- `src/core/` — all business logic (extraction, composition, download, jobs,
  storage, cleanup). Framework-agnostic.
- `src/api/` — REST layer: routes, Zod schemas, thin handlers.
- `src/mcp/` — MCP server and tool registration.
- `ui/` — React SPA (separate `package.json`).

The golden rule: **REST and MCP layers stay thin** — new behavior belongs in
`src/core/` with the interface layers only translating protocols.

## Conventions

### Backend

- **ESM only** — `.js` extensions on all relative imports.
- **Strict TypeScript** — `strict`, `noUncheckedIndexedAccess`,
  `noImplicitReturns`. No `any`; use `unknown` and narrow.
- **Zod at every boundary** — env, request bodies, MCP tool inputs, and
  persisted `job.json` files are all schema-validated.
- **Pino for logging** — never `console.log`. On the MCP stdio transport,
  stdout is reserved for JSON-RPC; logs go to stderr.
- **External binaries via `execFile`** with argument arrays — never string
  interpolation into a shell.

### UI

- Named function components with named exports — no default exports, no
  `React.FC`.
- **Zustand** for client state, **TanStack Query** for server state — never
  mixed; stores never call `fetch`.
- Tailwind v4 semantic tokens (`bg-background`, `text-brand`, …) — no
  hardcoded color utilities.
- Query priority in tests: `getByRole` > `getByLabelText` > `getByText`.

## Testing

Every change must land **with its tests** — a fix without a regression test
is incomplete.

```bash
npm run typecheck                  # backend types
npm test -- --run                  # backend unit (mocked binaries; fast)
npm run test:integration -- --run  # real-FFmpeg end-to-end pipeline
cd ui && npm run lint && npm run typecheck && npm test -- --run && npm run build
```

Notes:

- Unit tests must stay **hermetic** — mock `node:child_process` and
  `node:fs/promises`; never touch real binaries or the network.
- Integration tests (`*.integration.test.ts`) are the opposite: **no mocks
  allowed**. They are excluded from the unit run and executed via
  `npm run test:integration`.
- `app.inject()` does not reliably deliver streamed response bodies — test
  streaming endpoints through a real listener (see
  `src/integration/pipeline.integration.test.ts`) or assert on mocks.

## Pull requests

1. Fork and create a feature branch from `main`.
2. Keep PRs focused — one logical change per PR.
3. Use [Conventional Commits](https://www.conventionalcommits.org/):
   `feat:`, `fix:`, `perf:`, `test:`, `docs:`, `chore:` (scope optional,
   e.g. `fix(api): …`).
4. Make sure **all** gates above pass locally; CI runs them on every PR.
5. Update documentation in the same PR when behavior changes
   (`README.md`, `docs/GUIDE.md`, `.env.example`).

## Reporting issues

Please include: what you ran (exact command / request), what you expected,
what happened instead, OS + Node + FFmpeg versions, and relevant log output
(`LOG_LEVEL=debug`). For security concerns, please do not open a public
issue — contact the maintainers directly.

## License

By contributing, you agree that your contributions will be licensed under
the [Apache License 2.0](LICENSE).
