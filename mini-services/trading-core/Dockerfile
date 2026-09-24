# iqOS trading-core kernel - production image
FROM oven/bun:1
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY . .
# SQLite data lives here - mount a volume onto this path so positions/config
# survive container recreation (see docker-compose.yml).
RUN mkdir -p /app/data
EXPOSE 3030
CMD ["bun", "index.ts"]
