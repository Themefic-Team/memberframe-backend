# MemberFrame API. Built by Coolify with the "Dockerfile" build pack.
#
# Two stages: the first installs everything and compiles, the second carries
# only production dependencies, the compiled `dist/`, and the Prisma schema and
# migrations, which `prisma migrate deploy` applies on every start.

FROM node:22-bookworm-slim AS build
WORKDIR /app
# Prisma's engines link against OpenSSL, which the slim image leaves out.
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY prisma ./prisma
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
# Regenerate the client after pruning so it is certain to survive the prune.
RUN npm run build && npm prune --omit=dev && npx prisma generate

FROM node:22-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=4000

COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/prisma ./prisma
COPY --chown=node:node assets ./assets
RUN mkdir -p storage && chown node:node storage

USER node
EXPOSE 4000

# Polls the process-only endpoint, not /health/db: a database blip should not
# mark the container unhealthy and pull it out of the proxy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Apply pending migrations, then replace the shell with node so it receives
# SIGTERM directly and the graceful shutdown in server.ts runs.
CMD ["sh", "-c", "./node_modules/.bin/prisma migrate deploy && exec node dist/server.js"]
