# @agentlink/server

Standalone AgentLink assistant server. Private and experimental: this package contains the access layer, the authenticated workspace-session routes, and a runnable service with systemd and launchd definitions. The web app and jobs come in later slices.

Supported hosts: Linux (Ubuntu) and macOS. The package uses only portable Node.js APIs (Node 22.19+), and its test suite runs on both.

## Running the server

`npm run build --workspace apps/server` bundles everything into one file, `dist/agentlink-server.js`, which runs with Node 22.19+ on Linux and macOS.

```sh
agentlink-server --config /etc/agentlink/server.json --check   # validate and exit
agentlink-server --config /etc/agentlink/server.json           # serve until SIGTERM/SIGINT
```

`--check` validates the configuration, TLS certificate and key, project directories, and provider secrets without taking locks or listening. On first start without an owner, the server writes a single-use setup credential to stderr (the journal under systemd, the log file under launchd); see [Access layer](#access-layer). SIGTERM stops running turns, waits for them, and exits 0. A second signal exits immediately.

### Configuration

One JSON file. Relative paths resolve against its directory, and unknown keys are rejected so a typo cannot silently drop a setting. Examples: [`deploy/server.linux.example.json`](deploy/server.linux.example.json) and [`deploy/server.macos.example.json`](deploy/server.macos.example.json).

| Key             | Meaning                                                                                                                                        |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `dataRoot`      | Access state (`server/`) and workspace session data (`workspace/`). Created `0700`.                                                            |
| `listen`        | `{ host, port }`. Bind a LAN address explicitly; there is no default.                                                                          |
| `publicOrigins` | Exact `https://` origins browsers use. The `Host` header must match one.                                                                       |
| `tls`           | `{ certFile, keyFile }`. The key must not be readable by others (`0600`, or `0640` with a group).                                              |
| `providers`     | `openai` (`modelIds`, `apiKey`) or `openai-compatible` (`baseURL`, `models`, and `apiKey` or `noAuth: true`). Remote providers must use HTTPS. |
| `defaultModel`  | `{ providerId, modelId }`.                                                                                                                     |
| `projects`      | `[{ id, label?, root }]`. Each is mounted at `/api/projects/<id>` with file tools enabled. Commands are not enabled yet.                       |
| `ripgrepPath`   | Optional absolute `rg` binary for `search_files`.                                                                                              |

API keys are never inline. `{ "file": "/path" }` reads a file that must not be readable by group or others. `{ "credential": "name" }` reads `$CREDENTIALS_DIRECTORY/name`, which systemd provides through `LoadCredential=` or `LoadCredentialEncrypted=` (use `systemd-creds encrypt` to bind the key to the TPM). Keys are reread on each use, so rotation needs no restart.

### Ubuntu (systemd)

[`deploy/systemd/agentlink-server.service`](deploy/systemd/agentlink-server.service) runs the bundle as a dedicated `agentlink` system user with state in `/var/lib/agentlink` (`StateDirectory`, `0700`), read-only config in `/etc/agentlink`, and projects in `/srv/agentlink/projects`. The file header lists the install commands. It is hardened (`ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, no capabilities, restricted namespaces and address families) and scores 3.0 ("OK") in `systemd-analyze security`. `MemoryDenyWriteExecute` is deliberately off because V8's JIT needs it. Adjust `ExecStart` if Node is not `/usr/bin/node`.

### macOS (launchd)

[`deploy/launchd/local.agentlink.server.plist`](deploy/launchd/local.agentlink.server.plist) is a LaunchDaemon that runs as a hidden `_agentlink` user with a `0077` umask and restarts on failure. Logs, including the setup credential, go to `/usr/local/var/log/agentlink/server.log`; keep that directory private to the service user. The plist header lists the install commands. API keys use `{ "file": ... }` with a `0600` file.

### Restarts and crashes

Sessions, the owner, devices, and pairings survive restarts. A turn that was running when the process died is marked interrupted at startup. After a hard crash the dead process's turn lease stays valid for up to 30 seconds and is never broken early: the server starts immediately, that session reports `409 session_busy`, and recovery completes in the background once the lease expires.

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
- **Server-owned turns.** A turn or resume runs on the server, not the request: closing the browser does not cancel it. One task runs per session at a time (`409 session_busy`). A cancelled or failed turn leaves the session `interrupted`, which accepts the next turn. Server shutdown aborts running tasks and waits for them.
- **Approvals.** `POST .../interaction` needs `approve` access and reauthentication within the window. The decision names the exact `interactionId` and `interactionRevision` the owner saw. A mismatch returns `409 stale_interaction`, and the host binds the same pair into the engine's atomic resume, so a decision cannot reach a replacement request. Revocation and reauthentication are rechecked immediately before the resume starts, and a revoked session stops reading a stalled request body.
- **Event stream.** `GET .../events` is Server-Sent Events. Events carry `id: <epoch>:<sequence>`. Reconnect with `?epoch=&after=` (or `Last-Event-ID`) to replay retained events. A `reset` control event means the cursor cannot be served (server restarted or the event aged out) and the client should re-read the snapshot. The stream closes on revocation and rechecks the session every heartbeat. A backpressured reader is caught up from the retained log once it drains; one that stays stalled for 30 seconds is dropped and can reconnect.

The event log is in memory, so it only bridges reconnects within one server process. The durable session repository remains the source of truth.

Not yet provided: certificate provisioning and device trust onboarding, recovery when every session is lost, passkeys, command execution and background-agent routes, an installer, and the web app.
