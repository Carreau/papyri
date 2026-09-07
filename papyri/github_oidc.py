"""GitHub Actions OIDC (trusted publishing) support for ``papyri upload``.

A pull request from a fork cannot read repository secrets, so a bearer token
never reaches the workflow that would publish a doc preview — the single most
common contribution flow. GitHub's answer is a short-lived, workload-bound ID
token: a workflow granted ``permissions: id-token: write`` asks the Actions
runtime for a JWT describing itself (repository, workflow, event, ref), and
sends *that* as the bearer.

The viewer verifies the signature against GitHub's public keys and derives the
preview namespace from the claims, so nothing sensitive travels and nothing the
client says can widen what the token may write. See ``viewer/src/lib/github-oidc.ts``.
"""

from __future__ import annotations

import json
import os
import urllib.parse
import urllib.request
from importlib.metadata import PackageNotFoundError, version

#: Bound on the two small HTTP calls involved (audience discovery and the
#: token request). Both are quick metadata lookups; a finite bound stops a
#: hung endpoint from stalling a CI job indefinitely.
_TOKEN_TIMEOUT_S = 30

try:
    _PAPYRI_VERSION = version("papyri")
except PackageNotFoundError:
    _PAPYRI_VERSION = "0+unknown"


class OidcUnavailable(RuntimeError):
    """Raised when no GitHub Actions ID token can be obtained."""


def running_in_github_actions() -> bool:
    """True when the process looks like a GitHub Actions job."""
    return os.environ.get("GITHUB_ACTIONS") == "true"


def id_token_available() -> bool:
    """True when the workflow was granted ``id-token: write``."""
    return bool(
        os.environ.get("ACTIONS_ID_TOKEN_REQUEST_URL")
        and os.environ.get("ACTIONS_ID_TOKEN_REQUEST_TOKEN")
    )


def resolve_audience(upload_url: str, override: str | None = None) -> str:
    """Audience the viewer at ``upload_url`` expects in an ID token.

    An ID token is bound to an audience, and the viewer only accepts tokens
    carrying its own — that binding is what stops a token minted for another
    service being replayed at papyri. Resolution order: an explicit override
    (``--oidc-audience``), ``$PAPYRI_OIDC_AUDIENCE``, the value the viewer
    publishes at ``/api/oidc/audience``, and finally the upload origin, which
    is also that endpoint's own default when the deployment sets nothing.
    """
    if override:
        return override
    env = os.environ.get("PAPYRI_OIDC_AUDIENCE")
    if env:
        return env

    parsed = urllib.parse.urlsplit(upload_url)
    origin = f"{parsed.scheme}://{parsed.netloc}"
    req = urllib.request.Request(
        f"{origin}/api/oidc/audience",
        method="GET",
        headers={
            "Accept": "application/json",
            "User-Agent": f"papyri-upload/{_PAPYRI_VERSION}",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=_TOKEN_TIMEOUT_S) as resp:
            audience = json.loads(resp.read()).get("audience")
        if isinstance(audience, str) and audience:
            return audience
    except Exception:
        # An older viewer, or one behind a proxy that hides the route: fall
        # back to the origin rather than failing the upload here.
        pass
    return origin


def request_id_token(audience: str) -> str:
    """Ask the Actions runtime for an ID token bound to ``audience``.

    Only works inside a GitHub Actions job that declares
    ``permissions: id-token: write`` — that is what makes GitHub inject
    ``ACTIONS_ID_TOKEN_REQUEST_URL`` / ``ACTIONS_ID_TOKEN_REQUEST_TOKEN`` into
    the environment. Raises ``OidcUnavailable`` when they are absent or the
    request fails.
    """
    request_url = os.environ.get("ACTIONS_ID_TOKEN_REQUEST_URL")
    request_token = os.environ.get("ACTIONS_ID_TOKEN_REQUEST_TOKEN")
    if not request_url or not request_token:
        raise OidcUnavailable(
            "no GitHub Actions ID token available: this must run in a GitHub "
            "Actions job whose permissions include `id-token: write`"
        )

    # safe="" so a URL-shaped audience (the usual case) is fully encoded — its
    # slashes and colon must not read as query structure.
    separator = "&" if urllib.parse.urlsplit(request_url).query else "?"
    token_url = (
        f"{request_url}{separator}audience={urllib.parse.quote(audience, safe='')}"
    )
    req = urllib.request.Request(
        token_url,
        method="GET",
        headers={
            "Authorization": f"Bearer {request_token}",
            "Accept": "application/json; api-version=2.0",
            "User-Agent": f"papyri-upload/{_PAPYRI_VERSION}",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=_TOKEN_TIMEOUT_S) as resp:
            body = json.loads(resp.read())
    except Exception as exc:  # network, HTTP error, malformed JSON
        raise OidcUnavailable(
            f"could not fetch a GitHub Actions ID token: {exc}"
        ) from exc

    value = body.get("value")
    if not isinstance(value, str) or not value:
        raise OidcUnavailable("GitHub Actions ID token response carried no token")
    return value


def preview_id_from_environment() -> str | None:
    """``owner/repo#42`` for the pull request this job is building, if any.

    Read from the standard Actions environment (``GITHUB_REPOSITORY`` and
    ``GITHUB_REF``). Only used for messages and for the non-OIDC fallback path;
    the server derives the authoritative identity from the token's claims.
    """
    repo = os.environ.get("GITHUB_REPOSITORY")
    ref = os.environ.get("GITHUB_REF", "")
    if not repo or not ref.startswith("refs/pull/"):
        return None
    parts = ref.split("/")
    if len(parts) < 4 or not parts[2].isdigit():
        return None
    return f"{repo}#{parts[2]}"
