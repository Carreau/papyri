# Deploying the viewer to Cloudflare Pages

The viewer is a pure static site (`astro build` → `viewer/dist/`), so it
deploys to Cloudflare Pages with no runtime adapter, no Workers, and no
database at request time. This document sketches the intended GitHub
Actions setup; the workflow is **not yet committed** — once we're ready
to turn it on, drop the YAML below into
`.github/workflows/cloudflare-pages.yml`.

## Architecture

```
  GitHub Actions
  ├─ papyri gen examples/papyri.toml   → ~/.papyri/data/<pkg>_<ver>/
  ├─ papyri ingest ~/.papyri/data/...  → ~/.papyri/ingest/papyri.db
  ├─ pnpm build (Astro SSG)            → viewer/dist/
  └─ wrangler pages deploy viewer/dist → Cloudflare Pages
```

At build time Astro walks the graph DB and the ingest tree, pre-renders
every qualname page, inlines KaTeX math, highlights code with Shiki,
and emits one `index.html` per URL. Cloudflare Pages then serves those
files straight from its global edge cache — no origin, no cold starts,
no per-request DB access.

## Storage model

| Artifact                               | Where it lives at build time   | Where it lives at runtime                         |
| -------------------------------------- | ------------------------------ | ------------------------------------------------- |
| Per-bundle IR (JSON + CBOR blobs)      | `~/.papyri/data/<pkg>_<ver>/`  | Consumed at build; not shipped                    |
| Ingest store (decoded CBOR per qualname) | `~/.papyri/ingest/<pkg>/<ver>/` | Consumed at build; not shipped                    |
| Graph DB (`papyri.db`, SQLite)         | `~/.papyri/ingest/papyri.db`   | Consumed at build; not shipped                    |
| Rendered HTML + assets                 | `viewer/dist/`                 | Cloudflare Pages edge (global, immutable per deploy) |
| Example assets (plots, captured HTML)  | `viewer/dist/assets/...`       | Cloudflare Pages edge                             |

In other words: all papyri-side state is a **build input**, not a
runtime dependency. The Pages deploy contains nothing but pre-rendered
HTML and static assets.

## One-time Cloudflare setup

1. In the Cloudflare dashboard, create a Pages project. Pick
   **"Direct Upload"** (not the Git integration — we drive deploys
   from GitHub Actions so we can run papyri first). Name it something
   stable, e.g. `papyri-viewer`.
2. Create an API token with the `Pages:Edit` permission scoped to the
   account that owns the project. Copy the token.
3. Note the Cloudflare **Account ID** from the dashboard sidebar.

## GitHub secrets

Add three repo-level secrets under *Settings → Secrets and variables →
Actions*:

| Secret                      | Value                                  |
| --------------------------- | -------------------------------------- |
| `CLOUDFLARE_API_TOKEN`      | The Pages:Edit token from step 2 above |
| `CLOUDFLARE_ACCOUNT_ID`     | Your Cloudflare account ID             |
| `CLOUDFLARE_PAGES_PROJECT`  | The project name (e.g. `papyri-viewer`) |

With those three set, the workflow below will run on every push to
`main` (production deploy) and on every pull request against `main`
(preview deploy on a branch subdomain).

## Scaling the content set

The proposed workflow ships papyri's own docs by running `papyri gen
examples/papyri.toml` and ingesting the result. To publish additional
libraries, either:

- add more TOMLs to the `Generate + ingest bundles` step, or
- generate bundles in a separate job (mirroring
  `python-package.yml`'s matrix), upload them as artifacts, and
  download + ingest them from the deploy job.

Watch the Pages project's asset count and build time as the set grows.
Cloudflare Pages allows up to 20,000 files per deploy and a 25 MiB
per-file limit as of writing; papyri emits one HTML per qualname plus
assets, which adds up fast across large libraries. If we hit either
limit the next step is to either prune to module-level pages with
client-side rendering of qualnames, or move to the SSR-on-Workers
path (see below).

## If we ever outgrow SSG

`viewer/PLAN.md` already flags the `ir-reader` / `graph` modules as the
designated shock absorbers. To switch to edge rendering:

- Replace `better-sqlite3` with the Cloudflare **D1** binding behind
  `src/lib/graph.ts`. Papyri's SQLite schema (`papyri/graphstore.py`)
  is pure SQL and should port with minor tweaks.
- Push the ingest store's CBOR blobs to **Cloudflare R2** (keyed by
  `<pkg>/<ver>/module/<qualname>`), and have the Worker fetch + decode
  them with `cbor-x` on demand. `cbor-x` runs unmodified in Workers.
- Swap the Astro build output to `@astrojs/cloudflare` so pages run as
  Worker routes.

None of this is needed today — flagged only so future-us knows the
ramp is clean.

## Proposed workflow YAML

Save as `.github/workflows/cloudflare-pages.yml` when you're ready to
turn the automated deploy on.

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
            pages deploy viewer/dist
            --project-name=${{ secrets.CLOUDFLARE_PAGES_PROJECT }}
            --branch=${{ github.head_ref || github.ref_name }}
```
