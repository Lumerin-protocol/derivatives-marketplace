# ── Install deps ──────────────────────────────────────────────────────────────
FROM node:22-alpine AS deps

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.28.1 --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

# ── Runtime ───────────────────────────────────────────────────────────────────
FROM node:22-alpine

ENV NODE_ENV=production

WORKDIR /app

COPY --from=deps /app/node_modules node_modules/
COPY package.json tsconfig.json ./
COPY src/ src/

RUN addgroup -S keeper && adduser -S keeper -G keeper
USER keeper

CMD ["node", "src/index.ts"]
