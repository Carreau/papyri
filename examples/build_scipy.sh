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

# scipy main dropped the generated requirements/{build,dev}.txt files in favour
# of PEP 735 dependency groups in pyproject.toml; older tags (e.g. v1.18.0)
# still ship the .txt files.  Use whichever the checkout has — either way we
# only need the meson/Cython/pythran/numpy build toolchain plus the spin runner.
if [ -f requirements/build.txt ]; then
  uv pip install --system spin -r requirements/build.txt -r requirements/dev.txt
else
  uv pip install --system spin --group build
fi

spin build

SITE_PACKAGES=$(find "$CLONE_DIR/build-install" -type d -name 'site-packages' | head -n 1)
if [ -z "$SITE_PACKAGES" ]; then
  echo "Could not locate spin build site-packages under $CLONE_DIR/build-install" >&2
  exit 1
fi
echo "PYTHONPATH=$SITE_PACKAGES" >> "$GITHUB_ENV"
