# AgentLink assistant server and command worker images.
#
# Build from the repository root after `npm run build:workspaces`:
#   docker build -t agentlink-assistant:local \
#     -f apps/server/deploy/container/Dockerfile apps/server
#   docker build --target command-worker -t agentlink-command-worker:local \
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
# file tools. It has a shell and tools but none of the assistant's data,
# credentials, or keys. Add the tools your commands need in a derived image.
FROM node:22-bookworm-slim AS command-worker
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
    bash ca-certificates git ripgrep \
    && rm -rf /var/lib/apt/lists/*
COPY --chmod=0755 dist/agentlink-server.js /usr/local/bin/agentlink-server
RUN install -d -o node -g node -m 0755 /srv/agentlink/projects
ENV NODE_ENV=production
USER node
WORKDIR /srv/agentlink/projects
EXPOSE 7300
ENTRYPOINT ["agentlink-server", "command-worker"]
CMD ["--token-file", "/run/secrets/command-worker-token", "--root", "/srv/agentlink/projects", "--reap-orphans"]

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
