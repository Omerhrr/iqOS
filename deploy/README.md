# Deploying iqOS to the Netcup VDS (/opt/, Docker, Caddy, iqos.rogan.live)

## 1. Get the code onto the server

```bash
cd /opt
git clone <your-repo-url> iqos
cd iqos
```

## 2. Configure environment

```bash
cp .env.example .env
# edit .env: enable/point at whichever LLM provider you use (ZAI/Anthropic/etc)
```

`docker-compose.yml` reads these same variable names from `.env` automatically
via `${VAR:-default}` interpolation - `docker compose` picks up a `.env` file
in the same directory with no extra flags.

## 3. Join (or create) the shared Caddy network

Find the network your existing Caddy container is on:

```bash
docker inspect <your-caddy-container-name> --format '{{json .NetworkSettings.Networks}}'
```

If it's not already an explicitly-named external network, create one and
attach Caddy to it (or just note the existing network name and put that name
in `docker-compose.yml`'s `caddy:` network block here instead of the
placeholder).

## 4. Build and start

```bash
docker compose up -d --build
docker compose logs -f iqos-kernel   # confirm "kernel listening on :3030"
docker compose logs -f iqos-web      # confirm Next.js boot, no /api/kernel 502 loops
```

## 5. Wire up Caddy

Add the block in `deploy/Caddyfile.snippet` to your existing Caddy
container's Caddyfile, then reload it:

```bash
docker exec <your-caddy-container-name> caddy reload --config /etc/caddy/Caddyfile
```

## 6. Cloudflare DNS

Add an `A` record: `iqos` -> this server's public IP, in the `rogan.live`
zone. Match the proxy status (orange/grey cloud) you use for your other
subdomains on this same box.

## 7. Verify before going live

- Visit `https://iqos.rogan.live` - OS shell should load, market watch/chart
  should populate (confirms the web container is reaching the kernel
  container over the internal Docker network, not localhost).
- Check `/api/kernel` returns `{ok:true,kernel:"running"}` - if it 502s,
  the kernel container isn't up yet or `KERNEL_URL` is wrong.
- **Keep IQ Option credentials in paper/practice mode** on this deployment
  until you've watched it run for a while - same rule as the plan you picked
  earlier (git repo + paper trading first).

## Notes on what changed for Docker

- `KERNEL_URL` env var (defaults to `http://127.0.0.1:3030` if unset) now
  controls every place the web app talks to the kernel: the agent/copilot
  tool loop, the `/api/kernel` health check, and the `next.config.ts`
  `XTransformPort` rewrite. In compose it's set to
  `http://iqos-kernel:47312` (Docker's internal DNS resolves service names).
- All three containers listen on deliberately unusual internal ports rather
  than the common 3000/8080/8788 defaults, so they won't collide with
  whatever conventions your other `/opt/` projects use on the same host:
  web `47311`, kernel `47312` (`KERNEL_PORT` env var), sidecar `47313`
  (`SIDECAR_PORT` env var). None of these are published to the host or
  internet except through Caddy's reverse proxy to `iqos-web:47311`; change
  them freely in `docker-compose.yml` if `47311-47313` happen to already be
  taken on your box.
- `KERNEL_MANAGED=false` (set in compose) stops `/api/kernel` from trying to
  `spawn()` the kernel as a child process - that only ever made sense when
  both processes ran on the same host/VM. In Docker, the kernel is its own
  container with its own restart policy and healthcheck.
- The kernel container is **not** published to the host or the internet at
  all - only `iqos-web` can reach it, over the internal `iqos-internal`
  network, by service name. Nothing needs the old `Caddyfile`'s `:81`
  `XTransformPort`-to-`localhost:<port>` gateway trick anymore, since that
  was solving same-origin browser access on a single host; here the browser
  never talks to the kernel directly; it goes through the Next.js server,
  which resolves `KERNEL_URL` itself. The repo-root `Caddyfile` is now dead
  for this deployment - don't wire it into the Docker setup.
- Kernel SQLite data (`mini-services/trading-core/data/os.db*`) persists in
  the named volume `iqos-kernel-data`, independent of container
  rebuilds/redeploys.

## LIVE mode (IQ Option) - the `live/` sidecar

`live/iqair_sidecar.py` bridges the kernel to IQ Option via the `iqair`
library. It's optional - only needed if/when you turn on LIVE mode in
Settings - and is included in `docker-compose.yml` as `iqos-sidecar`.

- It now binds `0.0.0.0:8788` inside the container (was hardcoded to
  `127.0.0.1`, which would make it unreachable from any other container -
  overridable via `SIDECAR_HOST`/`SIDECAR_PORT` env vars).
- It's on the internal network only, not published to the host or internet.
- In the OS shell: **Settings -> LIVE mode -> URL**, use
  `http://iqos-sidecar:47313` instead of the old `http://127.0.0.1:8788`
  default (that default is still fine for local/Windows use outside Docker).
- Its `.iq_session` file (persisted broker session, so restarts don't force
  a re-login) lives in the named volume `iqos-sidecar-session`.
- **Stay in PRACTICE mode** on this deployment until you've watched it run
  for a while - same "paper trading first" plan as before. Nothing here
  changes that; LIVE is a manual opt-in per the existing UI toggle.
- If you never plan to use LIVE mode on this box, comment out the
  `iqos-sidecar` service in `docker-compose.yml` entirely.
