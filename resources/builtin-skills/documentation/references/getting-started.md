# Getting Started with AgentLink

AgentLink is a coding-agent harness built into VS Code, with standalone Desktop and CLI previews for macOS. The extension gives an agent the editor's language intelligence, reviewable diffs, visible terminal work, and approvals you can tune to the task; the standalone surfaces have narrower capabilities.

## Install

### From a GitHub release

Use the installer to download the VSIX for the machine running the VS Code extension host:

```sh
curl -fsSL https://raw.githubusercontent.com/reefbarman/agentlink/main/scripts/install.sh | bash
```

For a remote or emulated extension host, specify the target explicitly:

```sh
curl -fsSL https://raw.githubusercontent.com/reefbarman/agentlink/main/scripts/install.sh \
  | AGENTLINK_VSCE_TARGET=linux-x64 bash
```

You can also download the matching `.vsix` from the [latest release](https://github.com/reefbarman/agentlink/releases/latest) and install it yourself:

```sh
code --install-extension agentlink-*.vsix --force
```

The installer supports macOS (`darwin`) on `arm64` only, and `linux`, `alpine`, and `win32` targets on `arm64` and `x64`. Intel Macs are no longer supported. It verifies the release's SHA-256 checksum when one is published (releases before checksums were added skip verification with a notice). Add `--version X.Y.Z` to install a specific release or `--dry-run` to print the selected release without installing. See the [complete reference](complete-reference.md#installation) for source builds, platform details, and AgentLink Terminal requirements.

### Install standalone previews from a terminal

The same installer handles the macOS Desktop and CLI previews. Each surface has its own release series (`desktop-vX.Y.Z`, `cli-vX.Y.Z`), and the installer picks the newest published release for that surface:

```sh
# Desktop: downloads the DMG for this Mac to ~/Downloads and opens it
curl -fsSL https://raw.githubusercontent.com/reefbarman/agentlink/main/scripts/install.sh | bash -s -- --surface desktop

# CLI (Apple Silicon only): verifies the checksum and links ~/.local/bin/agentlink
curl -fsSL https://raw.githubusercontent.com/reefbarman/agentlink/main/scripts/install.sh | bash -s -- --surface cli
```

For Desktop, drag **AgentLink** from the opened Apple Silicon DMG to Applications. Desktop no longer supports Intel Macs. The CLI install extracts into a unique `~/.local/lib/agentlink/cli-preview.*` directory. It upgrades a launcher that points at an earlier preview from this installer (keeping the old bundle until you delete it) and refuses to replace any other `agentlink` command. Both previews are unsigned and not notarised.

### Install standalone previews from VS Code

In a local macOS VS Code window, open the Command Palette:

- **AgentLink: Install Desktop App** finds the latest published Desktop preview for Apple Silicon and opens its DMG download in your browser. Open the DMG and drag **AgentLink** to Applications, quitting an existing app before replacing it.
- **AgentLink: Install CLI** finds the latest Apple Silicon CLI preview and, after confirmation, runs a visible terminal installer. It verifies the release SHA-256 checksum before extraction, keeps the bundle in a unique `~/.local/lib/agentlink/cli-preview.*` directory, and links `~/.local/bin/agentlink`. It refuses to replace any existing launcher. Add `~/.local/bin` to PATH if needed, then run `agentlink --help`.

Both commands warn that published previews are unsigned and not notarised. They do not bypass macOS security warnings or change shell profiles, sessions, or credentials. Desktop may require right-click **Open** on first launch; macOS may block CLI executables. These commands are unavailable in remote extension hosts and do not add an install or shell action to the browser surface. They download published releases, not local source builds. For preview CLI removal, delete its launcher symlink and the unique bundle directory it points to, leaving `~/.agentlink` and Keychain entries intact.

### Standalone CLI preview

The [CLI preview releases](https://github.com/reefbarman/agentlink/releases?q=cli-v&expanded=true) provide a self-contained, unsigned terminal coding agent for macOS Apple Silicon, without VS Code or a separately installed Node runtime. It supports provider setup, durable per-project sessions, reviewed single-file edits and commands, MCP, up to two scoped background writers, and optional managed TypeScript/JavaScript intelligence. Install with `install.sh --surface cli` (above), or check the archive checksum yourself before a manual install, and see [Standalone CLI](standalone-cli.md#github-release-preview) for exact setup, approval, and limitations. Intel macOS, Linux, and Windows are not supported by this preview.

### Standalone desktop preview

AgentLink Desktop is a separate macOS application. Its **Ask AgentLink** view runs without VS Code or the extension and shares global `~/.agentlink` configuration and macOS Keychain accounts with other AgentLink surfaces when they are installed on the same Mac.

Use the desktop sidebar to switch between **Ask AgentLink** and **VS Code**. VS Code connects to the running local AgentLink browser gateway and displays its existing workspace tabs, chats, and review panes without desktop restyling. Both views stay mounted when switching, preserving drafts and selected tabs. If no gateway is available, open VS Code with AgentLink and use **Reconnect**; restarting the gateway reloads the remote view. Desktop never starts or replaces the VS Code gateway and does not gain extra remote shell or file-writing permissions. External windows, downloads, and browser permission requests are blocked in the isolated view; complete MCP URL-opening requests in VS Code or the regular browser gateway. Older extension builds may still show their original browser header and Ask Agent tab until updated.

The desktop chat uses AgentLink's interlocking-link logo in the title bar and welcome screen, a dark teal palette with subtle teal/violet accents, softly tinted welcome cards, a compact gradient-edged composer, and a collapsible chat sidebar. The theme is independent of your editor; interactive hover effects respect reduced-motion preferences. Use **Search chats** to filter saved conversations and **Manage chats** to rename or delete them. The sidebar opens by default in wider windows; toggle it beside the app title. The title-bar **More** menu contains **Memory**, **File access…** (local read permissions), **Continue in VS Code**, and **Settings…**. **New chat** and **Manage chats** live in the sidebar; when it is collapsed, **New chat** appears in the title bar and **Manage chats** is available under **More**. Desktop shows streaming activity in the transcript rather than repeating it in a status bar above the composer. Questions and approval cards remain visible near the input, with desktop-matched styling. The browser gateway shares this styling and Ask Agent / VS Code sidebar navigation, with a collapsed sidebar on mobile. Workspace views retain their existing VS Code-style layout. Browser settings and notifications remain available; native Work mode is reserved for the desktop and is not available in the browser.

**MCP servers:** use the labelled **MCP** button or **MCP Servers…** in the app menu to open a separate manager window with live connection status and tool counts. `/mcp`, `/mcp-config`, and `/mcp-refresh` open the same window. Configured servers connect quietly in the background; sign-in is requested when the agent needs that server or you explicitly choose **Connect**, **Reconnect**, or **Reauthenticate**. Manual sign-in stays in the MCP window. Use the shared add/edit, import, remove, enable/disable, and raw-config controls to manage servers. Desktop follows VS Code's native MCP networking, including private/local servers; see [MCP](mcp.md#desktop-mcp-window) for inherited overrides, connection recovery, and credential boundaries.

**Quick Ask:** while Desktop is running, press **⌥Space** from any app to open a floating Ask AgentLink composer. It has the same model and thinking controls as the main composer and accepts pasted images and files. Press **Enter** to send, or **Esc** (or click away) to dismiss and keep your draft. Sending opens the main Desktop window and starts the message in a new chat. If another app or macOS already uses the shortcut, Settings shows a warning and you can record a different one.

**Menu bar and Settings:** Desktop runs as a menu bar app. Closing the chat window hides it (your drafts are kept) and removes the Dock icon, while the menu bar icon keeps **Quick Ask**, **Open AgentLink**, **Settings…** and **Quit AgentLink** available. Open **Settings…** with **⌘,**, from the menu bar icon, or from **More** in the chat. It holds the Quick Ask shortcut (change, reset or turn off), **Open at login**, and your accounts. The installed app turns on Open at login the first time it runs, so it starts quietly in the menu bar after you log in. If you turn it off in Settings or remove it under **System Settings → General → Login Items**, AgentLink leaves it off. Development builds never register a login item. Quit with **⌘Q** or **Quit AgentLink**; the shortcut is unavailable until AgentLink runs again.

Install with `install.sh --surface desktop` (above), or download the Apple Silicon (`arm64`) DMG from the newest [Desktop preview release](https://github.com/reefbarman/agentlink/releases?q=desktop-v&expanded=true), open it, and drag **AgentLink** to Applications. A ZIP is also available as a fallback. Desktop artifacts have their own version and release workflow; they are never included in the VSIX. The preview is unsigned and not notarised, so the first launch may require right-clicking **AgentLink**, choosing **Open**, and confirming macOS's warning. In Ask AgentLink, sign in with a ChatGPT/Codex account or configure an API-key provider. VS Code integration is optional and requires a local VS Code window running AgentLink with its browser gateway enabled.

### Signed local desktop builds

For macOS Apple Silicon development, the AgentLink **Build and install desktop app** task runs `npm run desktop:install`. It packages with your valid **Apple Development** identity, verifies the signatures, and replaces `/Applications/AgentLink.app` only after you quit the app and its desktop helper. The separate VS Code gateway can remain running. Installed contents are verified again, with rollback if replacement fails.

Local packaging defaults to `AGENTLINK_MAC_SIGNING=development`. With multiple signing identities, set `AGENTLINK_MAC_SIGNING_IDENTITY` to the full certificate name or fingerprint shown by `security find-identity -v -p codesigning`. Missing identities cause an error, not an unsigned fallback. The signing tool may request private-key access once. The app keeps the identifier `com.agentlink.desktop`; existing Keychain entries may need **Always Allow** once for the newly signed app. Rebuilding with the same identity should preserve that approval, but a locked keychain or changed certificate/item policy can still prompt. This does not change Keychain permissions automatically.

`AGENTLINK_MAC_SIGNING=unsigned npm run desktop:package -- --target darwin-arm64` explicitly creates a preview without certificate signing; the signed local installer refuses it. CI desktop releases remain unsigned and not notarised. Development signing does not confer Developer ID distribution trust. A future notarised release requires Apple Developer Program membership, a Developer ID Application identity, protected CI signing/notary credentials, a temporary signing keychain with cleanup, and verification that signed releases cannot fall back to unsigned output. Do not upload a personal development private key just to make preview CI green.

For the equivalent signed CLI task and dedicated Node runtime, see [Signed local installation](standalone-cli.md#signed-local-installation).

## Update notifications

AgentLink checks public GitHub release metadata at most once a day in packaged builds. A quiet **Update available** indicator appears only for a newer release with published compatibility metadata for the running host. Checks never download or install anything. Choose **Install update** to download and SHA-256-verify the compatible release, then install it. AgentLink never silently restarts or reloads; that requires a separate confirmation.

- **VS Code:** use **AgentLink: Check for Updates** for details, then **Install update**, or run **AgentLink: Install Update** directly. A verified VSIX is installed through VS Code. Choose **Reload Window** when convenient, or **Later** and return to **Reload to finish** (also **AgentLink: Reload for Update**). Reloading interrupts running agent sessions in that window. Other windows need their own reload. Self-update currently supports local extension hosts only; remote hosts retain manual VSIX installation. Turn off automatic checks with the user-level `agentlink.updates.automaticChecks` setting. Version and target always belong to the extension host, not the browser or workspace manifest.
- **Desktop:** the title bar shows **Desktop update** only when a newer release is available. Use **More → Check for updates…**, **Check for Updates…** in the app menu, or **Settings…**, then **Install update**. The verified app is staged beside the installed one. Choose **Restart Now** to apply it, or **Later** to keep using the current version; return to **Restart to update** when ready. Restart interrupts Desktop sessions, not the separate VS Code gateway. Self-update refuses source builds, apps running from a DMG or App Translocation, and unwritable installation directories. Move the app to Applications first, or use manual installation. A locally signed build (`npm run desktop:install`) can update to the release after a warning that it replaces the local signature: macOS asks for Keychain access again and signature-bound permissions may need re-granting. Run `npm run desktop:install` again to return to a local build. Previews remain unsigned and not notarised and may prompt again for Keychain access.
- **CLI:** run `agentlink updates --install` without a project or provider login, or choose **Install update** from `/updates`. This updates the preview launcher for the next invocation; running sessions keep their current bundle. Source, locally signed, and unknown installation layouts must be updated manually. See [CLI update notifications](standalone-cli.md#update-notifications) for controls and limits.
- **Browser:** details and manual checks follow the selected VS Code host or the effective Desktop owner of Ask Agent. No update controls are shown for older hosts that do not support them. Browser dismissal is local to that browser; automatic checks are configured on the host. There is no remote install, shell, download, or restart action.

Self-update requires a published `SHA256SUMS` entry and checks GitHub's asset digest when present. These checks protect download integrity, not independent publisher authenticity: both values come from the same GitHub release. Installation failures retain manual release links. Desktop keeps the previous app during replacement, but its two directory renames are not one atomic exchange: power loss between them can require reinstalling the DMG. After a clean rollback or a newer manual install, stale update records are archived with their recovery files so a fresh update can be installed. If a backup remains or the installed app cannot be verified against the running version, self-update stays blocked for manual recovery. Sessions and credentials are not removed.

**Dismiss this version** hides its passive notice, not the result of a manual check. A newer version can notify again. Offline or rate-limited checks retain the last confirmed result and mark it stale. A newer release without metadata is not presented as a compatible update. Development/source runs do not check automatically, and SDK notifications are not supported.

## Start your first session

1. Reload VS Code and open the folder you want to work in.
2. Select the **AgentLink** icon in the Activity Bar, then open **Agent**.
3. Follow the empty-chat setup card:
   - **Continue with ChatGPT/Codex** starts the recommended sign-in path.
   - **Use OpenAI API key** opens secure credential setup for the first-class OpenAI provider.
   - **Configure another provider** opens guided OpenAI-compatible model setup for every other provider.
4. Give the agent a bounded first task, for example:

   > Read this project, explain its main module boundaries, and identify the safest place to add `<feature>`.

5. Review proposed diffs and approve commands when AgentLink asks. Use `/checkpoint` before risky work and `/revert` when you need to undo a workspace change.

A configured credential means AgentLink is ready to try the provider. The first request can still fail because of provider-side connectivity, quota, billing, or a revoked key. Your draft remains available while setup is incomplete.

## Know the boundaries

With a workspace folder open, AgentLink can use editor, terminal, MCP, approval, and codebase tools. Without one, it is deliberately limited to a non-persistent Ask-only chat: no workspace files, shell, editor tools, MCP, checkpoints, or approvals.

The browser remote can supervise sessions, answer questions, and inspect read-only diffs. It has no remote shell or write path.

## Good first workflows

- Ask for an explanation or a safe plan before asking for a change.
- Use **code** mode to implement, **architect** to plan, **debug** to investigate, and **review** for focused review.
- Attach a file or selection from the editor instead of pasting it.
- Use `/model` to switch models and `/mode` to switch workflows without starting over.
- Use `/checkpoint` and `/revert` for reversible experimentation.

## Next steps

- [Capabilities overview](capabilities.md) — what AgentLink can do.
- [Providers and OpenAI-compatible setup](providers.md): connect other providers, including Claude through Meridian using Claude Code authentication.
- [MCP](mcp.md) — connect the services and tools your workflow already uses.
- [Customization](customization.md) — instructions, skills, hooks, plugins, and memory.
- [Troubleshooting](troubleshooting.md) — common setup and runtime problems.
