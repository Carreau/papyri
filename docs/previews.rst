Pull-request documentation previews
===================================

A project that adds the papyri GitHub Action gets rendered documentation for
every pull request: contributors and reviewers see the docs the change
produces, not a diff of reStructuredText.

Each preview lives in its own namespace — its own SQLite database, its own
blob directory, its own raw archive — served under::

    https://<viewer>/preview/<owner>/<repo>/<pr>/project/<pkg>/<ver>/

Two consequences follow from that isolation, and they are the whole design:

- A preview **never** writes into the published store. It contributes no
  back-references, no cross-package links, and no search hits, so an
  in-progress branch cannot alter what readers of the published docs see. The
  price: cross-package references inside a preview stay unresolved. Every
  preview page says so in a banner.
- Dropping a preview is deleting a directory and one registry row. There is no
  cascade to unwind, which is what makes "drop it when the PR merges" cheap
  enough to be automatic.

Previews expire on their own (30 days after the last upload) even if the
drop step never runs.

Authentication: trusted publishing
----------------------------------

A pull request from a fork cannot read repository secrets — which is exactly
the flow previews are most useful for — and ``pull_request_target`` is a known
footgun. Papyri therefore follows PyPI's trusted-publisher model.

The workflow asks the GitHub Actions runtime for a short-lived OpenID Connect
token describing itself, and sends *that* as the bearer. The viewer verifies
the signature against GitHub's published keys and reads the workload identity
straight out of the claims:

============================ ==========================================
``repository``               ``numpy/numpy`` — who is uploading
``job_workflow_ref``         which workflow file is actually running
``repository_owner_id``      the owner's stable numeric id
``event_name`` / ``ref``     which pull request the preview belongs to
============================ ==========================================

The preview namespace is derived from those claims alone, so a workflow can
only ever write into the preview of its own pull request. No secret is
configured on the project side.

For a repository to publish, someone who already has upload rights on the
project registers it once, on the viewer's ``/settings`` page, under
*Trusted publishers*. A registration names the project, the repository, the
workflow file, optionally a GitHub Environment the job must declare, and what
the workflow may publish:

``preview``
    Pull-request previews only. The default, and what a project enrolling for
    doc previews wants: it does not let the repository touch published
    documentation.
``release``
    The published store only.
``both``
    Either, with the target decided by the event that minted the token.

Without a matching registration every OIDC upload is refused. Two further
rules are enforced on the claims themselves: the workflow must live in the
repository that is running it (a reusable workflow borrowed from elsewhere is
refused), and the repository's numeric owner id is pinned on first use, so
releasing an account name and having someone else register it does not inherit
the trust.

Adding the Action to a project
------------------------------

Two jobs: one that publishes on every push to a pull request, one that drops
the preview when it closes.

.. code:: yaml

    name: Docs preview

    on:
      pull_request:
      # Dropping runs from the base branch's workflow definition.
      pull_request_target:
        types: [closed]

    permissions:
      contents: read

    jobs:
      preview:
        if: github.event_name == 'pull_request'
        runs-on: ubuntu-latest
        permissions:
          contents: read
          id-token: write        # required: mints the OIDC token
        steps:
          - uses: actions/checkout@v5
            with:
              persist-credentials: false
          - uses: carreau/papyri@main
            with:
              url: https://papyri.example.com/api/bundle
              config: papyri.toml
              install: ".[docs]"

      drop:
        if: github.event_name == 'pull_request_target'
        runs-on: ubuntu-latest
        permissions:
          id-token: write
        steps:
          - uses: carreau/papyri@main
            with:
              mode: drop
              url: https://papyri.example.com/api/bundle

The build cost — imports, doctest execution, figure rendering — lands on the
project's own CI minutes, which is free for public repositories on GitHub. The
service pays only for ingest and serving.

Projects whose documentation build generates pages (IPython's magics and
configuration reference, for instance) pass an ``inject-script``; it runs
between ``gen`` and the upload and edits the bundle directly through
``papyri.bundle_edit`` (see :doc:`injecting`).

Doing it by hand
----------------

``papyri upload --preview`` is the same code path the Action runs::

    papyri upload --preview --url https://papyri.example.com/api/bundle \
        ~/.papyri/data/numpy_2.3.5

The audience the token is minted for comes from the viewer itself
(``GET /api/oidc/audience``); ``--oidc-audience`` overrides it if a deployment
needs something else.

Outside GitHub Actions there is no OIDC token to be had, so name the namespace
explicitly and authenticate with the deployment-wide upload token — the viewer
accepts an explicit ``--preview-id`` from that token only::

    PAPYRI_UPLOAD_TOKEN=… papyri upload --preview-id numpy/numpy#42 \
        ~/.papyri/data/numpy_2.3.5
    PAPYRI_UPLOAD_TOKEN=… papyri drop-preview --preview-id numpy/numpy#42

Server configuration
--------------------

===============================  ==========================================
``PAPYRI_PREVIEW_DIR``           Root of the preview namespaces (default
                                 ``~/.papyri/previews``).
``PAPYRI_OIDC_AUDIENCE``         Audience the ID token must carry. The viewer
                                 publishes it at ``GET /api/oidc/audience``
                                 and the client asks for it, so the two ends
                                 agree without being configured twice. When
                                 unset it falls back to ``PAPYRI_SITE``; a
                                 deployment should set one of them (see
                                 ``viewer/DEPLOY.md``).
===============================  ==========================================
