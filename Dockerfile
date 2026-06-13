# Multi-stage build: SPA + server into ONE image (ADR-001, ADR-002, NFR-5).
# Node 22 LTS on Debian slim — better-sqlite3 ships glibc prebuilds, so no
# toolchain is needed in the final image.

# ---- build stage ----------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Install with the full workspace manifest first for layer caching.
COPY package.json package-lock.json ./
COPY shared/package.json shared/package.json
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN npm ci

COPY tsconfig.base.json ./
COPY shared/ shared/
COPY server/ server/
COPY web/ web/
RUN npm run build

# ---- production deps ------------------------------------------------------
FROM node:22-bookworm-slim AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/package.json
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN npm ci --omit=dev

# ---- runtime --------------------------------------------------------------
FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    DATABASE_PATH=/data/app.db \
    PORT=8080
WORKDIR /app

COPY --from=prod-deps /app/node_modules node_modules
COPY package.json ./
COPY server/package.json server/package.json
COPY server/migrations server/migrations
COPY --from=build /app/shared/dist shared/dist
COPY shared/package.json shared/package.json
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist

# The operator CLI (E7.S1, FR-35): `docker compose exec app ynab-clone backup`
# and `ynab-clone restore <artifact>` — see the README ops guide.
RUN printf '#!/bin/sh\nexec node /app/server/dist/cli.js "$@"\n' > /usr/local/bin/ynab-clone \
  && chmod +x /usr/local/bin/ynab-clone

# SQLite lives on the named volume (ADR-003); created/migrated at boot (AC-2).
# data/backups/ on the same volume holds the E7.S1 artifacts.
VOLUME /data
EXPOSE 8080

# Boot = bracket(migrate) -> seed -> consistency check -> listen + schedulers
# (server/src/index.ts; NFR-11 upgrade bracket per E7.S3).
CMD ["node", "server/dist/index.js"]
