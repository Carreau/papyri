# Deploying the viewer

The viewer runs as a long-running **Node.js process** under
`@astrojs/node` (`output: "server"`). `pnpm build` emits a standalone
server at `viewer/dist/server/entry.mjs` plus prerendered static assets
under `viewer/dist/client/`. Deploy target: a VPS (or any host that can
run a Node process behind a reverse proxy).

```sh
cd viewer
pnpm install --frozen-lockfile
pnpm build
node ./dist/server/entry.mjs   # or: pnpm serve
```

The server listens on port `4321` by default. Put a reverse proxy
(Nginx / Caddy) in front of it for TLS and host routing, and set
`PAPYRI_SITE` to the external origin (see below).

> **Static-only deploys.** `dist/client/` is a self-contained static
> tree (HTML, CSS, JS, assets) and can be served from any static host.
> The `prerender = false` routes under `/api/*` are not reachable from a
> static-only deploy — they require the Node server. The viewer is built
> for the long-running Node process; static export is a degraded mode.

## Authentication

`PUT /api/bundle` is the **only endpoint that mutates state** (the graph
DB and blob store). All other routes are read-only. A simple
bearer-token guard protects it; the check is opt-in so local development
needs no configuration.

### How it works

The viewer reads `PAPYRI_UPLOAD_TOKEN` from the environment at request
time.

- **Token present**: every `PUT /api/bundle` must carry
  `Authorization: Bearer <token>`. Any other value — or a missing header —
  gets a `401 Unauthorized` response.
- **Token absent**: the check is skipped entirely. No auth is required.
  This is the safe default for local `pnpm dev` / `pnpm serve` sessions.

On the server, set the variable before starting the process (e.g. via
the service manager's environment file, a `systemd` unit, or the shell):

```sh
export PAPYRI_UPLOAD_TOKEN=your-secret-here
pnpm serve
```

### Configuring `papyri upload`

Pass the same token to the client via environment variable or flag:

```sh
# Recommended: set once in the shell / CI secret store.
export PAPYRI_UPLOAD_TOKEN=your-secret-here
export PAPYRI_UPLOAD_URL=https://docs.example.com/api/bundle

papyri upload ~/.papyri/data/numpy_2.3.5/

# Or pass inline (takes precedence over env var):
papyri upload --token your-secret-here \
              --url https://docs.example.com/api/bundle \
              ~/.papyri/data/numpy_2.3.5/
```

In CI, store the token as a repository secret and inject it as
`PAPYRI_UPLOAD_TOKEN` in the workflow environment.

## Storage model

The viewer's state lives on the server's local filesystem and a SQLite
database, both under `~/.papyri/ingest/` (override with
`PAPYRI_INGEST_DIR` / `PAPYRI_INGEST_DB`):

| Artifact                               | Where it lives                       |
| -------------------------------------- | ------------------------------------ |
| Per-bundle IR (decoded CBOR blobs)     | `<PAPYRI_INGEST_DIR>/<pkg>/<ver>/`   |
| Raw bundle archive (`.papyri.gz`)      | `<PAPYRI_INGEST_DIR>/_raw/<pkg>/`    |
| Graph DB (`papyri.db`, SQLite)         | `<PAPYRI_INGEST_DIR>/papyri.db`      |
| Rendered HTML + static assets          | `viewer/dist/client/`                |

The raw `.papyri.gz` archive is the only authoritative IR; everything in
the blob store and graph DB is a derived cache, rebuildable from the raw
archive via `POST /api/reingest`.

## Origin / reverse-proxy configuration

When the viewer sits behind a reverse proxy whose external hostname
differs from the container's internal host, set `PAPYRI_SITE` to the
canonical external origin (e.g. `https://docs.example.com`). Astro uses
it for canonical URL generation. (CSRF origin checks are disabled —
mutating endpoints carry their own bearer-token / session-cookie checks;
see `astro.config.mjs`.)

## Splitting admin and docs onto two hostnames

The viewer has two "surfaces":

- **Docs** — read-only: bundle index (`/`), per-bundle pages
  (`/project/<pkg>/<ver>/...`), the public JSON APIs
  (`/api/bundles.json`, `/api/search.json`, `/api/text-search.json`,
  `/api/health.json`, `/api/<pkg>/<ver>/...`).
- **Admin** — mutating + authenticated: `/admin`, `/login`, `/nodes`,
  `/ir-stats`, all `/api/auth/*`, `/api/bundle` (upload),
  `/api/reingest`, `/api/clear`, `/api/clear-raw`, `/api/inventory`,
  `/api/stats`, `/api/nodes.json`, `/api/ir-stats.json`.

Setting **either** `PAPYRI_DOCS_HOST` or `PAPYRI_ADMIN_HOST` turns on
host-based gating in `src/middleware.ts`: admin routes return `404` on
the docs host and vice versa, so the admin URL is not discoverable from
the public bundle pages. With both vars unset every host serves
everything (the pre-split single-host dev flow).

**Why bother.** A docstring inside a published bundle can carry
arbitrary HTML, which we render on the docs surface. Putting admin on a
different hostname keeps the admin session cookie out of the docs
origin's cookie store, so an XSS payload in a bundle cannot steal it or
fire authenticated requests against `/api/clear`, `/api/reingest`, etc.
Middleware also sets a strict-ish CSP (`default-src 'self'`,
`connect-src 'self'`, `frame-ancestors 'none'`, `form-action 'self'`,
`object-src 'none'`) and `X-Frame-Options: DENY` as belt-and-braces.

### Local dev recipe A — two ports, two processes

Easiest for everyday work. Run two `node` processes on adjacent ports,
both reading the same `~/.papyri/ingest/`. Each process holds the same
env vars; the request's `Host` header (which on `curl` / a browser
carries the port) decides which surface it serves.

```sh
cd viewer
pnpm install --frozen-lockfile
pnpm build

# Terminal 1 — docs surface on :4321
PAPYRI_DOCS_HOST=localhost:4321 \
PAPYRI_ADMIN_HOST=localhost:4322 \
PORT=4321 node ./dist/server/entry.mjs

# Terminal 2 — admin surface on :4322
PAPYRI_DOCS_HOST=localhost:4321 \
PAPYRI_ADMIN_HOST=localhost:4322 \
PORT=4322 node ./dist/server/entry.mjs
```

`pnpm dev` works the same way — pass `--port` to each invocation.
SQLite supports multiple readers plus one writer in WAL mode, so both
processes sharing `~/.papyri/ingest/papyri.db` is fine on one machine.

Then:

- Browse docs at <http://localhost:4321/>.
- Log in at <http://localhost:4322/login> (`admin` / `password` by
  default — override with `PAPYRI_USERNAME` / `PAPYRI_PASSWORD`).
- Upload bundles:
  ```sh
  PAPYRI_UPLOAD_URL=http://localhost:4322/api/bundle \
  papyri upload ~/.papyri/data/<pkg>_<ver>/
  ```

Sanity checks:

```sh
curl -i http://localhost:4321/admin         # → 404 (admin hidden on docs)
curl -i http://localhost:4321/api/bundle    # → 404 (no upload on docs)
curl -i http://localhost:4322/              # → 404 (no bundle list on admin)
curl -i http://localhost:4322/admin         # → 302 to /login (needs session)
```

### Local dev recipe B — one process, two hostnames via `/etc/hosts`

Useful when you want to test with real hostnames (e.g. before wiring up
a reverse proxy). Add to `/etc/hosts`:

```
127.0.0.1 docs.local admin.local
```

Then a single process can demux by `Host`:

```sh
PAPYRI_DOCS_HOST=docs.local:4321 \
PAPYRI_ADMIN_HOST=admin.local:4321 \
node ./dist/server/entry.mjs

# In another terminal:
curl -i http://docs.local:4321/                # → 200 (bundle list)
curl -i http://docs.local:4321/admin           # → 404
curl -i http://admin.local:4321/admin          # → 302 → /login
```

Browsers do the right thing too — visit `http://docs.local:4321/` and
`http://admin.local:4321/login` directly. Note that the session cookie
is host-only: logging in on `admin.local` does **not** put a cookie on
`docs.local` (you can verify in DevTools → Application → Cookies).

### Local dev recipe C — one process behind a reverse proxy

Closest to prod. Run **one** Node process on `localhost:4321` and have
Caddy / Nginx route both hostnames to it. The proxy must forward the
original `Host` (or set `X-Forwarded-Host`) so middleware sees the
external hostname.

Caddyfile:

```caddy
docs.local:443, admin.local:443 {
    tls internal
    reverse_proxy localhost:4321 {
        header_up Host {host}
    }
}
```

Nginx:

```nginx
server {
    listen 443 ssl;
    server_name docs.local admin.local;
    # ... ssl_certificate / ssl_certificate_key ...
    location / {
        proxy_pass http://127.0.0.1:4321;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Then the Node process needs the env vars set to the **external**
hostnames (no port suffix when standard 80/443):

```sh
PAPYRI_SITE=https://docs.local \
PAPYRI_DOCS_HOST=docs.local \
PAPYRI_ADMIN_HOST=admin.local \
PAPYRI_USERNAME=admin PAPYRI_PASSWORD=hunter2 \
PAPYRI_UPLOAD_TOKEN=$(cat /etc/papyri/upload-token) \
node ./dist/server/entry.mjs
```

`X-Forwarded-Proto: https` lets the login endpoint set the cookie's
`Secure` flag — required so the browser only sends it back over TLS.
Without it the session cookie is set without `Secure` (correct for
plain-HTTP local dev, wrong for prod).

### Production deployment

Same as recipe C, with two changes:

- `PAPYRI_SITE` is the public docs URL (e.g. `https://docs.example.com`);
  `PAPYRI_DOCS_HOST` / `PAPYRI_ADMIN_HOST` are the bare hostnames.
- `PAPYRI_UPLOAD_TOKEN` is set, so `PUT /api/bundle` (admin host only)
  requires `Authorization: Bearer …`.

Point `papyri upload` at the admin host:

```sh
export PAPYRI_UPLOAD_URL=https://admin.example.com/api/bundle
export PAPYRI_UPLOAD_TOKEN=<token>
papyri upload ~/.papyri/data/<pkg>_<ver>/
```

## Populating content

```sh
papyri gen examples/papyri.toml --no-infer      # → ~/.papyri/data/<pkg>_<ver>/
papyri upload ~/.papyri/data/<pkg>_<ver>/        # → PUT /api/bundle, ingested server-side
```

`PUT /api/bundle` runs the full TypeScript ingest pipeline in-process and
updates the cross-link graph, so cross-refs and back-refs work
immediately without restarting the server. To re-derive the store from
the raw archives (e.g. after an IR change), call `POST /api/reingest`.
