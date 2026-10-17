# AgentLink assistant server and command worker images.
#
# Build from the repository root after `npm run build:workspaces`:
#   docker build -t agentlink-assistant:local \
#     -f apps/server/deploy/container/Dockerfile apps/server
#   docker build --target command-worker -t agentlink-command-worker:local \
#     -f apps/server/deploy/container/Dockerfile apps/server
#   docker build --target publisher -t agentlink-publisher:local \
#     -f apps/server/deploy/container/Dockerfile apps/server
#   docker build --target backup -t agentlink-backup:local \
#     -f apps/server/deploy/container/Dockerfile apps/server
#   docker build --target editor -t agentlink-editor:local \
#     -f apps/server/deploy/container/Dockerfile apps/server
#   docker build --target browser -t agentlink-browser:local \
#     -f apps/server/deploy/container/Dockerfile apps/server
#
# The context is apps/server; its .dockerignore admits only the bundle.
# Run them with compose.yaml next to this file (see apps/server/README.md).

# Rewrites the bundle's `#!/usr/bin/env node` for the shell-less image,
# which has no `env`: only /nodejs/bin/node.
FROM node:22-bookworm-slim AS bundle
COPY dist/agentlink-server.js /bundle/agentlink-server.js
RUN sed '1s|^#!.*$|#!/nodejs/bin/node|' /bundle/agentlink-server.js \
    > /bundle/agentlink-server \
    && chmod 0755 /bundle/agentlink-server \
    && install -d -m 0700 /bundle/data \
    && install -d -m 0755 /bundle/projects

# Command worker: runs owner-approved commands, plus ripgrep and git for the
# file tools. It has a shell and common tools (curl, wget, jq, python3), npm,
# and pnpm and yarn through Corepack, but none of the assistant's data,
# credentials, or keys. Add the tools your commands need in a derived image.
FROM node:22-bookworm-slim AS command-worker
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
    bash ca-certificates curl git jq python3 ripgrep wget \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable pnpm yarn
# Corepack fetches the version a repository asks for on first use; never
# stop to ask first, since nobody can answer.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
COPY --chmod=0755 dist/agentlink-server.js /usr/local/bin/agentlink-server
RUN install -d -o node -g node -m 0755 /srv/agentlink/projects
ENV NODE_ENV=production
USER node
WORKDIR /srv/agentlink/projects
EXPOSE 7300
ENTRYPOINT ["agentlink-server", "command-worker"]
CMD ["--token-file", "/run/secrets/command-worker-token", "--root", "/srv/agentlink/projects", "--reap-orphans"]

# Publisher: holds the GitHub connections' tokens and pushes task commits
# to agentlink/* branches and opens their draft pull requests. Only git and
# the bundle; it runs no other commands.
FROM node:22-bookworm-slim AS publisher
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*
COPY --chmod=0755 dist/agentlink-server.js /usr/local/bin/agentlink-server
RUN install -d -o node -g node -m 0700 /var/lib/agentlink-publisher
ENV NODE_ENV=production
USER node
WORKDIR /var/lib/agentlink-publisher
EXPOSE 7400
ENTRYPOINT ["agentlink-server", "publisher"]

# Backup: reads the deploy directory (mounted read-only) and sends it to an
# append-only restic store. Only restic and the bundle. It runs as root with
# every capability dropped but file access and keeping file owners (see
# compose.backup.yaml), so a restore gives each file back its owner.
# The same image restores: `docker run ... agentlink-backup:local restore`.
FROM node:22-bookworm-slim AS backup
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates restic \
    && rm -rf /var/lib/apt/lists/*
COPY --chmod=0755 dist/agentlink-server.js /usr/local/bin/agentlink-server
RUN install -d -m 0700 /var/lib/agentlink-backup
ENV NODE_ENV=production
WORKDIR /var/lib/agentlink-backup
EXPOSE 7800
ENTRYPOINT ["agentlink-server"]
CMD ["backup-agent", "--help"]

# Editor: code-server for a task's folder (Open editor / Take over, with
# compose.editor.yaml). The runner manager starts it with only that folder
# mounted, no credentials, a read-only root filesystem and the editors'
# internal network; extensions come from Open VSX through the egress
# gateway. Pinned: bump the version deliberately.
#
# AgentLink comes built in: dist/agentlink-editor.vsix, the extension built
# from the same commit for Linux on this machine's architecture (upgrade.sh
# packages it). Its model calls go to the assistant with the editor's own
# token, from settings the start script writes when the editor starts.
FROM node:22-bookworm-slim AS editor-extension
RUN apt-get update \
    && apt-get install -y --no-install-recommends unzip \
    && rm -rf /var/lib/apt/lists/*
COPY dist/agentlink-editor.vsix /tmp/agentlink.vsix
RUN unzip -q /tmp/agentlink.vsix 'extension/*' -d /tmp/vsix \
    && mv /tmp/vsix/extension /agentlink

FROM codercom/code-server:4.141.0 AS editor
USER root
# Nothing in an editor needs to become root.
RUN SUDO_FORCE_REMOVE=yes apt-get purge -y sudo \
    && rm -rf /var/lib/apt/lists/*
# Built in: always there, and not removable from the editor.
COPY --from=editor-extension /agentlink /usr/lib/code-server/lib/vscode/extensions/agentlink.agentlink
# The start script: the settings the runner manager passes (AgentLink's
# connection, with the editor's model token) become the editor's
# settings; the variable is not passed on to code-server.
RUN printf '%s\n' '#!/bin/sh' 'set -eu' \
    'data=/tmp/code-server/data' \
    'mkdir -p "$data/User" "$data/Machine" "${HOME:-/tmp/home}"' \
    'if [ -n "${AGENTLINK_EDITOR_SETTINGS:-}" ]; then' \
    '  printf "%s" "$AGENTLINK_EDITOR_SETTINGS" > "$data/Machine/settings.json"' \
    '  printf "%s" "$AGENTLINK_EDITOR_SETTINGS" > "$data/User/settings.json"' \
    'fi' \
    'unset AGENTLINK_EDITOR_SETTINGS' \
    'exec /usr/bin/code-server "$@"' \
    > /usr/local/bin/agentlink-editor \
    && chmod 0755 /usr/local/bin/agentlink-editor
USER 1000
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/agentlink-editor"]

# Browser: headless Chromium for research (the browse_* tools, with
# compose.browser.yaml). The runner manager starts one per chat with no
# mounts, no credentials, a fresh profile in /tmp, a read-only root
# filesystem and the browsers' internal network, so everything it fetches
# goes through the egress gateway. Playwright's Chromium headless shell,
# pinned: bump the version deliberately.
FROM node:22-bookworm-slim AS browser
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN apt-get update \
    && apt-get install -y --no-install-recommends socat \
    && npx -y playwright@1.64.1 install --with-deps --only-shell chromium \
    && shell="$(find /ms-playwright -type f \( -name headless_shell -o -name chrome-headless-shell \) | head -n 1)" \
    && test -n "$shell" \
    && ln -s "$shell" /usr/local/bin/headless-shell \
    && rm -rf /root/.npm /root/.cache /var/lib/apt/lists/* /tmp/*
# Fixed flags: no sandbox inside the container (it is the sandbox),
# nothing that phones home, and the proxy (from the runner manager) for
# every request, loopback included. Chromium only serves DevTools on
# loopback (whatever address it is given), so socat forwards the
# browsers' network port 9222 to it for the assistant.
RUN printf '%s\n' '#!/bin/sh' 'set -eu' \
    'mkdir -p /tmp/home /tmp/profile' \
    '/usr/local/bin/headless-shell --no-sandbox --disable-dev-shm-usage --disable-gpu --no-first-run --no-default-browser-check --disable-background-networking --disable-component-update --disable-sync --disable-extensions --disable-breakpad --mute-audio --hide-scrollbars --user-data-dir=/tmp/profile --remote-debugging-port=9221 "--proxy-bypass-list=<-loopback>" "$@" about:blank &' \
    'exec socat TCP-LISTEN:9222,fork,reuseaddr TCP:127.0.0.1:9221' \
    > /usr/local/bin/agentlink-browser \
    && chmod 0755 /usr/local/bin/agentlink-browser
USER 1000
EXPOSE 9222
ENTRYPOINT ["/usr/local/bin/agentlink-browser"]

# Update supervisor and one-shot update jobs, separate from the Assistant.
# Only this narrow management service and runner-manager hold the Docker
# socket. One-shot jobs survive replacing the supervisor or app containers.
FROM docker:28-cli AS updater-docker
FROM node:22-bookworm-slim AS updater
RUN apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
COPY --from=updater-docker /usr/local/bin/docker /usr/local/bin/docker
COPY --from=updater-docker /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
COPY --chmod=0755 dist/agentlink-server.js /usr/local/bin/agentlink-server
ENV NODE_ENV=production
USER 0
ENTRYPOINT ["agentlink-server"]
CMD ["updater", "--help"]

# Assistant server (default target): distroless, so there is no shell, no
# package manager, and nothing but Node to run. Commands, ripgrep, and git
# run on the command worker.
FROM gcr.io/distroless/nodejs22-debian12 AS assistant
COPY --from=bundle /bundle/agentlink-server /usr/local/bin/agentlink-server
# Mount points. Compose bind-mounts host directories over them.
COPY --from=bundle --chown=1000:1000 /bundle/data /var/lib/agentlink
COPY --from=bundle --chown=1000:1000 /bundle/projects /srv/agentlink/projects
ENV NODE_ENV=production \
    PATH=/nodejs/bin:/usr/local/bin:/usr/bin:/bin \
    AGENTLINK_SERVER_CONFIG=/etc/agentlink/server.json
# uid 1000 (the `node` user of the worker image). Compose can run both as
# another uid so files in the bind mounts belong to the host user.
USER 1000:1000
WORKDIR /srv/agentlink/projects
EXPOSE 8443
ENTRYPOINT ["agentlink-server"]
