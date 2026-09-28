# iqOS web (Next.js OS shell) - production image
FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM oven/bun:1 AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# next.config.ts's rewrites() (the same-origin ?XTransformPort=<port> proxy
# the browser uses for direct REST calls to the kernel - screener, watchdog,
# autopilot, sentinel, mode, archive, etc, not just the copilot's /api/agent
# path) is evaluated by Next.js AT BUILD TIME, baked into the routes
# manifest - NOT read fresh at container runtime like the other API routes
# are. Setting KERNEL_URL only via docker-compose's runtime `environment:`
# has no effect on this specific destination; it must be present here, as a
# build arg, so `next build` bakes in the real kernel service address.
ARG KERNEL_URL=http://127.0.0.1:3030
ENV KERNEL_URL=$KERNEL_URL
# Prisma client generation is a no-op for the actual trading features (dead
# scaffold from the starter template) but `next build` may still touch it if
# any route imports @prisma/client, so keep it cheap and non-fatal.
RUN bunx prisma generate || true
RUN bun run build

FROM oven/bun:1 AS runner
WORKDIR /app
ENV NODE_ENV=production
# Unusual internal port on purpose - avoids colliding with other /opt/
# projects' 3000/8080/etc conventions on the same Docker host. Override at
# runtime with -e PORT=... if you need something else.
ENV PORT=47311
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
EXPOSE 47311
CMD ["bun", "server.js"]
