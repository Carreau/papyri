#!/usr/bin/env bash
# Build numpy from a source checkout using `spin` (numpy's meson-python
# wrapper).  numpy can't be installed with a plain `pip install .` in our
# matrix build because we run with `--system` and want to skip build
# isolation; this script makes the build deps explicit and uses `spin build`
# which is the path numpy itself recommends for source builds.
#
# Usage: build_numpy.sh <clone_dir>
#
# Exposes the resulting in-place site-packages on PYTHONPATH via $GITHUB_ENV
# so that later workflow steps (papyri gen) can import the built numpy.

set -euo pipefail

CLONE_DIR="${1:?usage: build_numpy.sh <clone_dir>}"

uv pip install --system meson meson-python ninja Cython spin pythran

cd "$CLONE_DIR"
# numpy bundles meson as a git submodule; the shallow clone in the workflow
# skips it, so `spin build` aborts until we populate it.
git submodule update --init --depth=1
spin build

SITE_PACKAGES=$(find "$CLONE_DIR/build-install" -type d -name 'site-packages' | head -n 1)
if [ -z "$SITE_PACKAGES" ]; then
  echo "Could not locate spin build site-packages under $CLONE_DIR/build-install" >&2
  exit 1
fi
echo "PYTHONPATH=$SITE_PACKAGES" >> "$GITHUB_ENV"
