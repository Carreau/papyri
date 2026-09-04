"""GitHub Actions OIDC (trusted publishing) support for ``papyri upload``.

A pull request from a fork cannot read repository secrets, so a bearer token
never reaches the workflow that would publish a doc preview — the single most
common contribution flow. GitHub's answer is a short-lived, workload-bound ID
token: a workflow granted ``permissions: id-token: write`` asks the Actions
runtime for a JWT describing itself (repository, workflow, event, ref), and
sends *that* as the bearer.

The viewer verifies the signature against GitHub's public keys and derives the
preview namespace from the claims, so nothing sensitive travels and nothing the
client says can widen what the token may write. See ``viewer/src/lib/oidc.ts``.
"""

from __future__ import annotations

import json
import os
import urllib.parse
import urllib.request

#: Audience both ends default to. It must match the viewer's
#: ``PAPYRI_OIDC_AUDIENCE`` exactly, so it is a fixed string rather than
#: something derived from a URL (which could differ by a trailing slash).
DEFAULT_AUDIENCE = "papyri"

#: The Actions token endpoint is on GitHub's own infrastructure and answers
#: immediately; a short bound keeps a hung runner from stalling the job.
_TOKEN_TIMEOUT_S = 30


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


def default_audience() -> str:
    """Audience to request, honouring ``$PAPYRI_OIDC_AUDIENCE``."""
    return os.environ.get("PAPYRI_OIDC_AUDIENCE") or DEFAULT_AUDIENCE


def request_id_token(audience: str | None = None) -> str:
    """Ask the Actions runtime for an ID token with ``audience``.

    Raises ``OidcUnavailable`` when the request environment is missing (not a
    GitHub Actions run, or the job lacks ``id-token: write``) or the runtime
    refuses.
    """
    request_url = os.environ.get("ACTIONS_ID_TOKEN_REQUEST_URL")
    request_token = os.environ.get("ACTIONS_ID_TOKEN_REQUEST_TOKEN")
    if not request_url or not request_token:
        raise OidcUnavailable(
            "no GitHub Actions ID token available: this must run in a GitHub "
            "Actions job whose permissions include `id-token: write`"
        )

    aud = audience or default_audience()
    parsed = urllib.parse.urlsplit(request_url)
    query = urllib.parse.parse_qsl(parsed.query)
    query.append(("audience", aud))
    url = urllib.parse.urlunsplit(
        (
            parsed.scheme,
            parsed.netloc,
            parsed.path,
            urllib.parse.urlencode(query),
            "",
        )
    )
    req = urllib.request.Request(
        url,
        method="GET",
        headers={
            "Authorization": f"Bearer {request_token}",
            "Accept": "application/json; api-version=2.0",
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
