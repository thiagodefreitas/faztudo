#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
# The desktop app's crates, for both release targets, when cargo is present.
cargo_args=()
if command -v cargo >/dev/null 2>&1; then
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  for target in x86_64-unknown-linux-gnu aarch64-unknown-linux-gnu; do
    cargo metadata --locked --format-version 1 --filter-platform "$target" \
      --manifest-path desktop/src-tauri/Cargo.toml > "$tmp/$target.json"
    cargo_args+=(--cargo "$tmp/$target.json")
  done
else
  echo "check_licenses: cargo not found, skipping the desktop crates" >&2
fi
go run github.com/google/go-licenses@v1.6.0 report ./... \
  github.com/danieljoos/wincred github.com/mattn/go-isatty \
  github.com/ncruces/go-strftime --ignore github.com/thiagodefreitas/faztudo |
  python3 -B scripts/check_licenses.py web/package-lock.json site/package-lock.json "${cargo_args[@]}"
