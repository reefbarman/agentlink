# AgentLink assistant server image.
#
# Build from the repository root after `npm run build:workspaces`:
#   docker build -t agentlink-assistant:local \
#     -f apps/server/deploy/container/Dockerfile apps/server
#
# The context is apps/server; its .dockerignore admits only the bundle.
# Run it with compose.yaml next to this file (see apps/server/README.md).

FROM node:22-bookworm-slim

# git and ripgrep serve the file tools; ca-certificates the provider APIs.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git ripgrep \
    && rm -rf /var/lib/apt/lists/*

COPY --chmod=0755 dist/agentlink-server.js /usr/local/bin/agentlink-server

# Mount points. Compose bind-mounts host directories over them.
RUN install -d -o node -g node -m 0700 /var/lib/agentlink \
    && install -d -o node -g node -m 0755 /srv/agentlink/projects

ENV NODE_ENV=production \
    AGENTLINK_SERVER_CONFIG=/etc/agentlink/server.json

# The image's `node` user (uid 1000). Compose can run it as another uid so
# files in the bind mounts belong to the host user.
USER node
WORKDIR /srv/agentlink/projects
EXPOSE 8443

ENTRYPOINT ["agentlink-server"]
