# @agentlink/server

Standalone AgentLink assistant server. Private and experimental: this package currently contains only the access layer. The web app, session streaming, approvals, jobs, and workspace-host composition mount on its authenticated hooks in later slices.

`createAssistantServer(options)` starts an HTTPS-only listener (TLS 1.2+, certificate and key required, no plain-HTTP mode) that owns authentication:

- **Owner bootstrap.** While no owner exists, `start()` issues a 15-minute setup credential to `onSetupCredential`, which must only show it locally. `POST /api/auth/bootstrap` redeems it once with an owner passphrase (12+ characters) and returns a session.
- **Device pairing.** A signed-in, recently reauthenticated owner creates a single-use code (`POST /api/auth/pairings`, 5 minutes). A new browser redeems it at `POST /api/auth/pairings/redeem`. There is no passphrase login for unknown browsers.
- **Sessions.** `__Host-agentlink_session` cookie (`Secure; HttpOnly; SameSite=Strict; Path=/`), 30-day absolute and 7-day idle expiry. `GET /api/auth/session` returns the session and its CSRF token. `POST /api/auth/logout` ends it, and `DELETE /api/auth/devices/:id` revokes a device and all its sessions. The last active device cannot be revoked, because there is no local recovery path yet.
- **Reauthentication.** `POST /api/auth/reauthenticate` checks the scrypt-hashed passphrase. Sensitive routes need it within the last 5 minutes. Hooks receive `recentlyAuthenticated` to apply the same rule to approval, policy, and credential screens.
- **Request guard.** Every request and upgrade is rejected when it carries `Forwarded`, `X-Forwarded-*`, `X-Real-IP`, `X-Remote-User`, `X-Auth-Request-*` or similar identity/proxy headers, when `Host` is not a configured public origin, when `Origin` is foreign, or when `Sec-Fetch-Site` is `cross-site`. Unsafe methods and upgrades require `Origin`. Authenticated unsafe requests also need `x-agentlink-csrf`.
- **Rate limiting.** Setup, pairing, and passphrase guesses are limited per socket address and globally, and attempts still in flight count against the limit. Client headers never select the key.

`handleRequest` and `handleUpgrade` only ever see authenticated requests, with an explicit `{ tenantId: "agentlink-server", subjectId: ownerId }` principal. Project access is not derived from it yet.

State lives in `<dataRoot>/access-state.json` (directory `0700`, file `0600`). Only hashes of setup credentials, session tokens, and the passphrase are stored. A corrupt file stops startup rather than reopening bootstrap. Each write is fsynced, including the directory, before a response reports success. An exclusive `access-state.lock` lets only one live process own a data root; `close()` releases it, and a lock left by a dead process is replaced.

Not yet provided: certificate provisioning and device trust onboarding, a service entry point, recovery when every session is lost, passkeys, and the web app.
