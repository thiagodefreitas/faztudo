#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
go run github.com/google/go-licenses@v1.6.0 report ./... \
  github.com/danieljoos/wincred github.com/mattn/go-isatty \
  github.com/ncruces/go-strftime --ignore github.com/thiagodefreitas/faztudo |
  python3 -B scripts/check_licenses.py web/package-lock.json site/package-lock.json
