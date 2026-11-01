# ADR 0001: Local-first trust boundary

**Status:** Accepted, 2026-11-01. Applies from 0.2.0.

## Context

ilinxa capture has no authentication and is meant for localhost or a trusted
network. Until 0.1.1 the defaults did not enforce that. The server bound every
interface, reflected any CORS origin, and accepted local paths from any caller.
"Localhost only" is also weaker than it sounds, because a web page open in a
browser on the same machine can reach a local service.

## Decision

1. **Bind to loopback by default.** `HOST` defaults to `127.0.0.1`. The Docker
   image sets `HOST=0.0.0.0` itself because a container has to listen on its own
   interface; the documented `docker run` publishes on `127.0.0.1` only.
2. **Check `Host` and `Origin` on every route.** One Fastify `onRequest` hook
   covers the REST API, `/mcp` and the static UI, and answers `403` otherwise.
   `Host` must be loopback, the configured bind address, or in `ALLOWED_HOSTS`.
   `Origin`, when present, must be same-origin or in `ALLOWED_ORIGINS`. Requests
   with no `Origin` (curl, MCP clients) are allowed.
3. **Refuse local paths over HTTP by default.** REST and HTTP MCP only accept
   paths inside `LOCAL_OUTPUT_DIR` unless `ALLOWED_INPUT_DIRS` says otherwise.
   Stdio is started by a user on their own machine, so it allows local paths
   unless `ALLOWED_INPUT_DIRS` is set.
4. **Accept only real inputs.** Sources are `http(s)` URLs or resolved absolute
   paths, so no other URL scheme or option-like value reaches FFmpeg. Compose
   validates every frame as an image, in every mode.
5. **Validate job IDs everywhere.** A job ID matches `cap_` plus 8 hex digits.
   That holds at the API, in the job manager, in storage and on recovery.

## Why not the MCP SDK's rebinding options

They are deprecated in the SDK version we use, and they only protect `/mcp`. The
REST API has the same exposure, so the check belongs in front of both.

## Consequences

- **Breaking:** LAN clients need `ALLOWED_HOSTS`, cross-origin browser clients
  need `ALLOWED_ORIGINS`, and REST callers using local paths need
  `ALLOWED_INPUT_DIRS`.
- A public deployment still needs a gateway for authentication and rate limits.
  This ADR makes the default safe; it does not add a login.
- URL fetching stays by design, so SSRF on an exposed instance remains a
  deployment concern, documented in the security model.
