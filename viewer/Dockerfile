FROM node:22-slim
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.11.0 --activate

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY ingest/package.json ./ingest/
COPY viewer/package.json ./viewer/

RUN pnpm --filter papyri-ingest install --frozen-lockfile
COPY ingest/ ./ingest/
RUN pnpm --filter papyri-ingest build

RUN pnpm install --frozen-lockfile

COPY viewer/ ./viewer/

# PAPYRI_SITE is the canonical external URL (e.g. https://docs.example.com).
# It must be supplied at build time because Astro bakes `site` into the
# bundle for CSRF origin checks. Leave empty for localhost/direct access.
ARG PAPYRI_SITE=""
ENV PAPYRI_SITE=${PAPYRI_SITE}
RUN pnpm --filter papyri-viewer build

ENV HOST=0.0.0.0
ENV PORT=4321
ENV PAPYRI_INGEST_DIR=/data

EXPOSE 4321

CMD ["node", "viewer/dist/server/entry.mjs"]
