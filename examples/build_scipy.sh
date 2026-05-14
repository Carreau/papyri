#!/usr/bin/env bash
# Build scipy from a source checkout.  scipy needs system BLAS/LAPACK and a
# Fortran compiler, plus the same meson-python toolchain as numpy.  Like
# numpy, the shallow clone in the workflow skips vendored submodules so we
# init them before running `spin build`.
#
# Usage: build_scipy.sh <clone_dir>
#
# Exposes the in-place site-packages on PYTHONPATH via $GITHUB_ENV so that
# later workflow steps (papyri gen) can import the built scipy.

set -euo pipefail

CLONE_DIR="${1:?usage: build_scipy.sh <clone_dir>}"

sudo apt-get update
sudo apt-get install -y libopenblas-dev liblapack-dev gfortran

cd "$CLONE_DIR"
git submodule update --init --depth=1

uv pip install --system spin -r requirements/build.txt -r requirements/dev.txt

spin build

SITE_PACKAGES=$(find "$CLONE_DIR/build-install" -type d -name 'site-packages' | head -n 1)
if [ -z "$SITE_PACKAGES" ]; then
  echo "Could not locate spin build site-packages under $CLONE_DIR/build-install" >&2
  exit 1
fi
echo "PYTHONPATH=$SITE_PACKAGES" >> "$GITHUB_ENV"
