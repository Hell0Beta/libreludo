# LibreLudo — the relay server plus the static client build, in one image.
#
#   docker build -t libreludo .
#   (or `docker compose up`, which is the supported path — see docker-compose.yml)
#
# Four stages:
#   deps       — every dependency, from the frozen lockfile
#   build      — `pnpm build`. vite-plugin-checker runs TypeScript as part of this, so a type
#                error fails the image. That is deliberate; do not "fix" it by disabling the
#                checker.
#   prod-deps  — `pnpm install --prod`, i.e. package.json's `dependencies`. pnpm cannot install a
#                subset of them, and this repo's `dependencies` is really "the client's runtime
#                libraries *and* the server's": react, framer-motion, react-router, qrcode.react
#                and friends come along even though the server imports only express, socket.io
#                and zod. They are dead weight in the image (the client's copy is already
#                bundled into build/client) — but trimming them needs a second package.json,
#                which would drift from the real one. Measured cost: a 369 MB image.
#   runtime    — non-root, no build toolchain, no devDependencies.
#
# The server binds 127.0.0.1:PORT *inside the container* (see server/index.js). Nothing is
# published to the host; the only way in is `tailscale serve` terminating HTTPS and proxying to
# the loopback address. Do not add a `ports:` mapping — that would expose the relay publicly.

FROM node:22-alpine AS base
# COREPACK_ENABLE_DOWNLOAD_PROMPT=0: without it, installing the pinned pnpm can block on an
# interactive "continue?" prompt that never gets an answer in a build.
#
# COREPACK_ENABLE_PROJECT_SPEC=0 is load-bearing. This repo declares
# `devEngines.packageManager: { name: pnpm, version: "^11.7.0" }`, which pnpm accepts but which
# corepack 0.34 (the version bundled in node:22-alpine) refuses to parse — every `pnpm` call
# through the shim fails with "Invalid package manager specification in package.json
# (pnpm@^11.7.0); expected a semver version", because corepack wants a concrete version there.
# Turning the project-spec lookup off makes the shim always use the pnpm pinned on the line
# below, which is the version this image is built and tested against anyway. It is a Dockerfile
# concern, not a repo one: do not "fix" it by editing package.json.
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    COREPACK_ENABLE_PROJECT_SPEC=0
RUN corepack enable && corepack install --global pnpm@11.7.0
WORKDIR /app

# --------------------------------------------------------------- deps (with devDependencies)
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

# --------------------------------------------------------------------------------- build
FROM deps AS build
COPY . .
RUN pnpm build

# ------------------------------------------------------------------- prod-only dependencies
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --prod --frozen-lockfile

# ------------------------------------------------------------------------------- runtime
FROM base AS runtime
ENV NODE_ENV=production \
    PORT=3000

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/build/client ./build/client
COPY server ./server
# server/*.js is ESM and relies on this file's `"type": "module"` — remove it and the runtime
# dies on the first `import`.
COPY package.json ./

# node:22-alpine ships an unprivileged `node` user. Nothing below needs to write to the image.
USER node

# Documentation only; with `network_mode: service:tailscale` this port is never published.
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
