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

## Populating content

```sh
papyri gen examples/papyri.toml --no-infer      # → ~/.papyri/data/<pkg>_<ver>/
papyri upload ~/.papyri/data/<pkg>_<ver>/        # → PUT /api/bundle, ingested server-side
```

`PUT /api/bundle` runs the full TypeScript ingest pipeline in-process and
updates the cross-link graph, so cross-refs and back-refs work
immediately without restarting the server. To re-derive the store from
the raw archives (e.g. after an IR change), call `POST /api/reingest`.
