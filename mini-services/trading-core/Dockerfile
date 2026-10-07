# iqOS trading-core kernel - production image
FROM oven/bun:1.3
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY . .
# SQLite data lives here - mount a volume onto this path so positions/config
# survive container recreation (see docker-compose.yml).
RUN mkdir -p /app/data
# Task 58: matches docker-compose KERNEL_PORT default (was a stale 3030)
EXPOSE 47312
CMD ["bun", "index.ts"]
