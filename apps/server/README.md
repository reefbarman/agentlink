# @agentlink/server

Standalone AgentLink Assistant. Experimental: authenticated browser chats, coding tasks, scheduled jobs, notifications and personal assistance, using the shared agent runtime. Docker Compose is the reference deployment; systemd and launchd definitions are also provided. The guided release installer below is a preview until images are published and fresh-machine drills pass.

Supported hosts: Linux (Ubuntu) and macOS. The package uses only portable Node.js APIs (Node 22.19+), and its test suite runs on both.

## Guided release installation (preview)

The release-backed installer is under development. The workflow and installer are in the repository, but **no Assistant GHCR release or clean-machine installation has been verified yet**. Do not treat the example below as an available published download until an `assistant-v*` release exists and its packages are publicly pullable.

For an available release, download its `install.sh` asset, review it, then run it as your normal user:

```sh
VERSION=0.1.0 # replace with an actually published assistant-v* version
curl --proto '=https' --proto-redir '=https' --tlsv1.2 -fL \
  "https://github.com/reefbarman/agentlink/releases/download/assistant-v${VERSION}/install.sh" \
  -o /tmp/agentlink-assistant-install.sh
# Read-only check first: no downloads, image pulls or files.
bash /tmp/agentlink-assistant-install.sh diagnose --origin https://assistant.local:8443
bash /tmp/agentlink-assistant-install.sh install --version "$VERSION" \
  --origin https://assistant.local:8443
```

- Supported layouts: a local, rootful Docker Engine **28+** with Compose v2 on Linux (the system socket at `/var/run/docker.sock`), or Docker Desktop on Apple Silicon. `curl`, `openssl` and `sha256sum`/`shasum` are also needed. Missing prerequisites produce instructions, not automatic `sudo` commands. No source checkout, Node, npm or local builds are required.
- `diagnose` reports each check as `pass`, `warning`, `blocked` or `unknown`, with the next step, and exits non-zero if anything blocks installation. `install` runs the same checks and stops before downloading or creating anything if one blocks. Blocked: remote TCP/SSH Docker contexts or `DOCKER_HOST` (endpoint details are not printed), rootless Docker, a non-system Linux socket, non-Desktop engines on macOS (Colima, OrbStack and others), an emulated daemon architecture, existing deployment directories, Assistant containers or local images, an unwritable location, a busy port 8443 and a malformed origin. Warnings: low free space (an advisory 10 GiB threshold, not a measured minimum), an origin that does not resolve on the host, an IP-address origin, Intel Macs and macOS locations outside Docker Desktop's default shared folders. Image pulls, actual bind mounts, child containers and client certificate trust can only be verified by installing and on each device.
- The installer explains the deployment location, port 8443 exposure, root-equivalent runner-manager Docker socket access, certificate trust and same-host backup limitations before asking for confirmation. `--yes` explicitly skips that confirmation for reviewed automation; non-interactive installation also needs `--origin`.
- The standard stack includes the Assistant, command worker, egress gateway, publisher, runner manager, backup sidecar, a separate append-only witness and a separate update supervisor. It creates private configuration, data and secret directories in `~/agentlink-assistant`, a witness in `~/agentlink-assistant-witness` and the supervisor's state in `~/agentlink-assistant-updater`. Use `--deploy /absolute/path` to choose another location. Existing directories, Assistant containers or local images are refused rather than overwritten. It does not convert the Framework's existing source-built deployment.
- Every image, including the witness's pinned `restic/rest-server`, is pulled before any deployment state is created, so a registry or network failure leaves nothing behind and can simply be retried. A failure after that point keeps all three directories and prints recovery commands that start the witness, the update supervisor and the Assistant in that order with the original configuration and secrets. Do not rerun a fresh install over a retained installation; it is refused.
- The chosen HTTPS hostname/IP must already resolve to the machine. Docker publishes port 8443 on all interfaces, outside host firewalls such as ufw. The installer does not change DNS/mDNS, firewall/router rules or certificate trust stores. When it finishes it says whether the first backup succeeded; without one, setup is reported as degraded. The printed next steps, in order: save the backup password off the machine, trust the local CA on each client after checking the printed SHA-256 fingerprint, pair the first browser (pairing does not need a model sign-in), then sign in to ChatGPT in the setup guide that opens in that browser (the terminal `codex-login` remains a fallback). Same-host backups do not protect against losing the host or disk.
- GitHub can initially connect with a fine-grained token in the app; GitHub App device sign-in still needs an operator-supplied client ID. The optional editor and browser research features are off after installation and are turned on with the installer (see [Optional features, uninstall and recovery](#optional-features-uninstall-and-recovery)). Meridian and SearXNG remain advanced setup by hand.

After installation, use the script kept in the deployment directory:

```sh
bash ~/agentlink-assistant/install.sh status
bash ~/agentlink-assistant/install.sh pair
bash ~/agentlink-assistant/install.sh diagnose --deploy /a/new/location   # before another fresh install
bash ~/agentlink-assistant/install.sh capabilities
bash ~/agentlink-assistant/install.sh enable editor    # or: disable editor, enable browser, ...
bash ~/agentlink-assistant/install.sh uninstall        # keeps every file; undo with: resume
bash ~/agentlink-assistant/install.sh recover          # after an interrupted change
# Legacy releases only (managed releases use Settings → Updates):
bash ~/agentlink-assistant/install.sh update --version X.Y.Z
bash ~/agentlink-assistant/install.sh rollback
```

Updates fetch an explicit release manifest with immutable GHCR image digests, validate it as data (never source it as shell), ask before interrupting work, and reuse the existing drain/backup/health-check/rollback flow. An update failure at service startup or health checking attempts rollback. Installed configuration and secrets are preserved. Downgrades use rollback, not `update`. No automatic background updating is enabled.

### Browser updates for managed releases

**Settings → Updates** shows the installed version/commit, compatible newer releases and release notes. Checks use the shared GitHub release cache, with bounded daily background checks, manual refresh, stable-by-default discovery and an explicit preview preference. Preferences, cached notes and check failures persist across supervisor restarts. Discovery never applies an update and does not send update notifications.

Only the signed-in owner can confirm an update or rollback. Confirmation explains interruption and backup/restore consequences. Progress is durable outside Assistant app data, so closing the browser or restarting the Assistant does not abandon the operation. Reopen Settings after a disconnect and reload the app when the operation finishes. Do not retry an interrupted operation without inspecting deployment status.

A separate `agentlink-updater` Compose project uses an immutable updater image and fixed job commands, paths and networks. It has root-equivalent Docker socket access and mounts only the exact deployment and updater directories. The main Assistant gets a private token-authenticated connection, not Docker access or updater state. `/api/updates` is owner-only deployment management, not an agent tool or remote shell. Requests cannot select commands, URLs, images or filesystem paths.

Managed releases carry `assistant-deployment.json` with schema/protocol and hashes for canonical management assets. The updater rejects unknown or locally modified templates before mutations, downloads and verifies exact-release assets, then updates scripts/Compose files transactionally with the immutable images. Configuration and credentials are preserved. Existing drain, backup, health-check and rollback safeguards apply. Rollback also restores previous management assets and pre-update data, retaining later data aside and pausing scheduled jobs. The standalone supervisor is restarted last, after reconnecting progress is durable.

Existing source-built or legacy deployments remain command-line-only, with no automatic conversion. Managed installs refuse direct `install.sh update`/`rollback` and require Settings so images, data and the separate supervisor's management files stay in one transaction. A general managed command-line frontend is deferred; do not bypass this guard with a raw image-only upgrade. A failed first install keeps its directory and logs for inspection rather than silently removing data. **Still unqualified:** published image availability/public pulls, first-run browser onboarding, fresh Linux/macOS drills, Docker Desktop login/startup and host sleep behaviour.

#### Interrupted managed update recovery

While a shell command is active, graceful job shutdown forwards termination to the upgrade script and allows recovery to finish. Termination between commands, power loss, forced kill or a Docker shutdown deadline can still leave a partial transaction. Such operations are reported as interrupted and are never automatically replayed. If release metadata is temporarily inconsistent, update controls remain unavailable rather than guessing the installed state.

Operator checklist:

- Inspect the persisted `DEPLOY-updater/current-operation.json`, its `operations/<id>.json`, the matching `agentlink-updater-job-<id>` container/logs, and `DEPLOY/.upgrade-state`. Do not source state files as shell.
- Do not remove locks or start recovery while an update/rollback job or upgrade process is still running. Stop new Assistant work and retain a copy of the deployment, updater state and backups before repairing anything.
- Once every writer is confirmed stopped, an empty stale `DEPLOY/.upgrade-lock` can be removed deliberately with `rmdir`. Inspect the recorded backup and `.upgrade-assets-previous`/`.release-previous.env` before using the installed `upgrade.sh rollback --deploy DEPLOY` as an operator recovery action. Unlike the browser, this raw script does not restore the standalone supervisor.
- If `.upgrade-updater-previous` exists for that same transaction, its `compose.yaml` and `.env` are the paired supervisor recovery files. Restore them to the updater directory while preserving original ownership/modes, retain `updater-token` and operation history, and restart the separate updater project. Do not mix versions from different transactions or regenerate secrets. If the backup or pairing cannot be established, stop and recover from the retained backup rather than forcing another update.
- Verify the restored version, smoke check and backup status before resuming work. A successful data rollback pauses scheduled jobs; review them before re-enabling.

### Optional features, uninstall and recovery

Managed release installations have two optional features, both off by default:

| ID        | Name                    | What it adds                                                                                                                                                                                                                      |
| --------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `editor`  | Edit task workspaces    | **Open editor** on coding tasks (see [Editor takeover](#editor-takeover)). Publishes port **8444** on all host interfaces with the app's certificate, outside host firewalls such as ufw. Refused if port 8444 is already in use. |
| `browser` | Research with a browser | Throwaway, signed-out headless Chromium for chats on Open web projects (see [Browser research](#browser-research)). Every request goes through the egress gateway.                                                                |

Both need session runners as the installer set them up. `install.sh capabilities` lists each one as `enabled`, `disabled`, `changed-by-hand` or `unavailable: <reason>`. Settings → Setup → Connections shows the same state and the command to run; the browser cannot run it. Meridian and SearXNG stay advanced setup by hand (below).

`enable` and `disable` take only those two fixed names. They use the installed release's own hash-checked template and digest-pinned image (nothing here accepts a Compose file, image, port or path), explain the exposure and resource use, and ask before changing anything. Then, in order: they pull the image, drain running work, take a backup, change `COMPOSE_FILE` in `.env` (the only record of what is selected) and the one matching `server.json` line, start the Assistant and wait for its smoke check. If the Assistant does not start cleanly, the saved `.env`, `server.json` and template set are put back and started again. Disabling also stops that feature's per-task containers; its template and image stay, so turning it back on needs no download. Selected features carry through browser updates and rollbacks unchanged.

Hand-edited setups are left alone: a feature that is only half configured, a `COMPOSE_FILE` that is not a plain list of this release's templates, a `server.json` without the installer's layout, a source-built deployment, or a release older than the lifecycle protocol (`"lifecycleProtocol": 1` in `assistant-deployment.json`; update in Settings first) is refused with instructions.

`uninstall` drains work, then stops and removes only the containers and networks of the Assistant, update supervisor and backup store, plus the runner, editor and browser containers they started. It never removes volumes, images or other containers, and **nothing is deleted**: configuration, secrets, chats, projects, update history and the backup repository all stay in `~/agentlink-assistant`, `~/agentlink-assistant-updater` and `~/agentlink-assistant-witness`. `resume` starts them again in order (backup store, supervisor, Assistant) with the same configuration and secrets; work interrupted by the uninstall can be resumed from its chat or the Tasks panel. Browser updates are refused while uninstalled. To remove the Assistant for good, first make sure you no longer need its backups (the backup store holds them, and `secrets/backup-password` is needed to read them), then delete the three folders yourself. Also revoke any GitHub tokens or app access you gave it and remove its CA from the devices that trust it. There is no scripted deletion.

**The deployment guard.** Browser updates and these commands never run at the same time. Each holds `~/agentlink-assistant-updater/.deployment-mutation-lock/` (its `owner` file says who) for the whole change, and the installer records its progress in `~/agentlink-assistant-updater/.lifecycle-state.json`. Updates are refused (`update_lifecycle_busy`) while the guard is held or a change is unfinished, and installer commands are refused while an update holds it or `.upgrade-state` is not settled. If a browser update's own recovery fails, or the job is terminated mid-transaction, the update keeps the guard: recover by hand with [Interrupted managed update recovery](#interrupted-managed-update-recovery), then remove the guard directory (`rm -r UPDATER/.deployment-mutation-lock`) only once every writer is stopped and the deployment checks out. Before running Compose, every command checks that the selected templates and the supervisor's `compose.yaml` are this release's exact copies; a hand-edited one is refused. Task containers are removed only when both their `dev.agentlink.<kind>` label and their `agentlink-<kind>-<id>` name match.

If an installer command is killed part-way, the guard and an unfinished journal stay in place and every update and command is refused until you run `install.sh recover`. Recover puts back the `.env`, `server.json` and template set saved before that change (in `UPDATER/lifecycle-recovery/`, only if they belong to that same change), restarts the Assistant and checks it; for an interrupted uninstall or resume it starts everything again. It refuses while the process that held the guard is still running, never clears a guard held by a browser update (follow [Interrupted managed update recovery](#interrupted-managed-update-recovery) instead), and keeps the guard if the saved files do not match or the restart fails. A guard left by a command that recorded no change can be released by `recover` after confirmation. An unreadable journal is never treated as settled: inspect it and `UPDATER/lifecycle-recovery/` by hand, restore the saved `env` (as `.env`) and `server.json` if the change was part-applied, start the Assistant, then remove the journal and guard yourself.

For legacy operators, `upgrade.sh --deploy DIR --release-manifest FILE` retains the image-only released-image path. `--validate-release` validates a manifest without Docker or an existing deployment. Omitting `--release-manifest` retains the source-build workflow below. Do not use this image-only path to bypass managed update transactions.

## Running the server

`npm run build --workspace apps/server` bundles everything into one file, `dist/agentlink-server.js`, which runs with Node 22.19+ on Linux and macOS.

```sh
agentlink-server --config /etc/agentlink/server.json --check   # validate and exit
agentlink-server --config /etc/agentlink/server.json           # serve until SIGTERM/SIGINT
agentlink-server pair --config /etc/agentlink/server.json      # print a sign-in code and QR
agentlink-server export-ca --config /etc/agentlink/server.json > agentlink-ca.pem
agentlink-server codex-login --config /etc/agentlink/server.json # sign in with ChatGPT
agentlink-server codex-logout --config /etc/agentlink/server.json
```

`--config` can be omitted when `AGENTLINK_SERVER_CONFIG` names the file; the container image sets it.

`--check` validates the configuration, TLS certificate and key, project directories, and provider secrets without taking locks or listening. While no device is signed in, the server logs a reminder to run `agentlink-server pair`; see [Signing in](#signing-in). SIGTERM stops running turns, waits for them, and exits 0. A second signal exits immediately.

### Web app

Open the first `publicOrigins` URL in a browser. The server serves the same Ask Agent interface as AgentLink's browser remote gateway, from the same origin:

- **Signing in:** see [Signing in](#signing-in). A browser that is not signed in is sent to `/pair`.
- **Projects:** the switcher at the top of the sidebar picks the project the chats belong to. Each project has its own chats, and turns in different projects run at the same time. The selection is per browser (a cookie), so a phone and a laptop can be in different projects. See [Projects](#projects).
- **Chats:** the Ask Agent chat list, transcript, composer, model picker, and tool rendering, with the server's configured models. The work keeps running if you close the tab or switch to another chat, and reopening it (on any device) picks up a turn in progress.
- **Status:** each chat in the list shows a spinner while it is working, an amber dot when it is waiting for an approval, and a dot when it finished while you were in another chat (or had no window open), until you open it. The project switcher shows the same for other projects, as one dot on the switcher and one per project in its menu. The page refreshes these every few seconds while it is visible. A project only reports status once it has been opened since the server started.
- **Approvals:** a chat works on its own by default: file edits and foreground commands in the project, and the same from background agents it starts (inside their scopes), run without asking. It still asks before writing protected files (`.env*`, `.git`, `.agentlink`, `.claude`, and instruction files such as `AGENTS.md`), before background commands, and for an agent's MCP calls. Jobs and their changes always ask, and so does the first task for a repository; more work on a repository you already approved a task for starts without a card (see [Coding tasks](#coding-tasks)). Approvals appear as cards above the composer and need no second sign-in. A chat can instead ask for everything through the [approval mode](#approval-mode) route.
- **Long-running work:** see [Long-running work](#long-running-work). A chat or task works until it is done or you press Stop, with no step or time limit, carries on by itself while its todo list has unfinished items, and tells you through the Inbox when it has worked a long time or looks stuck.
- **Files:** clicking a file link in a chat (for example `AGENTS.md`, or a path the agent mentions) opens a read-only viewer with syntax highlighting, scrolled to the linked line. It shows text files inside the selected project only (symlinks out of the project and binary files are refused), up to the first 1 MB of a file. Editing happens through the chat.
- **Background agents:** agents the open chat launches (for example a review on the review model) appear as Agent Fleet cards above the composer, as in VS Code. A card shows progress and lets you open the agent's transcript (its file links open the viewer), steer it, or stop it; anything it asks to run shows up as an approval card. Pause, resume, detach, retry and archive are not available yet, and only the open chat's agents are shown. The strip hides when nothing is running; `/fleet` reopens it.
- **Several chats at once:** writing in one chat while another is working, or waiting for an approval, does not wait for that chat. Its turn carries on in its own chat (it shows as running, or **Needs you** in the chat list) with its approval card shown only there, answered or stopped from that chat, and the new chat answers straight away. A message written into a chat that is working is queued there and taken in at the turn's next break, as in VS Code; **Remove** takes a queued message back (it never runs) and **Edit** changes it, unless the turn has already taken it in.
- **Background results:** when an agent finishes, its result appears in the chat as a result card and the chat picks it up on its own, reporting the outcome and carrying on, without you asking. This happens once per agent, after any turn already running, and not if the chat already read the result with its tools or you pressed Stop. (VS Code's chat usually waits on the agent within its turn instead.)
- **Approval mode:** the toolbar button under the composer switches the open chat between **Auto-run** (the default described above) and **Ask first**, where every file change and command waits for your approval.
- **Management panels:** Settings groups identity/persona, time zone/quiet hours, and storage into sections, with Save changes enabled only after an edit. Tasks can be searched by objective, repository or branch and filtered to Active, Needs you or Finished; lists show the most recently updated first. Jobs can be searched by name, instructions or project. Panels keep their title and Close button visible while the contents scroll, contain keyboard focus and return it to the opener when closed; Escape closes the topmost panel unless it is saving.
- **Devices:** `/devices` lists signed-in devices, revokes them, and creates pairing codes for new ones.
- **Setup:** a fresh guided installation opens a setup guide in the first paired browser: connect ChatGPT or add an [OpenAI API key](#openai-api-key-from-the-browser), confirm the Assistant's name, your time zone (the device's is offered, not applied silently) and quiet hours, see the optional GitHub and MCP connections, then a check of models, backups and the backup password. Every step can be skipped; progress is kept on the server (`<dataRoot>/settings/onboarding.json`, written first by the installer), so a reload or another paired device carries on. Closing it means "later": it does not open again, and **Setup** in the toolbar reopens it, with a mark until setup is finished and backups work. Installations without that file (existing or hand-made) only get the toolbar entry. The record holds progress and the owner's acknowledgements only, never credentials; the summary always re-reads the real sign-in and backup state, so a finished checklist does not hide a later failure. Setup never starts a task, creates a job or connects a service by itself. Owner-only: `GET`/`PATCH /api/onboarding`, with a revision check against stale tabs.

The UI is the browser gateway bundle (`src/browser-gateway/webview/` in the repository), built by `esbuild.mjs` into the server bundle and served from fixed paths (`/browser-gateway.js`, `/browser-gateway.css`, and hashed, immutable `/browser-gateway-chunks/*`) without a session, since those files hold no data. The page itself (`/`) needs a session and gets a per-response script nonce. The Host, Origin, and forged-header checks still apply, and every `/api/` path needs a session. `askAgentBridge.ts` answers the UI's Ask Agent API from one project's workspace host, and `projectChats.ts` routes each request to the selected project's bridge. Chat titles and hidden chats are stored in `<dataRoot>/settings/chats/<project>.json` (the first configured project keeps `<dataRoot>/settings/ask-agent-state.json`). Not yet supported: attachments and notifications.

### Projects

A project is a folder the assistant works in, with its own chats and settings. The ones in `projects` are always there; with `projectsRoot` set, **New project…** in the switcher creates more:

- **Empty:** a new folder, for notes, research, or anything not in git yet.
- **Git repositories:** one or more `https://` clone URLs, cloned side by side into one folder each (`api/`, `web/`, …). Clones run through the [command worker](#command-worker) and its egress gateway, and may reach any public host (with an [egress policy key](#network-presets); without one, only the gateway's allowlist). Git never prompts: private repositories, and URLs with credentials, are not supported yet. If any clone fails the folder is removed and git's output is shown.

**Project settings…** changes the name, the model and thinking level new chats start with, the project's instructions (its `AGENTS.md`, which every chat reads), and its [network](#network-presets). Created projects and all settings are stored in `<dataRoot>/settings/projects.json`. Removing a project from the app is not supported yet.

### Network presets

Each project picks how much of the internet its commands and web tools can reach:

| Preset                 | Commands (through the egress gateway)                                       | `web_fetch`           | `web_search` |
| ---------------------- | --------------------------------------------------------------------------- | --------------------- | ------------ |
| **Open web** (default) | Any public HTTPS site                                                       | Any public HTTPS page | Yes          |
| **Dependencies only**  | The [dependency allowlist](#egress-gateway), plus the project's extra sites | The same hosts        | No           |
| **Off**                | Nothing                                                                     | Not offered           | Not offered  |

**Extra sites** (one host per line, `*.example.org` for subdomains, up to 100) add to the Dependencies only list. Whatever the preset, private, loopback, and other non-public addresses, sibling containers, plain HTTP, and ports other than 443 are always refused. Changes apply to the next command or tool call; no restart.

How it is enforced: the assistant signs the project's preset into each command's proxy credentials (an HMAC with `commandWorker.egressPolicyKey`), and the gateway, which holds the same key, checks the signature before applying it. A command cannot widen its own access: an altered policy, or a request with no credentials at all, gets `407`, so a command in an Off project cannot drop its credentials to reach the dependency hosts. (Clients that only send credentials when challenged, such as the research browser, retry with their signed policy.) Without a policy key every project gets the dependency allowlist whatever its preset (the startup log says so).

### Web tools

Chats get two read-only tools that run without asking:

- **`web_fetch`** reads one public HTTPS page as text (HTML converted, links kept as `text (url)`), in parts of up to 60,000 characters for long pages. `http://` is upgraded; redirects are followed and checked again. With an egress gateway it goes through it with the project's signed policy, exactly as a command would; otherwise the server makes the same checks itself. Only `GET`, at most 3 MB per page, text formats only.
- **`web_search`** (Open web only) uses Codex's hosted search for Codex models (needs the ChatGPT sign-in), and [SearXNG](#searxng) for every other model when `web.searxngUrl` is set. Without either, it is not offered.

### MCP servers

The **MCP** panel connects remote MCP servers (streamable HTTP, such as a service's official `https://…/mcp` endpoint) so chats and coding tasks can use them:

- **Adding one:** a name, the HTTPS address (a public host: no loopback, LAN or container names), and how it signs in: none, **Sign in with the service** (OAuth; **Sign in** opens the service's page and you come back to the app), or an API key header. Header values and OAuth tokens are encrypted in `data/credentials/mcp/` and never sent back to the app.
- **Ask, Run, Off:** every tool starts on **Ask**: each call shows an approval card with the tool and its arguments, even in an autonomous chat. **Run** lets calls through without a card; **Off** hides the tool. A tool that is new, or whose description, schema or annotations change when the server is tested, goes back to Ask (an Off tool stays off), an Inbox entry says so, and a call waiting on a card for it is refused. Servers are tested when added, from **Test**, and after signing in.
- **Always ask.** Some tools can never be set to Run: names that send, reply, forward, archive, trash, delete, remove, move, mark, invite, RSVP, accept, decline or cancel; names that create, update, edit, add, set, modify or draft an event, message, draft, label, thread, invitation, filter, reminder, contact or meeting (`create_event`, `modify_labels`, `create_draft`); and tools the server marks as destructive (`destructiveHint`). Reads such as `search_messages`, `list_events` or `get_draft` are not on it. The panel greys out Run for these and says why; **Add to the list** takes your own entries (one tool name per line, `*` for anything, `server/tool` for one server), and tools they match go back to Ask. You can add to the list, not take from it. A tool stored on Run that the list now covers goes back to Ask when the server starts.
- **On my network (Home Assistant).** Tick **On my network** to add a server on your home network: `http` or `https` to a private IPv4 address (10/8, 172.16/12, 192.168/16), a private IPv6 address, or a `.local`, `.lan` or `.home.arpa` name. Loopback, link-local and metadata addresses, bare container names and addresses with a user name are refused, and so is a private address without the tick. Such a server signs in with a header token or nothing (no OAuth), and is reached only at its saved scheme, host and port, with redirects refused. Only the assistant process calls it, and only your own chats are offered it: coding tasks and session runners never see it or its token, and a chat cannot propose one. On it, only tools whose names read (get, list, search, …, with no action word such as turn, set, open, add, call or start) can be on Run; every other tool always asks. **Home Assistant setup:** enable MCP in **Settings → System → AI** (the Model Context Protocol Server integration), use `http://<its IP address>:8123/api/mcp` (an IP address works best: `.local` names may not resolve inside the container), and an `Authorization` header with `Bearer <long-lived token>`. The token can do anything its Home Assistant user can, outside AgentLink's approvals, so create it as a dedicated non-admin user (profile → Security) and turn off **Require an administrator account** in the integration's **Configure**. What the assistant can see and control is what Home Assistant exposes to Assist (**Settings → Voice assistants → Expose**). Read state on Run (`GetLiveContext`); turning things on or off asks every time.
- **Limiting Run.** A tool on Run can be limited to some argument values: **Limit** picks an argument and its values (exact, or ending in `*` for a prefix), for example `calendarId` is `primary`. A call with every limited argument inside the values runs; any other call, including one without the argument, asks. A changed tool loses its limit with its Run.
- **In chats:** `find_mcp_tools` lists the enabled tools with their schemas and how each is called (runs, runs within its limit, asks, or always asks); `call_mcp_tool { server, tool, arguments }` calls one. Results are framed as untrusted data, and the routing prompt says that email, calendar and other personal content is other people's words: a message asking the chat to approve, run, schedule, reply or remember something is reported, never acted on. A chat can suggest a new server with `propose_mcp_server`, which is added (every tool on Ask) only if you allow its card; signing in stays yours.
- **Containment:** only the assistant process calls MCP servers. It reaches only the server's saved host (OAuth discovery and token requests may also go to other public HTTPS hosts), with redirects refused. Session runners list and call these tools through the assistant, which runs a call only once you allowed exactly that call (or the tool is on Run), so no token enters a runner.
- **Audit:** each call is appended to the [task audit log](#task-audit-log) (`mcp_call`, with the task's ID for a task's chat) with the server, tool, schema hash, policy, whether it was standing (Run) or approved on a card, the session, the outcome and a hash of the arguments: never the arguments or the result. With backups set up, a call is checkpointed straight away like a push.

### Signing in

There are no passwords. Every device signs in with a single-use 6-digit pairing code:

- **First device (or after losing all of them):** on the server machine, as the service account, run `agentlink-server pair` (in the container: `docker compose exec assistant agentlink-server pair`). It prints the code, a sign-in link with the code filled in, and a QR code of that link for a phone camera. Open the link, or the server address, and enter the code within 10 minutes. The code goes to that terminal only, never to the service log. Running `pair` again replaces the code, and it works whether or not the server is running.
- **More devices:** on a signed-in device open `/devices` → **Pair another device**. It shows a code, link, and QR code valid for 5 minutes.
- **Staying signed in:** a session lasts 30 days, or 7 days without use. Revoking a device on `/devices` signs it out everywhere at once.

### Configuration

One JSON file. Relative paths resolve against its directory, and unknown keys are rejected so a typo cannot silently drop a setting. Examples: [`deploy/server.linux.example.json`](deploy/server.linux.example.json) and [`deploy/server.macos.example.json`](deploy/server.macos.example.json).

| Key             | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dataRoot`      | Access state (`server/`), workspace session data (`workspace/`), session event logs (`events/`), and the local CA (`tls/`). Created `0700`.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `listen`        | `{ host, port }`. Bind a LAN address explicitly; there is no default.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `publicOrigins` | Exact `https://` origins browsers use. The `Host` header must match one.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `tls`           | `{ "localCa": true }` (see [Device trust](#device-trust)), or `{ certFile, keyFile }` with a key not readable by others (`0600` or `0640`).                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `providers`     | `codex` (ChatGPT sign-in), `openai` (`apiKey`), or `openai-compatible` (`baseURL`, `models`, and `apiKey` or `noAuth: true`). `codex` and `openai` offer AgentLink's full model catalog, the same list as the extension's picker; `modelIds` narrows it. Remote providers must use HTTPS; see [Meridian](#claude-models-meridian) for the container exception. See [Models and thinking levels](#models-and-thinking-levels).                                                                                                                                                            |
| `defaultModel`  | `{ providerId, modelId }`. The model must be declared by that provider. A model chosen in **Setup** on a guided installation takes precedence (see [OpenAI API key from the browser](#openai-api-key-from-the-browser)).                                                                                                                                                                                                                                                                                                                                                                 |
| `modelRoles`    | Optional. `{ "review": { providerId, modelId } }` names the model a client gets when it creates a session with `{ "role": "review" }`, for example Claude through [Meridian](#claude-models-meridian). The model must be declared.                                                                                                                                                                                                                                                                                                                                                       |
| `projects`      | `[{ id, label?, root }]`. Each is mounted at `/api/projects/<id>` with file tools enabled. Commands run only when `commandWorker` is set.                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `projectsRoot`  | Optional absolute directory where [projects](#projects) created in the app are made, one folder each. Without it the app cannot create projects. With a command worker it must be inside the worker's roots at the same path (`/srv/agentlink/projects` in the container).                                                                                                                                                                                                                                                                                                               |
| `commandWorker` | Optional. `{ host, port, token, shell?, egressProxy?, egressPolicyKey? }`: the [command worker](#command-worker) that runs approved commands. `host` is loopback or a container name; `token` is a secret source; `shell` defaults to `/bin/bash`; `egressProxy` is the [egress gateway](#egress-gateway) (`http://<loopback or container>:<port>`); `egressPolicyKey` is a secret source shared with the gateway (at least 32 bytes, for example `openssl rand -hex 32`) that turns on per-project [network presets](#network-presets). Without `commandWorker`, commands are disabled. |
| `web`           | Optional. `{ searxngUrl }`: a [SearXNG](#searxng) instance for `web_search` with models other than Codex, for example `http://searxng:8080`. The server calls it directly, so it may be on a private network.                                                                                                                                                                                                                                                                                                                                                                            |
| `notifications` | Optional. `{ contact?, includeSummary? }` for [notifications](#notifications). `contact` is a `mailto:` or `https:` address the push services can reach you at about this server. `includeSummary: true` puts a finished run's summary in the notification; by default it shows only the job name and outcome.                                                                                                                                                                                                                                                                           |
| `publisher`     | Optional. `{ host, port, token }`: the [publisher](#publishing-tasks-to-github) that holds the GitHub connections and publishes coding tasks. `host` is loopback, a private address or a container name; `token` is a secret source the publisher also reads. Without it, tasks stop at `ready` and GitHub cannot be connected.                                                                                                                                                                                                                                                          |
| `ripgrepPath`   | Optional absolute `rg` binary for `search_files`. With a command worker, this is the worker's path (`/usr/bin/rg` in its image).                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

API keys are never inline. `{ "file": "/path" }` reads a file that must not be readable by group or others. `{ "credential": "name" }` reads `$CREDENTIALS_DIRECTORY/name`, which systemd provides through `LoadCredential=` or `LoadCredentialEncrypted=` (use `systemd-creds encrypt` to bind the key to the TPM). Keys are reread on each use, so rotation needs no restart.

### ChatGPT sign-in (Codex)

A `{ "type": "codex", "id": "codex" }` provider uses a ChatGPT subscription instead of an API key. The server has no browser, so `codex-login` prints a sign-in link to open on any device. After signing in, that browser is sent to an `http://localhost:1455/auth/callback?...` address that does not load; paste that address back into the command. The pasted address must carry the state of the flow the command started, so an address from another sign-in is refused.

The browser can do the same from **Setup** (owner-only `/api/providers/codex` routes): **Sign in with ChatGPT** opens OpenAI's sign-in in a new tab, and you paste the `http://localhost:1455/...` address it ends on into the form. The server never fetches that address; it checks it against the waiting sign-in and exchanges only its code with OpenAI. One sign-in waits at a time, for ten minutes, tied to the device that started it: another device sees it is waiting and cannot cancel or finish it. Each link works once, and the device is checked again before the account is saved, so a device revoked meanwhile saves nothing. The address, code and tokens are never stored in the browser, returned or logged. A server with no `codex` provider reports that its models are operator-managed and never adds one.

Tokens are stored in `<dataRoot>/credentials/codex-sign-in.json` (directory `0700`, file `0600`; the server refuses a file others can read) and refreshed automatically. Run the command as the service account. The running server and the command share the file under a lock, so signing in or out takes effect without a restart. A server with no sign-in still starts; `--check` and the startup log say whether it is signed in, and model requests fail until it is. Signing in again with the same account updates it; a different account is added and becomes active. `codex-logout` removes every stored sign-in.

### OpenAI API key from the browser

A guided installation can use an OpenAI API key instead of (or as well as) ChatGPT, set up in **Setup** with no `server.json` change. The installer opts in by writing `<dataRoot>/settings/model-providers.json`; an installation without that file (source-built, hand-made or older) keeps `server.json` as its only provider configuration. Only AgentLink's built-in OpenAI provider is offered, with the fixed ID `openai` and the maintained model catalog: the owner-only routes (`/api/providers/openai`, `/api/providers/openai/key`, `/api/providers/default-model`) take a key and a model choice, never an address, file name, path or command. Custom OpenAI-compatible endpoints and Claude through Meridian remain `server.json` configuration.

- **Billing.** API use is billed by OpenAI to the key's account, separately from any ChatGPT subscription. Saving a key only checks its shape (`sk-…`) and stores it; nothing is sent to OpenAI until a chat uses it, so the first chat is the first billed request.
- **Storage.** The key is written atomically to `<dataRoot>/credentials/openai-api-key` (directory `0700`, file `0600`) and backed up with the rest of `data/`. Responses show only its state and a label such as `sk-…abcd`; the form field is write-only and cleared after every attempt. A failed save keeps the previous key, and a stale tab's change is refused.
- **Live.** Every chat, task, scheduled run, session runner and task editor reads the key on each request and sees the models and default chosen here at once, without a restart. Running requests are not changed, and a task editor that is already open keeps the model list it started with until it is reopened (a new editor starts on the current default).
- **Default model.** Choosing a model for new chats is a separate, explicit step, limited to models usable now (an OpenAI model needs a saved key). It is stored with the opt-in file; **Use the server's default** goes back to `server.json`'s `defaultModel`. Removing the key keeps that choice: new chats on it fail with "No OpenAI API key is saved" rather than quietly using another provider, until a key is added or another model is chosen. A stored choice this release no longer offers is reported and not used.
- **Operator-managed OpenAI.** If `server.json` already declares an `openai` provider (or another provider with the ID `openai`), the browser shows it as set up by the operator and cannot replace or remove its key.
- A missing or unreadable key never stops the server: it starts, reports the problem, and model requests on OpenAI fail until the key is fixed.

### Models and thinking levels

The model picker shows every model the providers declare, each with its own thinking levels.

- **Codex and OpenAI.** Without `modelIds` the provider offers the full catalog, with each model's context window, image support, and thinking levels taken from AgentLink's catalog. `"modelIds": ["gpt-6.1-sol"]` limits the list; unknown IDs are refused at startup.
- **OpenAI-compatible.** Each entry in `models` declares its own limits: `contextWindow`, `maxOutputTokens`, `supportsToolUse`, `supportsThinking`, `supportsImages`, and optionally `reasoningEfforts` (any of `low`, `medium`, `high`, `xhigh`, `max`) with a `defaultReasoningEffort` from that list. A model without `reasoningEfforts` has no thinking control. The provider's `reasoningEffortMode` says how the level is sent: `reasoning_effort` (Meridian and most OpenAI-compatible servers), `reasoning.effort` (OpenRouter), `output_config.effort`, or `none`. `timeoutMs` raises the request timeout for slow models.
- These match the extension's `agentlink.openaiCompatible.connections` settings, so a connection can be copied across: `baseUrl` becomes `baseURL`, and the API key moves to a file (`"apiKey": { "file": "/run/secrets/<name>" }`) instead of the extension's secret storage.

### Container (Docker)

The supported deployment. [`deploy/container/Dockerfile`](deploy/container/Dockerfile) builds two images from one bundle: the assistant on a distroless Node 22 base (no shell, no package manager, no git), and the [command worker](#command-worker) (Debian slim with bash, git, ripgrep, curl, wget, jq, python3, npm, and pnpm and yarn through Corepack). [`deploy/container/compose.yaml`](deploy/container/compose.yaml) runs both as non-root users with read-only root filesystems, no capabilities, `no-new-privileges`, an init process, and bounded logs. The host keeps no firewall or service-account changes; only the directories you mount are visible. The same images run on Linux and on macOS with Docker Desktop.

```sh
# Build (from the repository root)
npm run build:workspaces
docker build -t agentlink-assistant:local -f apps/server/deploy/container/Dockerfile apps/server
docker build --target command-worker -t agentlink-command-worker:local \
  -f apps/server/deploy/container/Dockerfile apps/server

# Deploy directory: compose.yaml, server.json (from deploy/container/server.example.json)
mkdir -m 700 data secrets && mkdir -p projects/home
(umask 077 && openssl rand -hex 32 > secrets/command-worker-token)
(umask 077 && openssl rand -hex 32 > secrets/egress-policy-key)
docker compose up -d
docker compose logs assistant                                  # CA fingerprint
docker compose exec assistant agentlink-server codex-login     # ChatGPT sign-in
docker compose exec assistant agentlink-server export-ca > agentlink-ca.pem
docker compose exec assistant agentlink-server pair            # sign in a device
```

- **Smoke test.** After building the images, `apps/server/deploy/container/smoke-test.sh` starts the shipped `compose.yaml` and `server.example.json` as a throwaway project on `127.0.0.1:18443` (`AGENTLINK_SMOKE_PORT`). It checks the users, that the assistant has no shell, that `--check` reaches the worker, that the host policy and `export-ca` work, that the worker refuses connections from its own container, that commands reach npm only through the egress gateway (which refuses unlisted hosts, sibling containers, other ports, and IP addresses), and that a canary service on the host is unreachable from the worker, then removes everything. It is safe next to a running deployment and is what CI runs on Linux.
- **Ownership.** The container runs as uid/gid 1000 by default (`AGENTLINK_UID`/`AGENTLINK_GID` in `.env`), so `data/` and `projects/` belong to the host user. Create them before the first start, or Docker creates them owned by root.
- **Network.** The port is published on all addresses by default (`AGENTLINK_PUBLISH`, for example `192.168.1.20:8443`, narrows it). Docker publishes ports outside ufw, so ufw neither blocks nor protects it. Binding a single LAN address fails at boot if that address is not up yet. The server answers only HTTPS, only for `publicOrigins`, and only to signed-in devices.
- **Config.** In the container, `listen` is `0.0.0.0:8443`, `dataRoot` is `/var/lib/agentlink`, and project roots are under `/srv/agentlink/projects`. `publicOrigins` lists the addresses devices use on the LAN.
- **Restarts.** `restart: unless-stopped` brings it back after a crash or reboot. Locks record the hostname and process start time, so a lock left by the previous run of the same container is not mistaken for a live one when the new process gets the same PID.
- **Admin commands.** Use `docker compose exec`, which runs inside the service's container. A separate container on the same `data/` (`docker compose run`, or a recreated container after a crash) cannot check the holder's PID, so it honours a lock until its 15-second heartbeat is 60 seconds old; a recreated container may restart a few times before it acquires its locks.

### Command worker

The assistant never runs commands itself; its image has no shell. When `commandWorker` is configured, `execute_command`, git, and ripgrep run in the `command-worker` service. Foreground commands run without asking unless the chat asks for everything; background commands always ask (the server sends no allow rules).

- **What it sees.** Only `projects/`, mounted at the same path as in the assistant, and the shared token. No server data, sign-ins, TLS keys, or provider secrets. Each command gets a fixed environment (`PATH`, `HOME=/tmp`, `LANG`, `TERM`, and the proxy variables below), not the worker's.
- **Network.** The worker is only on an internal network shared with the assistant and the [egress gateway](#egress-gateway): commands have no route to the internet, the LAN, the Docker host, or Meridian. They reach allowlisted HTTPS hosts through the gateway. The network uses `gateway_mode_ipv4: isolated` (Docker Engine 28 or later), so the host has no address on it either; without that, commands could reach host services such as sshd through the bridge gateway. Changing network options needs `docker compose down` then `up -d`, because Compose does not recreate an existing network.

### Egress gateway

`agentlink-server egress-gateway` (the `egress-gateway` service, using the assistant image) is the only way out for commands, and for `web_fetch`. With `"egressProxy": "http://egress-gateway:3128"` under `commandWorker`, every command gets `HTTPS_PROXY`/`https_proxy`/`HTTP_PROXY`/`http_proxy`, which npm, git, pip, and curl use. (Node's own `fetch` ignores them.) The proxy URL carries the project's signed [network preset](#network-presets); the gateway verifies it with `--policy-key-file` (`AGENTLINK_EGRESS_POLICY_KEY_FILE`, the `egress_policy_key` secret in compose).

- **What it allows.** HTTPS tunnels (`CONNECT`) on port 443 to what the project's preset allows. The dependency allowlist (the Dependencies preset, or every request when the gateway has no policy key) is `registry.npmjs.org`, `registry.yarnpkg.com`, `github.com`, `codeload.github.com`, `objects.githubusercontent.com`, `release-assets.githubusercontent.com`, `raw.githubusercontent.com`, `pypi.org`, `files.pythonhosted.org`, and `nodejs.org`. Add hosts for every project with `AGENTLINK_EGRESS_ALLOW` in `.env` (comma-separated; `*.example.org` covers subdomains only), then `docker compose up -d`, or for one project with its extra sites.
- **What it refuses.** Unlisted names, plain HTTP, IP addresses, other ports, single-label names (sibling containers), and allowlisted names that resolve to any private, loopback, link-local, or other non-public address. Tunnels use IPv4 only, so a NAT64 address cannot smuggle a private destination. The tunnel connects to the address it checked, so DNS cannot switch it to the LAN afterwards, and a redirect to another host is a new tunnel that is checked again. Refusals are a `403` whose status line names the host (`403 Blocked example.com: network access is off for this project`); git shows only the code, so check `docker compose logs egress-gateway`, which logs every tunnel and refusal. With a policy key, a request without credentials gets a `407` challenge instead, whatever its host, so a client that only sends credentials when asked (the research browser) can retry with its project's signed policy; without credentials nothing gets through.
- **What it does not do.** It does not inspect TLS, so an allowed host is reachable in full (for example any GitHub repository). The preset limits where a command can send data, not what it does there; on Open web that is any public site.
- **Unrestricted escape hatch.** `COMPOSE_FILE=compose.yaml:compose.worker-egress.yaml` in `.env` gives the worker a normal network as well: any internet host, and the LAN and Docker host by address. Prefer adding hosts to the allowlist.
- **Limits.** 2 GB of memory, 2 CPUs, and 512 processes by default (`AGENTLINK_WORKER_MEMORY`, `AGENTLINK_WORKER_CPUS`, `AGENTLINK_WORKER_PIDS`), and at most 16 commands at once.
- **Token.** The protocol is plain TCP authenticated by the token. Commands can read the token, so the worker refuses connections from its own container: only the assistant can launch anything. Run `agentlink-server command-worker` outside a container only with `--allow-local-peers`, on a host where that trade-off is acceptable.
- **Process cleanup.** A command's background jobs are killed when it exits, and with `--reap-orphans` (set in the image) any process that escaped its group is killed whenever no command is running. A dropped server connection or a worker stop kills the command. `docker compose exec command-worker ...` sessions are killed by the same cleanup.
- **Checks.** `docker compose exec assistant agentlink-server --check` reports whether the worker is reachable with the token. A server whose worker is down still starts; commands fail until it is back.

### Session runners

With `runners` configured, each [coding task](#coding-tasks)'s session runs in its own container (a session runner) instead of in the assistant: its agent loop, file tools and commands, with only that task's folder and its own data folder mounted. Chats stay in the assistant. The chat, steering, approvals and **Stop** work the same either way: the assistant drives the runner over HTTP with the operations it uses on its own sessions, and streams the transcript back as it does for any chat.

- **Setup.** Add `compose.runners.yaml` to `COMPOSE_FILE`, then once: `openssl rand -hex 32 > secrets/runner-manager-token`, `chmod 600 secrets/runner-manager-token`, and `mkdir -p data/runners` (before the first `up`, so it belongs to you). In `server.json`: `"runners": { "manager": { "host": "runner-manager", "port": 7700, "token": { "file": "/run/secrets/runner-manager-token" } } }`. Optional: `port` (default 7500, where the assistant answers runners), `controlHost` (default `assistant`) and `idleMinutes` (default 10). It needs `projectsRoot`. `--check` reports whether the manager is reachable.
- **No secrets in a runner.** Model calls come back to the assistant, which makes them with its own sign-ins (Codex, Meridian, API keys) and enforces the runner's limits again; web tools run in the assistant too. Pushes and pull requests go through the publisher as before, and the task's checks and review run as before. A runner gets a fresh random token each time it starts, used both ways, so it can call the models and its own task's web tools and nothing else. Its commands get the task's fixed environment, never the runner's own (and so not its token).
- **What a runner sees.** The task folder (the clone and `refs/`) and `data/runners/<task>`, where its sessions are kept, so a runner can be stopped and started at any time. No other project or task, no server data, no secrets, no Docker socket. It runs as your user, with a read-only root filesystem, no capabilities, `no-new-privileges`, and 2 GB of memory, 2 CPUs and 512 processes (`AGENTLINK_RUNNER_MEMORY`, `AGENTLINK_RUNNER_CPUS`, `AGENTLINK_RUNNER_PIDS`).
- **Network.** Runners are on an internal network (`agentlink-runners`) with only the assistant and the egress gateway: the internet only through the gateway with the task's network preset, and no route to the command worker, the publisher, Meridian, the manager or the LAN.
- **The runner manager.** `agentlink-server runner-manager` (the `runner-manager` service, using the command worker image) is the only service with the Docker socket, which is root-equivalent; the assistant never has it. It accepts only "start a runner for this task folder and data folder" and "stop it" from the manager token, and decides the rest itself (image, user, limits, network, mounts). It refuses any folder outside `projects/.tasks/` or `data/runners/`, symlinks, and extra environment variables. It runs as root to open the socket, read-only, with only `DAC_READ_SEARCH` to check folders, on its own network shared with the assistant alone. It finds the folders' host paths from its own container's mounts. On the Mac mini (Docker Desktop) it works the same way.
- **Lifecycle.** A runner starts when its task first needs it (about a second) and stops after 10 minutes with nothing running: no turn, no background agent, no call. A finished task's chat is shown from the assistant's copy of its last transcript (`data/runner-sessions/`), so opening the app does not wake every task's runner; writing to it starts the runner again. A runner that crashes is restarted by Docker; a turn it was running fails (`runner_lost`) and the task can be resumed, with its transcript kept. When the assistant starts, it removes runners left from before.
- **Known limits.** A command in a runner runs as the same user as the runner process, so it could read the runner's token from `/proc` and make model calls as that task (the same calls the task can already make). Runners share one network, so they can reach each other's port, which needs the other runner's token. A session's approval mode reaches its runner with each turn.

### Claude models (Meridian)

[Meridian](https://github.com/rynfar/meridian) serves Claude models through your own Claude sign-in as an OpenAI-compatible endpoint. [`deploy/container/compose.meridian.yaml`](deploy/container/compose.meridian.yaml) runs it as a second service beside the assistant. Setting it up, all below: build the image, create the key, start it, sign in to Claude, install the AgentLink plugin, then declare the models in `server.json`.

- **Not published.** Meridian has no `ports:`; only containers in this compose project can connect, as `http://meridian:3456`. The host's LAN address does not answer on 3456.
- **Keyed.** Every request needs the shared key in `secrets/meridian-api-key`. Compose mounts it into both containers at `/run/secrets/meridian-api-key`; Meridian loads it into `MERIDIAN_API_KEY` inside its own process, so it is not in the container configuration.
- **Hardened like the assistant.** Runs as uid 1000 with a read-only root filesystem, no capabilities, and `no-new-privileges`. Its sign-in, settings, plugins, and session state live in `meridian/` (Meridian's home directory).
- **Plain HTTP on purpose.** Traffic stays on the private Docker network. The server accepts `http://` to a provider only for loopback, or for a single-label container name (like `meridian`) with `"allowInsecureHttp": true`. LAN addresses and dotted names must use HTTPS, so a key never crosses the network in the clear.

```sh
# In the deploy directory, once
docker build -t meridian:local https://github.com/rynfar/meridian.git#meridian-v1.80.0
mkdir -m 700 secrets meridian
(umask 077 && openssl rand -hex 32 > secrets/meridian-api-key)
echo "COMPOSE_FILE=compose.yaml:compose.meridian.yaml" >> .env
docker compose up -d

# Sign in to Claude: open the printed link, sign in, paste the code back.
# Saved in meridian/.config/meridian/profiles; no restart needed.
docker compose exec meridian node dist/cli.js profile add claude --headless
docker compose exec meridian node dist/cli.js profile list

# AgentLink's Meridian plugin (from an AgentLink checkout)
node integrations/meridian-plugin-agentlink/install.mjs meridian/.config/meridian/plugins
docker compose restart meridian
```

Install the [AgentLink plugin](../../integrations/meridian-plugin-agentlink/README.md). Without it, Meridian treats the assistant as a generic OpenAI client: it defers AgentLink's tools and can run extra hidden model turns before handing a tool call back. With it, tool calls return to the assistant in one turn and the assistant runs them under its own approvals. It applies only to requests that carry the session-affinity header (`meridianSessionAffinity: true`) and AgentLink's prompt. To check, `GET /plugins/list` on Meridian should show `agentlink-client-tools` as `active`, and `GET /telemetry/requests` should show `isPassthrough: true` and `hasDeferredTools: false` for assistant requests. Sessions created before the plugin was loaded keep their old behaviour; start a new session.

Then add the provider to `server.json` (full example: [`deploy/container/server.with-meridian.example.json`](deploy/container/server.with-meridian.example.json)) and `docker compose restart assistant`:

```json
{
  "type": "openai-compatible",
  "id": "claude",
  "baseURL": "http://meridian:3456/v1",
  "allowInsecureHttp": true,
  "apiKey": { "file": "/run/secrets/meridian-api-key" },
  "meridianSessionAffinity": true,
  "reasoningEffortMode": "reasoning_effort",
  "timeoutMs": 600000,
  "models": [
    {
      "id": "claude-opus-5-5",
      "contextWindow": 200000,
      "maxOutputTokens": 32000,
      "supportsToolUse": true,
      "supportsThinking": true,
      "supportsImages": true,
      "reasoningEfforts": ["low", "medium", "high", "xhigh", "max"],
      "defaultReasoningEffort": "high",
      "promptProfile": "reasoning"
    }
  ]
}
```

Add one entry per Claude model you want in the picker; Meridian's `GET /v1/models` lists the IDs your plan offers.

To run reviews on Claude while everything else uses the default model, add `"modelRoles": { "review": { "providerId": "claude", "modelId": "claude-opus-5-5" } }` and create review sessions with `{ "role": "review" }` (see [Model selection](#model-selection)).

`meridianSessionAffinity` lets Meridian resume each conversation's Claude session. Use the context window Meridian's `/v1/models` reports for your plan; 200k is safe for every plan. Requests use your Claude subscription's limits. To rotate the key, replace the file and `docker compose up -d --force-recreate`.

### SearXNG

Codex models search with Codex's own hosted search. For every other model (Claude through Meridian, OpenRouter, …), `web_search` needs a [SearXNG](https://docs.searxng.org/) instance. [`deploy/container/compose.searxng.yaml`](deploy/container/compose.searxng.yaml) runs one beside the assistant, unpublished and reachable only by the assistant:

```sh
# In the deploy directory, once
mkdir -p searxng
cp searxng.settings.example.yml searxng/settings.yml   # from deploy/container/
echo "SEARXNG_SECRET=$(openssl rand -hex 32)" >> .env
# .env: COMPOSE_FILE=compose.yaml:compose.searxng.yaml (append :compose.meridian.yaml if used)
# server.json: "web": { "searxngUrl": "http://searxng:8080" }
docker compose up -d
```

The example settings turn on the JSON format the assistant reads (without it SearXNG answers `403`, which the tool reports) and turn off the public-instance bot limiter. Searches go from the server to SearXNG, and from SearXNG to the search engines it is configured for; result pages are read with `web_fetch` under the project's preset. Any other SearXNG works too, as long as JSON output is enabled.

### Finding the server on the LAN (mDNS)

Ubuntu answers to `<hostname>.local` through Avahi. [`deploy/systemd/agentlink-mdns-alias.service`](deploy/systemd/agentlink-mdns-alias.service) adds `agentlink-assistant.local` for the machine's LAN address, so devices can use `https://agentlink-assistant.local:8443` whatever the machine is called (the file header lists the install commands, including creating the `agentlink-mdns` system user it runs as; Ubuntu's D-Bus rejects the alias publisher under systemd's `DynamicUser`). It works with the container and the systemd install alike. Keep the name in `publicOrigins`, and give the machine a DHCP reservation: the alias is published for the address found when the service starts. On macOS, set the machine's name in Sharing (for example `agentlink-assistant`) to get the same `.local` name.

### Ubuntu (systemd)

[`deploy/systemd/agentlink-server.service`](deploy/systemd/agentlink-server.service) runs the bundle as a dedicated `agentlink` system user with state in `/var/lib/agentlink` (`StateDirectory`, `0700`), read-only config in `/etc/agentlink`, and projects in `/srv/agentlink/projects`. The file header lists the install commands. It is hardened (`ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, no capabilities, restricted namespaces and address families) and scores 3.0 ("OK") in `systemd-analyze security`. `MemoryDenyWriteExecute` is deliberately off because V8's JIT needs it. Adjust `ExecStart` if Node is not `/usr/bin/node`.

### macOS (launchd)

[`deploy/launchd/local.agentlink.server.plist`](deploy/launchd/local.agentlink.server.plist) is a LaunchDaemon that runs as a hidden `_agentlink` user with a `0077` umask and restarts on failure. Logs go to `/usr/local/var/log/agentlink/server.log`; keep that directory private to the service user. The plist header lists the install commands. API keys use `{ "file": ... }` with a `0600` file.

### Device trust

With `"tls": { "localCa": true }` the server creates its own certificate authority (CA) on first start, in `<dataRoot>/tls`, and issues its HTTPS certificate from it. Install the CA once on each phone, tablet, and computer, and browsers trust the server with no warnings.

The CA is **name-constrained** to the hosts in `publicOrigins`: devices that trust it accept it only for those hostnames (and names under them, such as `x.framework16.local`, which is how DNS name constraints work) and those exact IP addresses, never for any other website, even if its key leaked. The trade-off is that changing `publicOrigins` needs a new CA. The server refuses to start rather than replace a CA silently; move `<dataRoot>/tls` aside, restart, and install the new CA on every device. The CA is valid for 10 years. The server certificate is valid for a year and is renewed automatically within 30 days of expiry (checked every 12 hours, no restart).

Prefer a hostname origin, such as the machine's mDNS name (`https://framework16.local:8443`), alongside or instead of an IP address: it survives DHCP address changes, which would otherwise need a new CA.

`<dataRoot>/tls/ca-key.pem` holds the CA key and certificate together and is the only authoritative copy; back it up privately. `ca.pem` is a public copy that is rebuilt from it if missing.

Export the CA (it is public; only `ca-key.pem` is secret and it never leaves the server):

```sh
# Ubuntu
sudo -u agentlink /usr/bin/node /opt/agentlink/server/agentlink-server.js export-ca --config /etc/agentlink/server.json > agentlink-ca.pem
# macOS
sudo -u _agentlink /opt/homebrew/bin/node /usr/local/lib/agentlink/server/agentlink-server.js export-ca --config /usr/local/etc/agentlink/server.json > agentlink-ca.pem
```

It prints the CA's SHA-256 fingerprint on the terminal, as does the service log at startup. Move the file to each device over a channel you trust (AirDrop, USB, your own email), and compare the fingerprint the device shows before trusting it.

- **iPhone and iPad:** open the file (AirDrop or Files), then Settings → General → VPN & Device Management → install the profile. Then turn on full trust in Settings → General → About → Certificate Trust Settings.
- **Android:** Settings → Security → Encryption & credentials → Install a certificate → CA certificate (the menu path varies by manufacturer). Chrome uses it. Firefox needs its "use third-party CA certificates" setting.
- **macOS:** `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain agentlink-ca.pem`, or import it into the System keychain in Keychain Access and set it to Always Trust.
- **Windows:** `certutil -user -addstore Root agentlink-ca.pem`.
- **Ubuntu desktop:** `sudo cp agentlink-ca.pem /usr/local/share/ca-certificates/agentlink-ca.crt && sudo update-ca-certificates` for system tools. Chrome and Firefox on Linux keep their own lists: import it as an authority in their certificate settings.

To stop trusting the server, remove the profile or certificate from the device.

### Restarts and crashes

Sessions, the owner, devices, and pairings survive restarts. A turn that was running when the process died is marked interrupted at startup. After a hard crash the dead process's turn lease stays valid for up to 30 seconds and is never broken early: the server starts immediately, that session reports `409 session_busy`, and recovery completes in the background once the lease expires.

### Backups

[`deploy/container/compose.backup.yaml`](deploy/container/compose.backup.yaml) adds a backup sidecar that backs up the whole deploy directory with [restic](https://restic.net) to an append-only store, the witness ([`deploy/container/witness/compose.yaml`](deploy/container/witness/compose.yaml), a [rest-server](https://github.com/restic/rest-server) run as its own compose project). Each backup is one snapshot of:

- the deploy directory (`server.json`, `.env`, compose files, `secrets/`, `publisher/`, `meridian/`, `projects/` without `node_modules`, `.venv`, `dist`, `build`, `target`, `.next` and `.pnpm-store`), read live;
- a copy of `data/` taken first, in a moment, so chats, tasks, devices and the task audit log are consistent with each other (the audit log's head is copied before the log). `data/repository-snapshots` is left out; it is rebuilt on demand.

The sidecar sees the deploy directory read-only and holds the store's address and the backup password. The assistant reaches it on a private network with a shared token and can only ask for its status, its backups, or a backup now. The witness refuses deletes and overwrites, so neither the assistant nor the sidecar can destroy existing backups.

It backs up hourly when `data/` changed and at least daily (checked every 10 minutes; a failure is retried after 30). The Inbox reports a failed backup, or no good backup for 26 hours, and the Inbox panel shows when the last backup finished with a **Back up now** button. `agentlink-server --check` shows a `backup` line.

**What it protects against.** With the witness on the same machine (the default), backups cover mistakes, corruption, a bad upgrade and a compromised assistant, but not losing the machine or its disk. Point `secrets/backup-repository` at a rest-server on another machine for that; nothing else changes.

Setup:

```sh
# Build (from the repository root)
docker build --target backup -t agentlink-backup:local -f apps/server/deploy/container/Dockerfile apps/server
# The witness: its own directory, outside the deploy directory
mkdir -p ~/agentlink-witness && cp apps/server/deploy/container/witness/compose.yaml ~/agentlink-witness/
(cd ~/agentlink-witness && docker compose up -d)
# In the deploy directory, once
openssl rand -hex 32 > secrets/backup-token
echo rest:http://witness:8000/agentlink/ > secrets/backup-repository
openssl rand -base64 33 > secrets/backup-password
chmod 600 secrets/backup-token secrets/backup-repository secrets/backup-password
# .env: COMPOSE_FILE=compose.yaml:compose.backup.yaml (append others you use)
# server.json: "backup": { "host": "backup", "port": 7800,
#                          "token": { "file": "/run/secrets/backup-token" } }
docker compose up -d
docker compose exec assistant agentlink-server backup    # first backup, waits for it
docker compose exec assistant agentlink-server backups   # list them
```

**Write down the backup password** (`secrets/backup-password`) somewhere off the machine, such as a password manager. The backups are encrypted with it, and the copy in `secrets/` is inside what is backed up: without another copy, a lost deploy directory means unreadable backups.

**Restoring.** Stop the assistant, move the deploy directory aside (never restore over it), and restore into a new, empty directory with the backup image. Run it as root so every file gets its owner back:

```sh
cd ~ && (cd agentlink-assistant && docker compose down)
mv agentlink-assistant agentlink-assistant.before-restore
mkdir agentlink-assistant
# The repository file and password from your records (or the old secrets/)
docker run --rm --network agentlink-witness \
  -v ~/agentlink-assistant:/restore \
  -v ~/agentlink-assistant.before-restore/secrets/backup-repository:/run/secrets/backup-repository:ro \
  -v ~/agentlink-assistant.before-restore/secrets/backup-password:/run/secrets/backup-password:ro \
  agentlink-backup:local restore --target /restore \
  --repository-file /run/secrets/backup-repository --password-file /run/secrets/backup-password
  # add --snapshot <id> (from `backups`) for an older one
cd agentlink-assistant && docker compose up -d
```

**Restoring a release installation.** The steps above are for a source-built deployment. An installation made by `install.sh` keeps its backup store in `~/agentlink-assistant-witness` (the deploy folder's name plus `-witness`, on the `agentlink-witness` network) and has an update supervisor in `~/agentlink-assistant-updater` that is tied to the deploy folder's path. So restore it back to the **same path**, use the backup image pinned in its `release.env` (not a local tag), and keep the backup store running:

```sh
cd ~
# 1. Nothing else may be changing the deployment.
test ! -e agentlink-assistant-updater/.deployment-mutation-lock || echo 'STOP: an update or install.sh command holds the guard'
test -z "$(docker ps -q --filter label=io.agentlink.updater.operation)" || echo 'STOP: an update job is running'
# 2. Stop the Assistant and the update supervisor; leave the backup store running.
(cd agentlink-assistant && docker compose down)
(cd agentlink-assistant-updater && docker compose down)
docker ps --filter name=witness --format '{{.Names}}'   # the witness must still be listed
# 3. Move the deployment aside (never restore over it) and restore into a new, empty folder.
mv agentlink-assistant agentlink-assistant.before-restore
mkdir agentlink-assistant
backup_image=$(sed -n 's/^BACKUP_IMAGE=//p' agentlink-assistant.before-restore/release.env)
echo "$backup_image"   # must be ghcr.io/reefbarman/agentlink-backup@sha256:<64 hex>
docker run --rm --network agentlink-witness \
  -v ~/agentlink-assistant:/restore \
  -v ~/agentlink-assistant.before-restore/secrets/backup-repository:/run/secrets/backup-repository:ro \
  -v ~/agentlink-assistant.before-restore/secrets/backup-password:/run/secrets/backup-password:ro \
  "$backup_image" restore --target /restore \
  --repository-file /run/secrets/backup-repository --password-file /run/secrets/backup-password
  # add --snapshot <id> for an older one (list them first with
  # `docker compose exec assistant agentlink-server backups` while it runs)
# 4. Start the supervisor, then the Assistant, and check it.
(cd agentlink-assistant-updater && docker compose up -d)
cd agentlink-assistant && docker compose up -d
docker compose exec -T assistant agentlink-server smoke-check
docker compose exec assistant agentlink-server audit-check
```

- If you lost the deploy folder, use the repository file and the password from your off-machine records instead of `.before-restore/secrets/`, and the `BACKUP_IMAGE` line from the release's `assistant-release.env` asset.
- A wrong password makes `restore` fail; the original stays in `.before-restore`. Remove the new folder's contents and try again, or move the original back (`rm -r agentlink-assistant && mv agentlink-assistant.before-restore agentlink-assistant`) and start it as in step 4.
- Restore a backup taken by the installed release. To go back to an earlier release, use **Settings → Updates → Roll back**, which restores images, management files and data together.
- To only inspect a backup, restore it into some other empty folder and read the files there. Do not `docker compose up` that copy: it uses the same project name, ports and supervisor as the real one.
- Keep `.before-restore` until the restored Assistant checks out.

The restored assistant starts with its scheduled jobs paused and an Inbox entry naming the backup. Anything after the backup is gone; work that was running then is interrupted and can be resumed. Chats, signed-in devices, GitHub connections and the Meridian sign-in come back with it (chats are kept by project ID, not by the project folder, so a restored or moved folder keeps them). Check the audit log with `docker compose exec assistant agentlink-server audit-check`.

**Pruning.** Clients cannot delete, so old backups are pruned on the witness's side, with direct access to its folder (not through rest-server). For example, weekly from the host's crontab (for a release installation, use `~/agentlink-assistant-witness` and the pinned `BACKUP_IMAGE` from `release.env`):

```sh
docker run --rm --entrypoint restic -v ~/agentlink-witness/data/agentlink:/repo \
  -v ~/agentlink-assistant/secrets/backup-password:/password:ro agentlink-backup:local \
  -r /repo --password-file /password forget --host agentlink-assistant \
  --keep-hourly 48 --keep-daily 14 --keep-weekly 8 --prune
```

### Upgrades

[`deploy/upgrade.sh`](deploy/upgrade.sh) upgrades a container deployment in one command, on Docker (Ubuntu) and Docker Desktop (macOS), with backups set up first:

```sh
apps/server/deploy/upgrade.sh [--deploy ~/agentlink-assistant] [--wait 15] [<git ref>]
apps/server/deploy/upgrade.sh rollback
```

It builds the bundle and new images (tagged `:candidate`) from the checkout, or from `<git ref>` after checking it out, while the Assistant keeps working. Then it drains the Assistant, takes a backup, tags the running images `:previous` and the new ones `:local`, restarts with `docker compose up -d`, and runs `agentlink-server smoke-check` until it passes (up to 3 minutes) before resuming. If the check fails it rolls back by itself: the `:previous` images and `data/` from the backup it just took, with the failed `data/` kept beside the deploy directory. The rolled-back Assistant starts with scheduled jobs paused and an Inbox entry saying the upgrade was rolled back. `upgrade.sh rollback` does the same by hand after an upgrade that passed its checks but misbehaves later. `--simulate-failure` rehearses a rollback.

**Draining.** `agentlink-server drain [--wait <minutes>]` (run by the script, or by hand as the service account, like `pair`) stops the Assistant admitting new work: chat messages outside task chats are refused with a plain "being upgraded" message, new, resumed and continued tasks are refused, and scheduled runs wait (a run missed by more than its catch-up window is recorded missed, as after a restart). Running chat turns, tasks and scheduled runs carry on, and approvals can still be answered. A scheduled run waiting for an approval is not running: the drain does not wait for it, and it is still waiting after the upgrade. After `--wait` minutes (15 by default) whatever is still running is stopped and recorded `interrupted`, so it can be resumed; a stopped chat turn adds an Inbox entry pointing at the chat, where asking again carries on. The drain survives restarts: the new version starts drained until `agentlink-server resume`. The app shows "Upgrading: new chats, tasks and scheduled runs wait" meanwhile.

**Versions.** Every service reports its build (package version, commit, and a build ID shared by all images built from one bundle) and protocol: the command worker, publisher, runner manager, session runners and backup sidecar. `--check` prints a `Versions:` line naming any service on another build or protocol ("publisher is version X, the assistant is Y: rebuild both"), the server logs the same at start, and `smoke-check` fails on it. The Inbox panel shows the running version.

**Data format.** `data/VERSION` records the format of the data root. A newer server migrates older data in order at start; a server refuses to start on data newer than it understands, so running older code needs the backup taken before the upgrade (`upgrade.sh rollback` restores it).

### Lost access

If every signed-in browser is gone (cookies cleared, devices revoked or lost), run `pair` on the server machine as the service account, exactly as for the first device:

```sh
# Container
docker compose exec assistant agentlink-server pair
# Ubuntu
sudo -u agentlink /usr/bin/node /opt/agentlink/server/agentlink-server.js pair --config /etc/agentlink/server.json
# macOS
sudo -u _agentlink /opt/homebrew/bin/node /usr/local/lib/agentlink/server/agentlink-server.js pair --config /usr/local/etc/agentlink/server.json
```

It refuses to run as any account other than the owner of the data root. Anyone who can run it already controls the server's data, so it needs nothing else.

## Access layer

`createAssistantServer(options)` starts an HTTPS-only listener (TLS 1.2+, certificate and key required, no plain-HTTP mode) that owns authentication:

- **Owner.** One owner is created with the access state; every paired device signs in as that owner.
- **Pairing.** Codes are 6 digits and single use. A signed-in device creates one (`POST /api/auth/pairings` or `POST /devices/pair`, 5 minutes, at most 5 outstanding). `agentlink-server pair` writes only a hash of a 10-minute code to `local-pairing.json` beside the access state (`0600`) without taking the store lock; the server ignores the file unless it is a small regular file owned by its own account and private to it. A browser redeems a code with the `/pair` form or `POST /api/auth/pairings/redeem` and becomes a new device. Ten wrong codes in a row withdraw every outstanding code, including the local one.
- **Sessions.** `__Host-agentlink_session` cookie (`Secure; HttpOnly; SameSite=Strict; Path=/`), 30-day absolute and 7-day idle expiry. `GET /api/auth/session` returns the session. `POST /api/auth/logout` ends it, and `DELETE /api/auth/devices/:id` (or `POST /devices/:id/revoke`) revokes a device and all its sessions, including the last one; sign in again with [`pair`](#lost-access).
- **Request guard.** Every request and upgrade is rejected when it carries `Forwarded`, `X-Forwarded-*`, `X-Real-IP`, `X-Remote-User`, `X-Auth-Request-*` or similar identity/proxy headers, when `Host` is not a configured public origin, when `Origin` is foreign, or when `Sec-Fetch-Site` is `cross-site`. Unsafe methods and upgrades require a same-origin `Origin`; with the `SameSite=Strict` cookie this is the cross-site request defence, so there is no separate CSRF token. Pages send `Referrer-Policy: same-origin` so browsers keep sending a real `Origin`.
- **Rate limiting.** Pairing guesses are limited per socket address and globally, and attempts still in flight count against the limit. Client headers never select the key.

`handleRequest` and `handleUpgrade` only ever see authenticated requests. Their `auth` context carries:

- an explicit `{ tenantId: "agentlink-server", subjectId: ownerId }` principal, never derived from a project identity;
- `signal`, which aborts when the request closes or as soon as its session or device is revoked;
- `revalidate()`, a check-only recheck of revocation and expiry. It does not count as client activity, so it never extends the idle window.

`onClose` runs during `close()`, after the listener stops accepting connections and before open connections and the access store close. Use it to stop application work.

State lives in `<dataRoot>/access-state.json` (directory `0700`, file `0600`). Only hashes of session tokens and pairing codes are stored (outstanding codes from signed-in devices are kept in memory only). A corrupt file stops startup rather than being replaced. A file from an older version with a passphrase owner is migrated: the owner and devices are kept and the passphrase hash dropped. Each write is fsynced, including the directory, before a response reports success. An exclusive `access-state.lock` lets only one live process own a data root; `close()` releases it, and a lock left by a dead process is replaced (under a `.reclaim` marker, so two starting processes cannot both take it).

## Workspace sessions

`createAssistantWorkspaceRoutes({ projects, authorizeProject, models })` mounts one or more workspace hosts. Pass its `handleRequest` to the server and its `close` as `onClose`.

- **Explicit project access.** `authorizeProject({ principal, projectId, access })` maps the server principal to `read`, `write`, or `approve` on each mounted project. It is required; `ownerProjectAccess(store)` grants everything to the owner and nothing to anyone else. The host still runs as its own project principal.
- **Routes.** `GET /api/projects`, `GET /api/projects/:id/models`, `GET|POST /api/projects/:id/sessions`, `GET .../sessions/:sid` (snapshot, display transcript, model, running task with its start sequence and prompt, and event cursor), `POST .../turns`, `POST .../model`, `POST .../interaction`, `POST .../cancel`, `GET .../events`, and the [background agent](#background-agents) routes under `.../agents`.
- **Server-owned turns.** A turn or resume runs on the server, not the request: closing the browser does not cancel it. One task runs per session at a time (`409 session_busy`). A cancelled or failed turn leaves the session `interrupted`, which accepts the next turn. Server shutdown aborts running tasks and waits for them.
- **Approvals.** `POST .../interaction` needs `approve` access. The decision names the exact `interactionId` and `interactionRevision` the owner saw. A mismatch returns `409 stale_interaction`, and the host binds the same pair into the engine's atomic resume, so a decision cannot reach a replacement request. Revocation is rechecked immediately before the resume starts, and a revoked session stops reading a stalled request body.
- **Event stream.** `GET .../events` is Server-Sent Events. Events carry `id: <epoch>:<sequence>`. Reconnect with `?epoch=&after=` (or `Last-Event-ID`) to replay retained events. A `reset` control event means the cursor cannot be served (the event aged out, or the server crashed since the cursor was issued) and the client should re-read the snapshot. The stream closes on revocation and rechecks the session every heartbeat. A backpressured reader is caught up from the retained log once it drains; one that stays stalled for 30 seconds is dropped and can reconnect.

### Model selection

Each session has its own model, chosen from the models `server.json` declares. Nothing outside that list is accepted, so a client cannot point a session at another endpoint.

- `GET /api/projects/:id/models` (read access) returns `{ models, defaultModel, roles }`. Each model is `{ providerId, modelId, displayName?, providerDisplayName?, contextWindow?, maxInputTokens?, supportsImages?, reasoningEfforts?, defaultReasoningEffort? }`.
- Each session also keeps its own thinking level. It must be one of the model's `reasoningEfforts` (`400 reasoning_effort_not_available` otherwise); a model without levels has no thinking control.
- `POST /api/projects/:id/sessions` takes an optional body: `{ "model": { providerId, modelId } }` or `{ "role": "review" }`, not both. No body uses `defaultModel`. Errors: `400 model_not_available`, `model_role_not_configured`, `model_selection_invalid`, or `model_invalid`.
- `POST .../sessions/:sid/model` (write access) changes the model between turns with the same body. It returns `409 session_busy` while a turn runs and `409 interaction_pending` while an approval waits.
- Session reads and lists include `model`: the session's own choice, or `defaultModel` if it has none.

### Approval mode

- Session reads, lists, and the create response include `approvalMode`: `"autonomous"` (the default) or `"ask"`.
- `autonomous` lets the session's own file writes and foreground commands run without a card, and its background agents' too (each inside its own file scopes). Protected paths, background commands and an agent's MCP calls still ask, and forbidden command rules are still refused. In an `ask` session its agents ask too.
- `POST .../sessions/:sid/approval-mode` (approve access) takes `{ "mode": "ask" | "autonomous" }`. Switching to `ask` takes effect for the next tool call. Errors: `400 approval_mode_invalid`, `409 approval_mode_unavailable`.
- Only `ask` sessions are stored, in `<dataRoot>/settings/approval-modes.json`. A missing file means every session is autonomous; an unreadable one stops the server from starting.

A review can also be an ordinary session on the review model.

### Background agents

A session's agent can start up to two one-level child agents with `spawn_background_agent`, for example to review its work on Claude while it continues. Children are background sessions of the same project:

- **Scoped.** Each child gets explicit project-relative read paths and, optionally, write paths. A child with no write paths is read-only and cannot write at all, which is what a reviewer gets. Sibling write paths must not overlap.
- **Model.** A child uses its parent session's model unless the agent passes `model_role` (one of `modelRoles`, so `"review"` when configured) or a provider and model that the server has configured. The prompt tells the agent to spawn reviews read-only with `model_role: "review"`.
- **Owner approval.** A child asks when its parent would: in an autonomous chat its file writes and foreground commands (inside its scopes) run without asking, in an `ask` chat they pause for the owner. Its MCP calls and protected files always ask. Children cannot delegate, and they are reachable only through their parent: `GET` or `POST` on a child's own session path returns `404 session_not_found`.

Routes, under `/api/projects/:id/sessions/:sid/agents`:

| Route                           | Access    | Body                          | Result                                                                                                                                     |
| ------------------------------- | --------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET .../agents`                | `read`    |                               | `{ agents }`: each child's lifecycle, phase, scopes, model, current tool, bounded partial output, result text, and any pending `approval`. |
| `POST .../agents/:cid/steer`    | `write`   | `{ message }` (up to 64 KiB)  | `202 { status: "queued" }`. Applied at the child's next completed turn; it does not interrupt a request or tool.                           |
| `POST .../agents/:cid/stop`     | `write`   | optional `{ reason }`         | `200 { agent }`, cancelled, with partial output kept.                                                                                      |
| `POST .../agents/:cid/approval` | `approve` | `{ interactionId, decision }` | `200 { agent }`. The decision applies only to that exact pending request; anything else is `409 stale_interaction`.                        |

Errors: `404 agent_not_found` (unknown, or owned by another session), `409 agent_not_running`, `409 steering_queue_full`. The parent's event stream carries `{ kind: "agent", state, childSessionId }` events for `approval_required`, `approval_answered`, `steered`, and `stopped`, plus `{ kind: "agent", state: "updated", childSessionId, lifecycle, phase, currentTool? }` whenever a child's lifecycle, phase, or current tool changes, including `completed`, `failed`, `cancelled`, and `awaiting_approval`. Updates carry state only, never output text, and do not fire for every streamed token. Re-read `GET .../agents` for the result or partial output; there is no need to poll while a child runs. Server shutdown stops running children, and children that were running when the server stopped are reported `interrupted` after restart; nothing is replayed.

The event log survives restarts. Each session's events are appended to a file under `<dataRoot>/events` before any client sees them, keeping the newest 1,000 (files are compacted at twice that, between turns). Files and the state marker are synced to disk, so a power loss is detected like a crash. After a clean stop (SIGTERM, `docker compose restart`) the epoch is kept, so a client reconnecting with its cursor replays what it missed, including the final events of turns the shutdown stopped. After a crash, power loss, or a failed write, the next start uses a new epoch: the log may have lost events a client already saw, so old cursors get `reset` (`epoch_changed`) rather than a replay with a gap. A session whose file is missing or damaged keeps its numbering and resets its clients the same way. Either way, a turn that was running when the server stopped is closed in the log with `{ kind: "task", state: "failed", error: "server_restarted" }`, so a replaying client does not wait for it. The durable session repository remains the source of truth.

### Long-running work

Chats and coding tasks work the way a foreground VS Code chat does with **Auto Continue** and **Approve for Me** on:

- **No limits.** A turn has no cap on model calls, tool calls or time. It runs until it is done, or until you press **Stop** (in its chat, on the task, or on an Inbox notice).
- **Auto Continue.** Chats have the `todo_write` tool, shown as the todo list above the composer. When a turn ends with unfinished items and nothing waits on you, the chat carries on by itself with VS Code's continuation prompt, hidden from the transcript. It stops when every item is done, after a turn that changed nothing (no writes, commands, agents or todo updates), when you press **Stop**, or when you send a message (yours runs next; a message the running turn takes in does not stop it). A task's implementation chat continues the same way before its checks run.
- **Runaway notices.** Nothing is stopped for you. The server watches every chat and task and adds an [Inbox](#scheduled-jobs) entry (and a [notification](#notifications)) when one has been working for 2 hours (then every 2 hours), has run the same tool with the same input 8 times in a row, or has shown no output or results for 30 minutes. Waiting for your approval does not count, nor does checking on a background agent. The entry has **Stop** and **Keep going**: Keep going resets the stuck checks and waits another 2 hours before the next "still working". `POST /api/inbox/act` takes `{ id, action: "stop" | "keep_going" }` for these entries (`409 inbox_action_unavailable` for others). Turns that follow each other within 2 minutes count as one piece of work.
- **Leeway.** An autonomous chat's file writes and foreground commands, and its background agents', run without asking, inside the project or task folder, the command worker and its network preset. Protected files, background commands, MCP calls from agents, jobs, tasks, publishing without standing permission, and sign-ins still ask.

### Scheduled jobs

A job sends a prompt to a new chat on a schedule, with no browser open. In the web app, the **Jobs** button at the top of the sidebar lists jobs with their schedule, next run and last outcome, and lets you create, edit, pause, delete and **Run now** a job and open any run's chat from its history. Run chats appear in the project's chat list with a clock badge, titled `<job name> · <date>`, and are marked unread when they finish.

- **From a chat.** Ask in any chat ("brief me every weekday at 7:30") and the Assistant proposes the job with `schedule_job`. An approval card shows exactly what will be saved: name, project, schedule in words, first run, approval mode, model and the full prompt. Nothing is saved until you allow it, and this card appears even in an autonomous chat. `schedule_job` with a `jobId` changes a job (the card shows each change as `before → after`), and `delete_job` deletes one; both ask the same way. `list_jobs` reads the jobs without asking. A job changed in the Jobs view while its card is waiting is not touched, and allowing the card then reports that the job changed. Prompts proposed from a chat are limited to 3,000 characters so the card can show all of it. Without a `timeZone` the server's is used, so tell the Assistant yours.
- **Following a run.** Opening a run's chat while it is going shows its progress live. You cannot send to it until the run finishes (`409`); **Stop** there stops the run (`cancelled`). If the run is waiting for an approval, its approval card appears in that chat; answering it there resumes the run.
- **Inbox.** The **Inbox** button shows a badge with the number of unread entries. Each finished, failed, blocked or interrupted run, and each run waiting for an approval, adds an entry; clicking one opens the run's chat in its project and marks the entry read, and **Mark all read** clears the badge. Entries are kept in `<dataRoot>/inbox/inbox.json` (the newest 500, read ones dropped first). Owner-only routes: `GET /api/inbox` returns `{ entries, unread }`; `POST /api/inbox/read` takes `{ ids }` or `{ all: true }`.
- **Notifications.** See [Notifications](#notifications).

- **Schedules.** `{ "kind": "interval", "everyMinutes": 15 }` (15 minutes to 7 days, counted from when the schedule was set), `{ "kind": "daily", "time": "07:30", "timeZone": "Australia/Sydney" }`, or `{ "kind": "weekly", "days": ["mon", "fri"], "time": "07:30", "timeZone": "…" }`. `timeZone` is an IANA name and defaults to the server's (the container's is UTC unless `TZ` is set). A local time the clocks jump over runs at the next valid minute; one that happens twice runs once.
- **Runs.** Each run is a new chat in the job's project, on the job's `model` (`"providerId/modelId"`) and `reasoningEffort`, or the project's defaults. It acts for the owner, shown as the device `Job: <name>`. One run per job at a time (an occurrence that comes while a run is still going is recorded as `skipped`, `overlap`) and at most two jobs at once; the rest wait their turn.
- **Approvals.** `approvalMode` is `autonomous` (default) or `ask`, with the same rules as a chat. Nothing is approved for the owner: a run that needs an approval is `awaiting_approval` and waits up to 12 hours, then is cancelled (`approval_expired`). Answer it from the run's chat in the web app, or through `POST /api/projects/:id/sessions/:sid/interaction`. Its turn is suspended durably, so a restart or an upgrade leaves it waiting: the next start shows its chat and approval card again (from the event log, so not after a crash that lost the log), for what is left of its 12 hours, and the upgrade drain does not wait for it.
- **Outcomes.** `completed` (with a `summary`: the final reply, up to 2,000 characters), `failed`, `cancelled`, `blocked_auth` (the provider's sign-in has expired), `blocked_quota` (rate or subscription limits; there is no fallback model), and `interrupted` (the server stopped while the run was working; it is never re-run, and its chat is kept). A failed or blocked run also keeps `errorDetail`, what the provider or server actually said (up to 500 characters, with keys, tokens and query strings redacted), which the Jobs history and the Inbox entry show and the server log records. It is not sent in push notifications unless `notifications.includeSummary` is set.
- **Downtime.** Occurrences missed while the server was down become one `catch_up` run on startup if the latest was within the last 6 hours, and are otherwise recorded as `skipped` (`missed`).
- **Pausing and deleting.** `PATCH` with `{ "enabled": false }` stops a live run (`cancelled`, `job_paused`). Deleting stops it too and removes the job's run history; the run chats stay. Revoking a device does not stop jobs.

| Route                    | Body                                                                                                          | Result                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `GET /api/jobs`          |                                                                                                               | `{ jobs }`, each with `nextRunAt`, `lastRun`, `activeRun` |
| `POST /api/jobs`         | `{ name, projectId, prompt, schedule, enabled?, model?, reasoningEffort?, approvalMode? }`                    | `201 { job }`                                             |
| `GET /api/jobs/:id`      |                                                                                                               | `{ job }`                                                 |
| `PATCH /api/jobs/:id`    | Any of the fields above; `null` clears `model` or `reasoningEffort`. A new schedule starts counting from now. | `{ job }`                                                 |
| `DELETE /api/jobs/:id`   |                                                                                                               | `{ ok: true }`                                            |
| `POST /api/jobs/:id/run` |                                                                                                               | `202 { run }`; `409 job_busy` while a run is going        |
| `GET /api/jobs/:id/runs` |                                                                                                               | `{ runs }`, newest first, the last 50                     |

Only the owner can use these routes (`403 jobs_forbidden`). Errors: `400 project_not_found`, `model_not_available`, `reasoning_effort_not_available`, `schedule_*`, `watch_*`, `job_field_unknown`; `404 job_not_found`; `409 job_limit_reached` (100 jobs). Definitions are stored in `<dataRoot>/jobs/jobs.json` (an unreadable file stops the server from starting) and runs in `<dataRoot>/jobs/runs.jsonl`.

- **Usage.** Each run that called a model records `usage`: `{ requests, inputTokens, outputTokens }` (input includes cached tokens), shown in the Jobs history. Nothing is stopped for using a lot: a run that used more than three times its job's usual tokens (the median of its last 10 runs that used a model, once there are 3) adds a **used more than usual** Inbox entry.

### Watches

A watch is a job that checks a web page or RSS/Atom feed and only asks a model when the watched text changed. Ask in a chat ("watch the AgentLink releases page and tell me when a stable release comes out") and the Assistant proposes it with `watch_page`. The approval card shows the page, the part of it watched, how often it checks, how often it may tell you and what matters; nothing is saved until you allow it. `watch_page` with a `jobId` changes a watch, and `delete_job` deletes it.

- **Checks.** Every `everyMinutes` (default 60, at least 15) the server fetches the page through the same connector and network rules as `web_fetch` (public HTTPS only, the project's preset, every redirect checked), sending `If-None-Match` / `If-Modified-Since` from last time. A `304` ends the check. Otherwise it takes the text (a feed's items, the elements matching the watch's `selector` such as `div.release` or `#price`, or the page's main text), collapses whitespace and compares a sha256 with the last snapshot. The first check only remembers the page. None of this calls a model, and none of it adds an Inbox entry.
- **Changes.** A changed text starts a short chat in the watch's project, in `ask` mode, with the lines added and removed (marked as untrusted page content) and the owner's note on what matters. Its reply starts with `RELEVANT:` or `NOT RELEVANT:` (no verdict counts as relevant). An irrelevant change is recorded in the run and its chat only.
- **Notifications.** A relevant change adds a **changed** Inbox entry (and a push, held in quiet hours) up to the watch's `notifyPerDay` (default 3, by your calendar day); later ones are kept for the next briefing. If watches together tell you more than 10 times in a day, one **Watches are busy today** entry says so. A page that cannot be read adds one failed entry, not one per check.
- **Jobs panel.** Watches show the host they watch, the selector and when they last checked; their history shows each check's outcome (`No change`, `First check`, `Changed, told you`, `Changed, not relevant`, `Changed, kept for the briefing`, `Could not read the page`) and model use. Editing a watch there changes its name, note, schedule and pause state; change the page from a chat.
- **Storage.** `<dataRoot>/watches/<jobId>.json` (`0600`) keeps the validators, the last 10 snapshots (up to 50,000 characters each) and the last 50 relevant changes. Deleting the watch deletes the file; files of watches deleted while the server was down go at the next start.
- **Briefings.** Changes over a watch's limit, and every relevant change, appear in the next [briefing](#briefings) that has the watches section.
- **API.** Watches are jobs with a `watch` field: `{ "url": "https://…", "selector"?: "div.release", "notifyPerDay"?: 3 }` (the job's `prompt` is the note on what matters). `GET /api/jobs` adds `watchState`: `{ checkedAt, snapshots, recentChanges }`. Runs carry `watch`: `{ outcome, relevant?, notified?, heldForBriefing? }` with `outcome` one of `not_modified`, `unchanged`, `baseline`, `changed`, `fetch_failed`. Errors: `watch_url_invalid`, `watch_selector_invalid` (one compound selector only: tag, `#id`, `.class`), `watch_notify_invalid` (0 to 24).

### Briefings

A briefing is a job with a fixed shape: a short, sourced roundup at a set time. Ask in a chat ("brief me every morning at 7 with games and tech news") and the Assistant proposes it with `schedule_briefing`. The approval card shows when it arrives, its sections, the news topics, the length and your notes; nothing is saved until you allow it. Defaults: every day at 07:00 in your time zone (Settings), every section, about 300 words. `schedule_briefing` with a `jobId` changes one, and `delete_job` deletes it.

- **Sections**, in the order you pick: `watches` (relevant changes your watches found since the previous briefing, including ones over a watch's daily limit), `news` (the chat searches the web for each topic), `calendar`, `email`, and `open_items` (tasks waiting for you, blocked or ready, and scheduled runs waiting for an approval, each with its link in the web app or its pull request).
- **Before the turn**, the server gathers the watch changes and open items itself and puts them in the prompt (watch summaries marked as untrusted page content). A section it cannot fill becomes one fixed line instead of a failure: news without web search on the project (it needs the **Open web** preset and a search backend), and calendar or email without a usable connection. A section with nothing new says so in one line.
- **Calendar and email** come from your [MCP servers](#mcp-servers). The server looks for enabled read tools about the calendar or email: by name (`calendar`, `gmail`, `inbox`, …), or `events`/`messages` on a server whose name says calendar, mail, Google, Outlook and so on (so a chat app's `search_messages` is not taken for email). Tools on the always-ask list never count. If some are on **Run**, the prompt names them (with any limit) and the chat reads today's and tomorrow's events, and email since the previous briefing worth your attention, each bullet ending with the event's or message's link. Events and email are framed as untrusted data, and the chat must not accept, reply, archive, label, draft or act on what they ask (a message asking it to approve or run something is listed as suspicious). Otherwise the section is one line: "not connected yet", "connected, but reading it asks you first" (set the read tools to Run), or "the connection needs you" (signed out or failing). **Email triage**: a briefing with only the email section (for example at lunchtime) is the triage job; there is no separate kind.
- **The briefing chat** runs in `ask` mode in the job's project, with the persona. The prompt asks for one heading per section, a source link at the end of every bullet, the length budget, and no changes of any kind.
- **Source check.** After the turn the server counts bullets without a link (status lines excepted) and records them on the run (`briefing.unsourced`). The Inbox entry then says so in its title ("Morning briefing (2 items without a source)"), and the Jobs history shows it.
- **Delivery.** A finished briefing adds a **briefing** Inbox entry with its start; the full text is in its chat. The push waits out quiet hours like any other; the Inbox entry does not. The first briefing covers watch changes from the last 24 hours; each later one starts where the previous finished briefing stopped, so a failed briefing's changes go into the next.
- **API.** Briefings are jobs with a `briefing` field: `{ "sections"?: [...], "topics"?: [...], "maxWords"?: 300 }` (the job's `prompt` is your notes). Runs carry `briefing`: `{ since, through, watchChanges, unsourced? }`. Errors: `briefing_sections_invalid`, `briefing_topics_invalid` (up to 10, 80 characters each), `briefing_length_invalid` (100 to 1,500), `job_kind_conflict` (a job cannot be both a watch and a briefing).

### Coding tasks

A task takes a coding objective for a repository (public, or private when the repository has a [GitHub connection](#publishing-tasks-to-github)) and works on it in its own fresh clone, on its own branch, until the work is committed, validated by the server and reviewed by a model from another provider. It needs `projectsRoot`. A finished task is `ready` with its commits and evidence in the clone; with the [publisher](#publishing-tasks-to-github) and the repository's permission it is then pushed and opened as a draft pull request.

- **The chat decides.** You do not pick a mode: you ask, and the Assistant chooses one of four ways. It **answers here** when it can (questions, explanations, short reads). It **works here** for a quick change or one you want to watch: `start_task` (or `continue_task`) with `here: true` runs the task as usual (its own clone, branch, checks and review) and shows its work in this chat, streaming live, with its approvals and gate notes ("Running the repository's checks…", "A check failed…"). A message you send there steers the task, and **Stop** stops it. One task is shown in a chat at a time; a newer one replaces it, and the chat goes back to normal when the task finishes. It **starts a work session** (`start_task` without `here`) for big or long work, which gets its own chat in the list. It **schedules** work for later or for repeats with a job.
- **Starting one.** `POST /api/tasks`, or ask in a chat: the Assistant proposes it with `start_task`, and an approval card shows the exact repository, base branch, model and objective. The first task for a repository always needs the card, even in an autonomous chat. In an autonomous chat, a later task for a repository that already had one (and that saves no new checks or publish permission), and a `continue_task`, start without a card, like Approve for Me in VS Code; in an `ask` chat they still ask. Background agents never skip the card. `list_tasks` reads the tasks without asking. Objectives proposed from a chat are limited to 4,000 characters.
- **One card.** When the repository has no checks yet, the chat proposes them in `start_task`'s `validation` (it reads the repository's scripts, Makefile or CI workflow first) and the card lists them. When the repository has no publish permission and one GitHub connection is chosen for it (the only one that reaches it, or the one whose account owns it), the card also asks to publish draft PRs with that connection (otherwise the card says nothing will be pushed and why). Approving the card saves exactly what it showed for the repository, then starts the task. Anything you changed in the GitHub panel while the card waited wins: that part is not saved, and the chat is told. Checks the repository already has are kept and never replaced from a card.
- **Workspace.** The server clones the repository into `<projectsRoot>/.tasks/<taskId>/<repository>` (the base branch, or the default one) and creates `agentlink/<words-of-the-objective>-<taskId>` at that commit. Commits are authored by `AgentLink Assistant`; when the repository publishes with a GitHub connection, each commit also gets a `Co-authored-by` trailer with that connection's name and email (added by a `prepare-commit-msg` hook in the clone, so the chat cannot leave it out). Each task folder (`<projectsRoot>/.tasks/<taskId>`) is mounted as its own hidden project, so its file tools reach only that task's clone and references; commands run only with a working directory inside the clone. With [session runners](#session-runners) the task's session runs in its own container that sees only that folder; without them, its commands run in the command worker, which (as for projects) can see the whole projects folder.
- **References.** A task can name up to 3 other GitHub repositories to read (`references` on `POST /api/tasks` and `start_task`, for example the project a website page describes), and the card lists them. Each is cloned at its default branch head into `<task folder>/refs/<owner>/<name>`, shallowly for a public one, or through the publisher's bundle with that repository's own connection when one reaches it (so private ones work and the token stays in the publisher). They are made read-only (by file permissions: a working rule, not a security boundary) and are never pushed. The commit and clean-tree checks, validation and the reviewer's diff look only at the clone, never at `refs/`. A reference that cannot be cloned fails the task with `reference_failed`, naming it; it can be resumed once fixed. The task's chat and reviewer are told where the clone and references are.
- **Implementation.** One task runs at a time; the rest wait as `queued`. The work is an autonomous chat in the task's project, told the objective, the branch and that it must commit everything there. When it finishes, the server checks the clone itself: still on the task branch, no uncommitted or untracked files, and at least one commit beyond the base. If not, the chat is told what is wrong and tries again, at most twice more, then the task `failed` (`wrong_branch`, `uncommitted_changes` or `no_commits`, with `git status` as `errorDetail`). Accepted work is recorded as evidence against its exact commit. A task's turns have no step or time limit, and its chat carries on by itself while its todo list has unfinished items ([Long-running work](#long-running-work)).
- **Validation.** The owner sets each repository's validation commands with `PUT /api/tasks/repositories` (up to 10, each up to 1,000 characters). The repository's own files never decide what runs. Once the work is committed, the server runs them in order in the task's clone, in the command worker with `<commandWorker.shell> -c`, stopping at the first failure (20 minutes per command). Each command's exit code, duration and the last 4,000 characters of output are recorded against that exact commit. A command that changes tracked files (for example a formatter) fails the run; anything the commands change or leave behind is put back afterwards. The chat's own claims that tests pass are not evidence. With no commands set, validation is skipped.
- **Review.** A separate chat in the task's clone, on a model from another provider (the `review` model role when it is on another provider than the implementer, otherwise the first configured model that is), reads the diff `baseCommit..commit` and the objective. It may read files; every request to edit, run a command or start an agent is refused. It ends with JSON findings (`blocking` or `suggestion`, with optional file and line), which are recorded against the commit. An unreadable answer gets one request to resend the JSON. No reviewer, a failed reviewer turn or unreadable findings make the task `blocked_review`.
- **Fix rounds.** Failed validation or blocking findings go back to the implementation chat (`fixing`), at most twice. A new commit is validated and reviewed again in a fresh review chat; evidence for an earlier commit no longer applies. If validation still fails after two rounds the task `failed` (`validation_failed`); if blocking findings remain it is `ready` with `openFindings` counting them.
- **States.** `queued`, `preparing`, `implementing`, `awaiting_approval` (protected files and background actions still ask; it waits up to 12 hours, then `cancelled`, `approval_expired`), `validating`, `reviewing`, `fixing`, `ready`, `failed`, `cancelled`, `blocked_auth`, `blocked_quota`, `blocked_review`, `editing` (you took it over in the [editor](#editor-takeover)), and `interrupted` (the server stopped while it worked). Nothing continues after a restart by itself: **resume** it, which continues in the same chat and clone (going straight to validation and review when the committed work was already accepted), or clones again if the clone never finished. Fix rounds start again on resume.
- **Publishing.** A `ready` task is published by itself only when the review approved its exact head commit, the repository's validation commands passed on that commit, and the repository has a publish permission. Otherwise the owner publishes it with `POST /api/tasks/:id/publish`: with open findings, or (`allowUnreviewed: true`) without a review, including from `blocked_review`. Validation that has not passed always blocks. The task is `publishing` while the publisher pushes the commit to the task branch (never forced) and opens or updates its draft pull request, then `published` with `pullRequest` and `publishedCommit`. A failure keeps it `ready` with the publisher's `error` and `errorDetail`. A publish the server was stopped in the middle of runs again when it starts; publishing a `published` task again updates the same branch and pull request. If the repository's permission moved to another connection than the one this task's commits credit, publishing is refused (`connection_changed`).
- **In the conversation.** A task started from a chat remembers that chat (`origin`). When the task is `published`, `ready`, `failed` or blocked, the outcome comes back to that chat by itself: a short notice (title, repository, branch and pull request) and a turn in which the Assistant tells you what happened and, for a problem, what to do. Each outcome is delivered once, even across restarts (what was delivered is kept in `<dataRoot>/tasks/deliveries.json`); a chat that was deleted is skipped. The Inbox entry and notification still happen. While you have the chat open, a card above the composer shows each of its tasks (up to 3, newest first) with the same state label as the Tasks panel and its pull request; clicking it opens the task in Tasks.
- **Follow-ups.** For changes to work a task already did, the chat proposes `continue_task` with the task's ID and the instructions (up to 4,000 characters), shown on an approval card like `start_task` (none in an autonomous chat). Allowed from `ready`, `published`, `failed` and blocked tasks whose clone still exists (otherwise `task_not_continuable` or `task_not_started`). It continues in the same implementation chat, clone and branch, then validates, reviews (the reviewer sees the follow-ups) and publishes again to the same pull request, whose description lists them (up to 20 are kept). The task's outcomes then go to the chat that continued it.
- **Its own chat.** The implementation chat is a chat like any other: it is listed (with a pull-request badge, under the **Tasks** filter) in the chat list of the project it was started from, or the first project, streams live while the task works, and shows the task's card. Write to it as you would in VS Code: while the task's turn runs, the message is taken in at its next break (after the current tool calls, or before it would finish), and a message the turn ends without taking is read in the task's next step; when the task is not working, the message continues it (`ready`, `published`, `failed`, blocked, `cancelled` and `interrupted` tasks). **Stop** in it stops the task, which can be resumed.
- **Deleting** stops the task, closes its chat and removes its clone and record, its chats (implementation and reviews, in the server or a session runner, with the control plane's copies), their events and its Inbox entries. Its audit entries stay. It does not touch the branch or pull request on GitHub.
- **In the web app.** **Tasks** (next to Jobs and Inbox) lists tasks with their state, repository, branch and pull request. A task shows its evidence for the current commit (each validation command with its output tail, the review verdict and findings), its state history, **Open chat** for its own chat (read-only here for a task not started from a chat), and its review chats (read-only). **Stop**, **Resume** and **Delete** are there, and a `ready` or `blocked_review` task that did not publish by itself says why and, when its repository has a publish permission, offers **Publish draft PR** (**Update PR** for new commits on a published task, **Publish without review** when nothing reviewed its commit).
- **Inbox.** A task that opens or updates its draft pull request, is `ready` without publishing, is blocked, fails, is interrupted or waits for an approval adds an [Inbox](#scheduled-jobs) entry (and a [notification](#notifications)) with its `taskId`; clicking it opens the task. Each task keeps one entry, replaced as its outcome changes, and an entry is marked read once the task is working again.

| Route                         | Body                                               | Result                                                                                                                                                                                     |
| ----------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/tasks`              |                                                    | `{ tasks, enabled }`, newest first                                                                                                                                                         |
| `POST /api/tasks`             | `{ repository, objective, baseBranch?, model? }`   | `202 { task }`                                                                                                                                                                             |
| `GET /api/tasks/:id`          |                                                    | `{ task, events, validation, publish }`: the record, its state changes, the repository's commands and publish permission (or `null`); `task.current` is the evidence for `task.headCommit` |
| `GET /api/tasks/repositories` |                                                    | `{ repositories }`: validation commands and publish permission per repository                                                                                                              |
| `PUT /api/tasks/repositories` | `{ repository, validation?, connectionId? }`       | `{ repository }`; `connectionId` grants publishing with that connection, `null` revokes it; nothing left removes it (`null`)                                                               |
| `POST /api/tasks/:id/publish` | `{ allowUnreviewed? }`                             | `202 { task }`; `409 task_not_ready`, `task_busy`, or why it cannot be published                                                                                                           |
| `POST /api/tasks/:id/stop`    |                                                    | `{ task }` (`cancelled`)                                                                                                                                                                   |
| `POST /api/tasks/:id/resume`  |                                                    | `202 { task }`; `409 task_busy`, `task_not_resumable`                                                                                                                                      |
| `POST /api/tasks/:id/editor`  | `{ action: "open" \| "take_over" \| "hand_back" }` | `open`, `take_over`: `{ task, mode, url }`, a one-time link to the [editor](#editor-takeover); `hand_back`: `202 { task }`; `409 editors_not_configured`, `task_not_editing`               |
| `DELETE /api/tasks/:id`       |                                                    | `{ ok: true }`                                                                                                                                                                             |
| `GET /api/tasks/:id/audit`    |                                                    | `{ entries, verification }`: the task's [audit log](#task-audit-log) entries, oldest first (kept after it is deleted), and whether the whole log's hash chain is intact                    |

The task's chat is `GET /api/projects/<task.projectId>/sessions/<task.sessionId>`. Only the owner can use these routes (`403 tasks_forbidden`). Errors: `400 repository_url_invalid` (https, no credentials), `objective_required`, `base_branch_invalid`, `model_not_available`, `task_field_unknown`, `validation_invalid`, `validation_command_invalid`, `too_many_validation_commands`, `repository_change_required`, `connection_not_found`, `repository_not_github`; `404 task_not_found`; `409 publisher_not_configured`, `publish_permission_missing`, `connection_changed`, `implementation_not_current`, `validation_not_passed`, `review_missing`; `409 tasks_disabled` (no `projectsRoot`), `task_limit_reached` (200 tasks). Records are stored in `<dataRoot>/tasks/tasks.json` (an unreadable file stops the server from starting), state changes in `<dataRoot>/tasks/events.jsonl` and validation commands in `<dataRoot>/tasks/repositories.json`.

### Editor takeover

With [session runners](#session-runners) and the `compose.editor.yaml` overlay, a task's folder opens in a browser editor (code-server, pinned in the Dockerfile's `editor` target), so you can look at what a task is doing or fix something yourself.

- **Open editor** (in the task in **Tasks**) opens the task's folder read-only in a new tab, even while the task works.
- **Take over** stops the task's current turn straight away and opens the folder writable. The task is `editing`: it does not resume, continue or publish until you give it back. Edit files and commit or not; the editor's terminal runs inside the editor's own container.
- **Hand back** closes the editor and continues the task in its chat with a note listing the files changed since you took over (committed or not), so its next turn sees them. The task then commits, checks and reviews as usual. While a task is `editing`, its card in the chat it came from also offers **Open editor** and **Hand back**.
- **Idle.** An editor with no open tab and no activity for 30 minutes (`editor.idleMinutes`) is stopped; a taken-over one is handed back by itself, with a note saying so.
- **Isolation.** Each editor is its own container started by the runner manager, with only that task's folder mounted (read-only unless taken over), no credentials, a read-only root filesystem and the runners' limits, on an internal network shared only with the assistant and the egress gateway. Extensions install from Open VSX through the egress gateway (package registries plus `open-vsx.org`).
- **Its own origin.** Editors are served on their own HTTPS port (8444, the app's certificate and host names), so editor pages and extensions never run on the app's origin. The app hands out a one-time link (2 minutes); opening it sets a cookie for that task's editor only (12 hours, or until the editor stops). The app's sign-in cookie is never accepted or passed on there, and unsafe requests and WebSockets must come from the editor's own origin.
- **AgentLink in the editor.** The editor image has the AgentLink extension built in, from the same commit (`upgrade.sh` packages it for Linux on the machine's architecture, as `apps/server/dist/agentlink-editor.vsix`). It is set up for you with one connection, **AgentLink Assistant**, listing the assistant's models (the first is the default). Its model calls go to the assistant over the editors' network (`editor.modelsPort`, default 7900), which makes them with its own sign-ins, so no key or sign-in enters the editor. Each editor gets its own token when it starts, and the token stops working when that editor stops. Thinking is not shown there. AgentLink's chat in the editor is its own chat, not the task's: while you have the task taken over, it edits the same folder you do, and the hand-back note lists its changes too.
- **Restarts.** Editors stop when the server stops; an `editing` task stays `editing`, and **Open editor** starts its editor again.
- **Audit.** Opening, taking over and handing back are recorded in the [audit log](#task-audit-log) with who asked (an idle hand back says so).

```sh
# In the deploy directory, once (with compose.runners.yaml already set up)
# .env: COMPOSE_FILE=...:compose.runners.yaml:compose.editor.yaml
# upgrade.sh builds agentlink-editor:local along with the other images.
# Then, after the upgrade (an older server refuses keys it does not know):
# server.json: "editor": { "port": 8444 }
docker compose up -d
```

### Browser research

Chats on a project set to **Open web** can read pages that need JavaScript or clicking through in a throwaway, signed-out headless Chromium, with `browse_open` (a public `https` page, by name), `browse_snapshot` (the page as text, with numbered links, buttons and fields), `browse_click`, `browse_type` (optionally pressing Enter) and `browse_screenshot`. Use `web_fetch` first; browsing is for what it cannot read.

- **Containment.** The runner manager starts one browser container per chat (`agentlink-browser:local`, Playwright's Chromium headless shell, pinned): no mounts, no credentials or environment from the assistant, a fresh profile in `/tmp`, a read-only root filesystem, no capabilities, the runners' limits, and only the `agentlink-browsers` internal network, shared with the assistant (which drives it over DevTools) and the egress gateway. Every request goes through the gateway under the project's signed policy: the gateway challenges the browser, and the assistant answers over DevTools, so the policy's credentials are never in the container. Private, LAN and loopback addresses are unreachable (the gateway refuses them), and `browse_open` refuses address literals and local names before trying.
- **Refused.** Downloads, file uploads and file pickers, typing into password fields, and clicking or submitting in a form that has a password field: browsing never signs in. A site's own sign-in prompt is cancelled. JavaScript dialogs are dismissed. Plain `http` addresses are tried as `https` (the gateway carries HTTPS only).
- **Lifetime.** A chat's browser starts on its first `browse_*` call and stops when that chat's turn ends, or after `idleMinutes` (default 10) unused; leftovers are stopped when the assistant starts.
- **Untrusted content.** Snapshots and screenshots are framed as the page's own words, never instructions, with the address to cite.
- **Setup.** With `compose.runners.yaml` in place: add `compose.browser.yaml` to `COMPOSE_FILE` in `.env`, add `"browser": {}` to `server.json` (after the upgrade that brings it), and run `upgrade.sh`, which builds `agentlink-browser:local`. It needs the egress gateway (`commandWorker.egressProxy`).

### Task audit log

The server keeps an append-only record of what happened to every coding task in `<dataRoot>/audit/tasks.jsonl`, one JSON entry per line, never rewritten. It records:

- the task's creation (repository, branch, objective, model, references, and the chat that started it), each state change with its error, and each follow-up with the chat that asked for it;
- each gate's result: validation (each command's exit code, time-out and duration, not its output) and review (model, verdict and findings), against the exact commit;
- each external effect: a push or draft pull request, when it is intended and when it is done or fails;
- the implementation chat and whether it runs in a [session runner](#session-runners) or in the server, and the GitHub connection the task uses;
- who asked: a `request` entry for each create, stop, resume, publish or delete by the owner in the app (with the device), each **Stop** and each message in the task's own chat, and each **Stop** from an Inbox notice;
- the deletion. Deleting a task keeps its entries.

Free text (the objective, follow-up instructions, messages, error details and review reasons) is recorded only as `sha256:<hex>` of the text, so deleting a chat or task leaves none of its words in the log, and the chain is untouched. Entries written before this change kept the text, truncated to 4,000 characters.

Each entry has a sequence number and the SHA-256 hash of the entry before it, and `audit/head.json` records the last one, so changing, removing or reordering an entry, or removing entries from the end, breaks the chain. Check it with `agentlink-server audit-check --config <file>` (in the container, `docker compose exec assistant agentlink-server audit-check`): it exits 0 when the chain is intact and 1, naming the first broken entry, when it is not. `GET /api/tasks/:id/audit` returns a task's entries and the same check, plus the checkpoints' status.

When the server starts, a final line cut short by a crash is dropped. A damaged log is kept beside it as `tasks.jsonl.damaged-<time>`, and the log continues from its last good entry with a `log_damaged` entry naming the problem, so the damage stays on record.

Only the server writes the log. The models' commands run in the command worker or a session runner, neither of which mounts the data root. On its own, the chain shows that the log was edited or cut short, not that someone with access to the data folder rewrote all of it consistently; checkpoints cover that.

**Checkpoints.** With [backups](#backups) set up, the server signs the log's head (sequence number and hash) with its own Ed25519 key (`<dataRoot>/credentials/audit-signing.key`, created on first start) and stores it in the append-only backup store through the backup sidecar, as a small snapshot of its own (restic host `agentlink-audit`, so backup listings and restores never pick it). It checkpoints straight after every push or pull request, and otherwise hourly while the log changes. A checkpoint that fails (the store is down) is retried every 10 minutes and reported once in the Inbox; the entries stay pending until one gets through.

- `agentlink-server audit-check --checkpoints` also fetches every checkpoint, checks each signature, and checks that the log still has the checkpointed hash at each sequence number. A rewritten or shortened log fails it even when its chain and head were recomputed. `--directory <dir>` checks a copy of the log instead of `<dataRoot>/audit`.
- The key that signed the store's first checkpoint is the trusted one: checkpoints signed with another key are ignored (and counted), and a server whose key is not that one fails the check, so replacing the key does not hide a rewrite. Use a new backup repository if you start a deployment over.
- The server also compares the log with the checkpoints hourly and after each checkpoint; a mismatch adds an Inbox entry. The Inbox panel shows the last checkpoint under Backups, `--check` prints an "Audit checkpoints" line, and `GET /api/tasks/:id/audit` and `GET /api/backups` include `checkpoints` (last checkpoint, last failure, entries pending, last comparison).
- Limits: entries written after the latest checkpoint are protected by the local chain only, and a compromised server can still write false new entries. The signature shows a checkpoint came from this server; the store's append-only rule is what stops one being replaced. With the store on the same machine (the default), losing the machine loses the checkpoints too.

### Publishing tasks to GitHub

GitHub tokens live in a separate process, the **publisher** (`agentlink-server publisher`, its own container). It can do exactly three things for a task: fetch the repository's base branch when the task starts (see private repositories below), push the task's commit to the task's own `agentlink/*` branch (never forced, and never any other branch), and open or update that task's draft pull request. Besides that it can only list the repositories each connection reaches (names and metadata, see below). It reads the task clones read-only, fetches the commit into its own scratch repository with hooks turned off, and gives git the token only through the environment. Tokens are encrypted at rest with a key only the publisher reads. The assistant reaches it on a private network with a shared token; the command worker, where the models' commands run, cannot reach it at all. The assistant server itself keeps only each connection's GitHub login and commit identity.

**Connections.** In the web app, **GitHub** (next to Jobs and Inbox) lists connections and repositories. A connection is one GitHub account plus the name and email its task commits credit as co-author:

- **GitHub App (recommended).** **Connect GitHub** shows a code to enter at `github.com/login/device`; the panel updates once GitHub confirms. The app's user tokens are refreshed by the publisher. This works on the repositories you installed the app on.
- **Fine-grained token** (fallback, for repositories the app cannot be installed on): give it Contents and Pull requests (read and write) on those repositories only. The token is sent once to the publisher and never shown again.

**Finding repositories.** The publisher lists the repositories each connection can reach: for a GitHub App connection, those of every installation of the app the account can see (so adding a repository to the app's installation at `github.com/settings/installations` makes it findable); for a fine-grained token, `GET /user/repos`. It returns only owner, name, visibility, archived, default branch, description and last push, at most 1,000 per connection, never a token. The server merges this with the repositories configured below and the ones cloned into projects, and keeps it for 5 minutes. **GitHub → Repositories the Assistant can reach** shows it, with **Refresh**. Chats search it with the `list_repositories` tool (no approval), so asking "update my website" finds the repository without a URL, and they are told to use it rather than ask. Each project chat's instructions also tell it to start coding tasks from any chat (they run in their own clone, so no project switch is needed), to find repositories itself, and to explain problems with the fix in plain words.

**Reading repositories.** With the publisher, chats also get `read_repository` (no approval): it lists a repository's files, reads one (the first 100 KB) or searches text files, at the head of the default branch, so the Assistant can answer questions about code and find a task's checks before proposing it. The publisher fetches it shallowly with a connection that reaches it (or no token at all for a public repository: one no connection reaches and that is not public cannot be read, and the chat is told to add the app to it) and returns a tar of that commit's files (`POST /v1/archive`, at most 200 MB). The server keeps the tar in `<dataRoot>/repository-snapshots` without extracting it, reads only regular files from it (never links), reuses it for 15 minutes (or fetches again on request) and deletes it 24 hours after it was fetched, and when the server restarts. File contents are passed to the chat as untrusted data.

**Private repositories.** When a repository has a connection (set in its settings, or else the only connection that reaches it; when several reach it, the one whose account owns it, otherwise none until the owner chooses one) and the publisher is set up, a new task's base branch is fetched by the publisher with that connection's token, not by the server: the publisher bundles the branch and the server clones the task from that bundle, then points `origin` at the plain `https://` URL. The token never reaches the server, the clone or the command worker, so private repositories work and nothing in the clone can use the token. Inside the task, `git fetch` or `git pull` against a private `origin` fails; the task works from the snapshot it started with. A failed fetch fails the task with the publisher's reason (for example `connection_signed_out` or `fetch_failed`), and it can be resumed once that is fixed. Base branches must be branches, not tags, on this path. Without a connection, the server clones as before, which works only for public repositories.

**Permission.** Each repository's settings name at most one connection it publishes with. Granting it is standing permission: ready tasks for that repository are published without asking again, within the rules above. Clearing it, or removing the connection, revokes it. Reaching a repository is not permission to publish to it: a task cloned through a reachable connection credits that connection's commit identity, but stays `ready` until the owner grants the permission (with that same connection) or publishes it by hand.

**Setting it up (container).**

1. Register a GitHub App (Settings → Developer settings → GitHub Apps → New): any homepage URL, no webhook, **Enable Device Flow** checked, repository permissions **Contents: Read and write** and **Pull requests: Read and write**. Install it on the repositories tasks may publish to, and note its **Client ID** (not a secret; no client secret is needed).
2. In the deploy directory:

```bash
# Build (from the repository root)
docker build --target publisher -t agentlink-publisher:local \
  -f apps/server/deploy/container/Dockerfile apps/server

# In the deploy directory, once
mkdir -m 700 publisher && mkdir -p projects/.tasks
openssl rand -hex 32 > secrets/publisher-token
openssl rand -hex 32 > secrets/publisher-key
chmod 600 secrets/publisher-token secrets/publisher-key
# .env: COMPOSE_FILE=compose.yaml:compose.publisher.yaml (append others you use)
# .env: AGENTLINK_GITHUB_CLIENT_ID=<the app's Client ID>
# server.json: "publisher": { "host": "publisher", "port": 7400,
#                             "token": { "file": "/run/secrets/publisher-token" } }
docker compose up -d
docker compose exec assistant agentlink-server --check   # reports the publisher
```

Losing `secrets/publisher-key` makes the stored connections unreadable: connect them again. Without a client ID, only fine-grained tokens can connect.

| Route                                     | Body                                                               | Result                                                                                                                                                                                                                                                         |
| ----------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/github`                         |                                                                    | `{ configured, available, deviceFlow, connections: [{ connection, status }] }`                                                                                                                                                                                 |
| `POST /api/github/connections`            | `{ method: "device" \| "token", commitName, commitEmail, token? }` | `201 { connection, status }`; `device` returns `{ userCode, verificationUri }`                                                                                                                                                                                 |
| `GET /api/github/connections/:id`         |                                                                    | `{ connection, status }`: `pending`, `connected`, `denied`, `expired`, `missing`, `failed`, `unavailable`                                                                                                                                                      |
| `POST /api/github/connections/:id/device` |                                                                    | Sign in again: `{ connection, status }`                                                                                                                                                                                                                        |
| `PUT /api/github/connections/:id/token`   | `{ token }`                                                        | Use a token instead: `{ connection, status }`                                                                                                                                                                                                                  |
| `PATCH /api/github/connections/:id`       | `{ commitName?, commitEmail? }`                                    | `{ connection }`                                                                                                                                                                                                                                               |
| `DELETE /api/github/connections/:id`      |                                                                    | `{ ok: true }`; also revokes every repository permission that uses it                                                                                                                                                                                          |
| `GET /api/github/repositories`            | `?refresh=1` asks GitHub again                                     | `{ publisherConfigured, fetchedAt?, connections: [{ id, login, status, error?, repositories, truncated? }], repositories: [{ repository, fullName, private?, archived?, defaultBranch?, description?, pushedAt?, connectionIds, configured?, projectIds? }] }` |

Only the owner can use these routes (`403 github_forbidden`). Errors: `400 connection_field_unknown`, `connection_method_invalid`, `commit_name_invalid`, `commit_email_invalid`, `token_required`; `404 connection_not_found`; `409 publisher_not_configured`, `connection_limit_reached` (20); the publisher's own errors (for example a token without access) are passed on, with `502` when it failed. Connections are stored in `<dataRoot>/github/connections.json`.

### Notifications

Each new [Inbox](#scheduled-jobs) entry is also sent as a Web Push notification to every device that turned notifications on, so you hear about a finished run or a waiting approval with no tab open. Tapping a notification opens the run's chat.

- **Turning them on.** In the web app open **Inbox** → **Turn on** and allow notifications when the browser asks. **Send test** checks delivery. Each device decides for itself; turn one off there, or on `/devices` (**Turn off notifications**) for any device.
- **iPhone and iPad.** Safari delivers Web Push only to an app on the Home Screen: open the Assistant in Safari, **Share** → **Add to Home Screen**, then open it from there and turn notifications on. The web app says so when this is needed.
- **Desktop app.** The desktop app's Assistant view has no push service, so it shows a notification for new Inbox entries only while it is open.
- **What is sent.** The job name and outcome, plus a fixed description, unless `notifications.includeSummary` is `true`. Payloads are encrypted for the device (RFC 8291) and pass through the browser vendor's push service, which sees only the device's endpoint and the time.
- **Network.** With an [egress gateway](#egress-gateway), push requests go through it and may reach only the push services (`fcm.googleapis.com`, `updates.push.services.mozilla.com`, `*.push.apple.com`, `*.notify.windows.com`); otherwise the server sends them directly. A failed send is retried up to 3 times; a subscription the push service reports gone (`404`/`410`) is removed.
- **Keys and storage.** The server's VAPID key pair and the subscriptions (one per device, at most 50) are in `<dataRoot>/push/` (`0600`). Revoking a device removes its subscription. If the key file is lost or unreadable a new pair is made and every device must turn notifications on again.
- **How often.** `<dataRoot>/push/deliveries.jsonl` counts each Inbox notification (when, and how many devices took it; no text, no device), for the usage report below. Test pushes are not counted.

**Usage report.** `agentlink-server usage-report --config <file> [--days <n>]` (in the container, `docker compose exec assistant agentlink-server usage-report --days 7`) prints, per day in the owner's time zone, the Inbox entries by kind, the notifications sent, and the scheduled jobs' runs, model requests and tokens, in total and per job. It only reads the data files, so it is safe while the server runs. History is bounded (500 Inbox entries, 50 runs per job, and deleting a chat removes its entries), so for a comparison over several days append `--days 1` to a file from a daily cron job late each day.

| Route                           | Body                                     | Result                                               |
| ------------------------------- | ---------------------------------------- | ---------------------------------------------------- |
| `GET /api/push`                 |                                          | `{ publicKey, subscribed }` for this device          |
| `PUT /api/push/subscription`    | The browser's `PushSubscription` as JSON | `{ subscribed: true }`                               |
| `DELETE /api/push/subscription` |                                          | `{ subscribed: false }`                              |
| `POST /api/push/test`           |                                          | Sends a test notification; `409 push_not_subscribed` |

Only the owner can use these routes.

### Persona, time zone and quiet hours

**Settings** in the web app sets how the Assistant sounds and when it notifies you. None of it changes what the Assistant may do: permissions, approvals and tools stay as they are.

- **Name and persona.** The Assistant is called AgentLink Assistant until you rename it. Its persona (up to 2,000 characters) is added to the instructions of your chats, scheduled runs and their background agents, after AgentLink's own identity; **Use the default** restores the built-in one. Coding task and review chats get only the name, the time zone and today's date, so commits and pull requests keep the repository's voice.
- **What it calls you.** Optional; otherwise it says "the owner".
- **Time zone.** Used for dates and times in chats and as the default for new [scheduled jobs](#scheduled-jobs). Until you set it, it is the server's time zone.
- **Quiet hours.** 22:00 to 07:00 in your time zone by default. Inbox entries are still recorded, but their notifications wait until the quiet hours end; then what is still unread is sent, one as itself or several as one summary. Approval requests still notify unless you untick that. Waiting notifications are kept in memory, so a restart during quiet hours drops them (never the Inbox entries).
- **From a chat.** Ask a chat to change any of these ("be more formal", "I'm in Perth this week") and it proposes the change with `propose_persona_change`. The approval card shows each change as `before → after`, appears even in an autonomous chat, and is refused if the settings changed while it waited. Changes apply from the next message.
- **Storage.** `<dataRoot>/settings/persona.json`. A file the server cannot read stops it from starting rather than silently dropping your settings; `--check` prints the current name, time zone and quiet hours.

| Route                         | Body                                                                                                      | Result                                          |
| ----------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `GET /api/settings/persona`   |                                                                                                           | `{ settings, defaultPersona }`                  |
| `PATCH /api/settings/persona` | Fields to change (`name`, `persona`, `ownerName`, `timeZone`, `quietHours`), optional `expectedUpdatedAt` | `{ settings }`; `409 settings_changed` if stale |

`null` resets the persona to the default, clears `ownerName`, or turns quiet hours off. Only the owner can use these routes.

### Memory

The Assistant remembers lasting things you tell it about yourself (preferences, facts about you, decisions and corrections) and uses them in later chats. **Memory** in the web app shows what it remembers.

- **Remembering.** In your chats (not coding task chats or background agents), when you state something lasting, the Assistant saves it with `remember`, without asking first, and a "Remembered: …" line with **Undo** appears above the composer for a day. It must quote your own words from that chat; the server checks the quote against what you wrote and refuses anything else, so text from tool results, web pages, emails, files or task output is never remembered unless you ask for it. Anything that looks like a password, key or token is refused.
- **Using it.** Each turn of your chats and scheduled runs gets the memories as a labelled evidence block (up to about 2,000 characters: all of them while they fit, otherwise those that match the message). `recall_memory` searches them. Memories are evidence, never instructions: approvals, tool and MCP policy, network presets and settings are read only from their own stores, so a memory such as "always approve pushes" changes nothing.
- **Correcting and forgetting.** The panel searches, edits (a new revision), forgets and exports (JSON) memories, shows where each came from (the chat, when and your words) and has **Forget everything**. Forgetting removes the memory, and any earlier one it replaced, from the store on disk, keeping only its ID and when. Earlier chats and backups may still contain it, and text already sent to a model provider cannot be recalled.
- **Storage.** `<dataRoot>/memory/memory.json` (`0600`), with the memory audit (every change, separate from the task audit log). It is backed up with `data/`. `--check` prints how many memories there are.

| Route                         | Body                              | Result                                      |
| ----------------------------- | --------------------------------- | ------------------------------------------- |
| `GET /api/memory?q=`          |                                   | `{ memories }`, newest first                |
| `PATCH /api/memory/:id`       | `{ statement, expectedRevision }` | `{ memory }`; `409 memory_changed` if stale |
| `POST /api/memory/:id/forget` | `{}`                              | `{ forgotten: true }`                       |
| `POST /api/memory/forget-all` | `{}`                              | `{ forgotten: <count> }`                    |
| `GET /api/memory/export`      |                                   | An `agentlink-memory` archive (version 1)   |

### Deleting and retention

Deleting a chat deletes it, not just its place in the list.

- **What goes.** The chat's messages and approvals, its background agents and their records, its commands and their output, its live events (`<dataRoot>/events`), its approval mode, its title and other notes in the chat list, and its Inbox entries. `DELETE /api/projects/:project/sessions/:session` does the same through the API (`404 session_not_found` once it is gone).
- **When it is refused.** While the chat is working (`409 session_busy`), waiting for your approval (`session_waiting`), or has a background agent (`session_agent_running`) or command (`session_command_running`) still running. Stop or answer it first. A coding task's chat goes with its task: delete the task (`ask_agent_task_chat`).
- **What stays.** Memories it created stay until you forget them in **Memory**. The audit log keeps its entries (IDs and hashes of text only, apart from entries written before this version). The session store keeps the chat's ID in its turn-fencing counter. Chats deleted by an earlier version (which only hid them) are deleted for good the first time the chat list loads.
- **Backups.** Backups still hold deleted chats and memories until the witness prunes them (48 hourly, 14 daily, 8 weekly: up to about 8 weeks with the [pruning](#backups) above). Text already sent to a model provider cannot be recalled.
- **Storage.** **Settings** shows how much each area uses (chats, coding tasks, live events, memory, Inbox, jobs, watches, audit, settings and keys, and the project folders) and how long each is kept: chats and tasks until deleted, the latest 1,000 events per chat, the latest 500 Inbox entries, jobs until deleted with their latest 50 runs, the last 10 snapshots per watch (deleted with the watch), memories until forgotten, the audit log for good. `GET /api/settings/storage` (owner only) returns `{ areas, retention, measuredAt }`; an area whose walk stopped at 200,000 entries is marked `partial`.

Only the owner can use these routes.

Not yet provided: passkeys and an installer.
