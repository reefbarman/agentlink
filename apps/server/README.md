# @agentlink/server

Standalone AgentLink assistant server. Private and experimental: this package contains the access layer and the authenticated workspace-session routes. The web app, jobs, and a service entry point come in later slices.

Supported hosts: Linux (Ubuntu) and macOS. The package uses only portable Node.js APIs (Node 22.19+), and its test suite runs on both.

## Access layer

`createAssistantServer(options)` starts an HTTPS-only listener (TLS 1.2+, certificate and key required, no plain-HTTP mode) that owns authentication:

- **Owner bootstrap.** While no owner exists, `start()` issues a 15-minute setup credential to `onSetupCredential`, which must only show it locally. `POST /api/auth/bootstrap` redeems it once with an owner passphrase (12+ characters) and returns a session.
- **Device pairing.** A signed-in, recently reauthenticated owner creates a single-use code (`POST /api/auth/pairings`, 5 minutes). A new browser redeems it at `POST /api/auth/pairings/redeem`. There is no passphrase login for unknown browsers.
- **Sessions.** `__Host-agentlink_session` cookie (`Secure; HttpOnly; SameSite=Strict; Path=/`), 30-day absolute and 7-day idle expiry. `GET /api/auth/session` returns the session and its CSRF token. `POST /api/auth/logout` ends it, and `DELETE /api/auth/devices/:id` revokes a device and all its sessions. The last active device cannot be revoked, because there is no local recovery path yet.
- **Reauthentication.** `POST /api/auth/reauthenticate` checks the scrypt-hashed passphrase. Sensitive routes need it within the last 5 minutes.
- **Request guard.** Every request and upgrade is rejected when it carries `Forwarded`, `X-Forwarded-*`, `X-Real-IP`, `X-Remote-User`, `X-Auth-Request-*` or similar identity/proxy headers, when `Host` is not a configured public origin, when `Origin` is foreign, or when `Sec-Fetch-Site` is `cross-site`. Unsafe methods and upgrades require `Origin`. Authenticated unsafe requests also need `x-agentlink-csrf`.
- **Rate limiting.** Setup, pairing, and passphrase guesses are limited per socket address and globally, and attempts still in flight count against the limit. Client headers never select the key.

`handleRequest` and `handleUpgrade` only ever see authenticated requests. Their `auth` context carries:

- an explicit `{ tenantId: "agentlink-server", subjectId: ownerId }` principal, never derived from a project identity;
- `recentlyAuthenticated`, as of when the request was authenticated;
- `signal`, which aborts when the request closes or as soon as its session or device is revoked;
- `revalidate()`, a check-only recheck of revocation, expiry, and current reauthentication. It does not count as client activity, so it never extends the idle window.

`onClose` runs during `close()`, after the listener stops accepting connections and before open connections and the access store close. Use it to stop application work.

State lives in `<dataRoot>/access-state.json` (directory `0700`, file `0600`). Only hashes of setup credentials, session tokens, and the passphrase are stored. A corrupt file stops startup rather than reopening bootstrap. Each write is fsynced, including the directory, before a response reports success. An exclusive `access-state.lock` lets only one live process own a data root; `close()` releases it, and a lock left by a dead process is replaced.

## Workspace sessions

`createAssistantWorkspaceRoutes({ projects, authorizeProject })` mounts one or more workspace hosts. Pass its `handleRequest` to the server and its `close` as `onClose`.

- **Explicit project access.** `authorizeProject({ principal, projectId, access })` maps the server principal to `read`, `write`, or `approve` on each mounted project. It is required; `ownerProjectAccess(store)` grants everything to the bootstrapped owner and nothing to anyone else. The host still runs as its own project principal.
- **Routes.** `GET /api/projects`, `GET|POST /api/projects/:id/sessions`, `GET .../sessions/:sid` (snapshot, running task, and event cursor), `POST .../turns`, `POST .../interaction`, `POST .../cancel`, and `GET .../events`.
- **Server-owned turns.** A turn or resume runs on the server, not the request: closing the browser does not cancel it. One task runs per session at a time (`409 session_busy`). Server shutdown aborts running tasks and waits for them.
- **Approvals.** `POST .../interaction` needs `approve` access and reauthentication within the window. The decision names the exact `interactionId` and `interactionRevision` the owner saw. A mismatch returns `409 stale_interaction`, and the host binds the same pair into the engine's atomic resume, so a decision cannot reach a replacement request. Revocation and reauthentication are rechecked immediately before the resume starts, and a revoked session stops reading a stalled request body.
- **Event stream.** `GET .../events` is Server-Sent Events. Events carry `id: <epoch>:<sequence>`. Reconnect with `?epoch=&after=` (or `Last-Event-ID`) to replay retained events. A `reset` control event means the cursor cannot be served (server restarted or the event aged out) and the client should re-read the snapshot. The stream closes on revocation and rechecks the session every heartbeat. A backpressured reader is caught up from the retained log once it drains; one that stays stalled for 30 seconds is dropped and can reconnect.

The event log is in memory, so it only bridges reconnects within one server process. The durable session repository remains the source of truth.

Not yet provided: certificate provisioning and device trust onboarding, a service entry point (systemd and launchd units), recovery when every session is lost, passkeys, background-agent routes, and the web app.
