# Deploying the viewer (static site)

`pnpm build` produces a fully self-contained static site under
`viewer/dist/client/`. That directory contains nothing but HTML, CSS, JS, and
assets — it can be served from **any static host** (GitHub Pages, Cloudflare
Pages, Netlify, Vercel, Fly.io static volumes, a bare Nginx/Caddy box, an S3
bucket with static website hosting, etc.).

> **Note on SSR.** `astro.config.mjs` now attaches `@astrojs/node` so
> individual routes can opt into server rendering
> (`export const prerender = false`). `pnpm build` therefore produces two
> output trees: `dist/client/` (static HTML + assets) and `dist/server/` (a
> standalone Node entry). The static-host deploys below upload
> `dist/client/` only — the SSR endpoints under `/api/*` are not
> reachable from those deploys and are exercised via `pnpm serve`
> locally. Once we commit to a hosting platform, `@astrojs/node` is
> swapped for the matching adapter (`@astrojs/cloudflare`,
> `@astrojs/netlify`, `@astrojs/vercel`, etc.).

## Architecture

```
  GitHub Actions
  ├─ papyri gen examples/papyri.toml          → ~/.papyri/data/<pkg>_<ver>/
  ├─ papyri ingest ~/.papyri/data/...         → ~/.papyri/ingest/papyri.db
  ├─ pnpm build (Astro SSG + unused SSR)      → viewer/dist/{client,server}/
  └─ upload viewer/dist/client                → static host
```

At build time Astro walks the graph DB and the ingest tree, pre-renders
every qualname page, inlines KaTeX math, highlights code with Shiki,
and emits one `index.html` per URL. The static host then serves those
files from cache — no origin, no cold starts, no per-request DB access.

## Storage model

| Artifact                                 | Where it lives at build time    | Where it lives at runtime               |
| ---------------------------------------- | ------------------------------- | --------------------------------------- |
| Per-bundle IR (JSON + CBOR blobs)        | `~/.papyri/data/<pkg>_<ver>/`   | Consumed at build; not shipped          |
| Ingest store (decoded CBOR per qualname) | `~/.papyri/ingest/<pkg>/<ver>/` | Consumed at build; not shipped          |
| Graph DB (`papyri.db`, SQLite)           | `~/.papyri/ingest/papyri.db`    | Consumed at build; not shipped          |
| Rendered HTML + assets                   | `viewer/dist/client/`           | Static host edge (immutable per deploy) |
| Example assets (plots, captured HTML)    | `viewer/dist/client/assets/...` | Static host edge                        |
| SSR server bundle                        | `viewer/dist/server/`           | **Not uploaded.** Built for local use.  |

All papyri-side state is a **build input**, not a runtime dependency.

## Scaling the content set

The proposed workflow ships papyri's own docs by running `papyri gen
examples/papyri.toml` and ingesting the result. To publish additional
libraries, either:

- add more TOMLs to the `Generate + ingest bundles` step, or
- generate bundles in a separate job, upload them as artifacts, and
  download + ingest them from the deploy job.

Watch asset counts and build time as the content set grows. Most static
hosts impose per-file or total-size limits; papyri emits one HTML per
qualname plus assets, which adds up fast for large libraries. If limits
are hit, options include pruning to module-level pages with client-side
qualname rendering, or moving to an SSR-on-serverless path.

## If we ever outgrow SSG

`viewer/PLAN.md` already flags the `ir-reader` / `graph` modules as the
designated shock absorbers. The SSR migration path depends on the chosen host:

- **Cloudflare Workers**: in progress as **M9** in
  [`PLAN.md`](PLAN.md). The single populator of D1 + R2 is the
  Workers-side `PUT /api/bundle` handler (M9.3) — there is no parallel
  seeder, and the soon-to-be-removed `papyri ingest` tree is not an
  input. M9.0 (bindings + D1 schema migration) and M9.1 (CF adapter +
  worker entrypoint) have landed: `pnpm build:cf && pnpm wrangler:dev`
  boots a worker against an empty D1+R2 with both bindings wired
  (`/api/health.json` confirms). Storage-touching routes still 500
  under `wrangler dev` until the async storage layer (M9.2) and the
  Workers bundle PUT (M9.3) ship.
- **Netlify / Vercel Edge Functions**: similar pattern — managed Postgres or
  Turso instead of D1, object storage instead of R2, matching Astro adapter.
- **Node server (Fly.io, Railway, VPS)**: keep `better-sqlite3` and the SQLite
  file; swap `@astrojs/node` from `mode: "middleware"` to `mode: "standalone"`;
  serve with a reverse proxy. Simplest migration, no vendor lock-in.

The choice should be driven by concrete cost / latency / ops data once we have
a real content set — no commitment needed today.

## Proposed GitHub Pages workflow

A minimal deployment that uses the built-in `github-pages` action — no
third-party tokens needed. Save as
`.github/workflows/pages.yml` when ready to turn on.

```yaml
name: Deploy viewer to GitHub Pages

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: true

jobs:
  build-and-deploy:
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deploy.outputs.page_url }}
    steps:
      - uses: actions/checkout@v4

      - name: Set up Python 3.14
        uses: actions/setup-python@v5
        with:
          python-version: "3.14"
          cache: pip

      - name: Install papyri
        run: |
          python -m pip install --upgrade pip
          pip install -e .

      - name: Generate + ingest bundles
        run: |
          papyri gen examples/papyri.toml --no-infer
          for d in ~/.papyri/data/*/; do
            papyri ingest "$d"
          done

      - uses: pnpm/action-setup@v4
        with:
          version: 10

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
          cache-dependency-path: viewer/pnpm-lock.yaml

      - name: Install viewer deps
        working-directory: viewer
        run: pnpm install --frozen-lockfile

      - name: Build static site
        working-directory: viewer
        run: pnpm build

      - name: Upload Pages artifact
        uses: actions/upload-pages-artifact@v3
        with:
          path: viewer/dist/client

      - name: Deploy to GitHub Pages
        id: deploy
        uses: actions/deploy-pages@v4
```

Enable _Settings → Pages → Source → GitHub Actions_ in the repo before
the first run.

## Alternative: Cloudflare Pages

If Cloudflare Pages is preferred (global edge CDN, preview deploys per PR),
save as `.github/workflows/cloudflare-pages.yml`.

### One-time Cloudflare setup

1. In the Cloudflare dashboard, create a Pages project. Pick
   **"Direct Upload"** (not the Git integration — we drive deploys from
   GitHub Actions). Name it something stable, e.g. `papyri-viewer`.
2. Create an API token with the `Pages:Edit` permission scoped to the
   account. Copy the token.
3. Note the **Account ID** from the dashboard sidebar.

### GitHub secrets

Add three repo-level secrets under _Settings → Secrets and variables →
Actions_:

| Secret                     | Value                                   |
| -------------------------- | --------------------------------------- |
| `CLOUDFLARE_API_TOKEN`     | The Pages:Edit token from step 2        |
| `CLOUDFLARE_ACCOUNT_ID`    | Your Cloudflare account ID              |
| `CLOUDFLARE_PAGES_PROJECT` | The project name (e.g. `papyri-viewer`) |

### Workflow YAML

```yaml
name: Deploy viewer to Cloudflare Pages

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  pull-requests: write
  deployments: write

concurrency:
  group: cloudflare-pages-${{ github.ref }}
  cancel-in-progress: true

jobs:
  deploy:
    runs-on: ubuntu-latest
    if: github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository
    steps:
      - uses: actions/checkout@v4

      - name: Set up Python 3.14
        uses: actions/setup-python@v5
        with:
          python-version: "3.14"
          cache: pip

      - name: Install papyri
        run: |
          python -m pip install --upgrade pip
          pip install -e .

      - name: Generate + ingest bundles
        run: |
          papyri gen examples/papyri.toml --no-infer
          for d in ~/.papyri/data/*/; do
            papyri ingest "$d"
          done

      - uses: pnpm/action-setup@v4
        with:
          version: 10

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
          cache-dependency-path: viewer/pnpm-lock.yaml

      - name: Install viewer deps
        working-directory: viewer
        run: pnpm install --frozen-lockfile

      - name: Build static site
        working-directory: viewer
        run: pnpm build

      - name: Deploy to Cloudflare Pages
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          command: >-
            pages deploy viewer/dist/client
            --project-name=${{ secrets.CLOUDFLARE_PAGES_PROJECT }}
            --branch=${{ github.head_ref || github.ref_name }}
```
