<!-- wl:contributing.intro -->
# Contributing to ilinxa capture

Thanks for your interest in contributing! This document covers the local
setup, project conventions, and the pull-request workflow.
<!-- /wl -->

<!-- wl:contributing.setup -->
## Prerequisites

- **Node.js 22+**
- **FFmpeg 5.1+** (with `ffprobe`) on `PATH`, required to run the app and the
  integration tests
- **yt-dlp** on `PATH`, required for video-download features. Without it the URL
  integration tests skip
- **npm** (this project does not use pnpm or yarn)

## Getting started

```bash
git clone https://github.com/ilinxa/ilinxa-capture.git
cd ilinxa-capture

# Backend
npm ci
npm run dev          # tsx watch on :3000

# Web UI (separate terminal, it is its own npm project)
cd ui && npm ci
npm run dev          # Vite on :5173, proxies /api to :3000
```

`npm run dev` passes `--dev`, which is what allows the Vite origin. A plain
`npm start` never does, whatever is in `.env`.

## Project layout

- `src/core/` holds all business logic. `service.ts` owns every pipeline, and
  `options.ts` defines every option once. Framework-agnostic.
- `src/api/` is the REST layer: routes, Zod schemas, thin handlers.
- `src/mcp/` is the MCP server and tool registration.
- `ui/` is the React SPA (separate `package.json`).

The golden rule: **REST and MCP layers stay thin**. New behavior belongs in
`src/core/`, with the interface layers only translating protocols.
<!-- /wl -->

<!-- wl:contributing.conventions -->
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
<!-- /wl -->

<!-- wl:contributing.testing -->
## Testing

Every change must land **with its tests**. A fix without a regression test is
incomplete, and the test must fail if the fix is reverted: try it.

```bash
npm run typecheck                  # backend types
npm test -- --run                  # backend unit (fast)
npm run test:integration -- --run  # real FFmpeg and yt-dlp, end to end
cd ui && npm run lint && npm run typecheck && npm test -- --run && npm run build
```

Notes:

- Unit tests must stay **fast and offline**. Mock `execFileAsync` rather than
  calling real binaries. Temp folders are fine.
- Integration tests (`*.integration.test.ts`) drive the live API with real
  binaries. Mock only what cannot be made to fail for real, such as a disk read
  failing partway, and keep that in its own file. See
  `src/integration/zip-errors.integration.test.ts`.
- To prove which frame came back, use `makeBarcodeClip` and `barcodeOf` from
  `src/integration/helpers.ts`. A label alone proves little.
- FFmpeg behaves differently across versions. Timing changes must pass on 5.1 as
  well as a current build.
- `app.inject()` does not reliably deliver streamed response bodies, so test
  streaming endpoints through a real listener (see
  `src/integration/pipeline.integration.test.ts`) or assert on mocks.
<!-- /wl -->

<!-- wl:contributing.pr -->
## Pull requests

1. Fork and create a feature branch from `main`.
2. Keep PRs focused — one logical change per PR.
3. Use [Conventional Commits](https://www.conventionalcommits.org/):
   `feat:`, `fix:`, `perf:`, `test:`, `docs:`, `chore:` (scope optional,
   e.g. `fix(api): …`).
4. Make sure **all** gates above pass locally; CI runs them on every PR.
5. Update documentation in the same PR when behavior changes
   (`README.md`, `docs/GUIDE.md`, `.env.example`), and add a `CHANGELOG.md`
   Unreleased entry for user-facing changes.
<!-- /wl -->

<!-- wl:contributing.issues -->
## Reporting issues

Please include: what you ran (exact command / request), what you expected,
what happened instead, OS + Node + FFmpeg versions, and relevant log output
(`LOG_LEVEL=debug`). For security concerns, do not open a public issue —
follow [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions will be licensed under
the [Apache License 2.0](LICENSE).
<!-- /wl -->
