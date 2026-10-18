#!/usr/bin/env python3
"""Check go-licenses CSV on stdin, production npm lockfile entries and,
with --cargo FILE, the crates in `cargo metadata` output for the desktop app."""

import csv
import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path

ALLOWED = {
    "MIT", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0", "ISC", "0BSD",
    "MPL-2.0", "CC0-1.0", "Unlicense", "BlueOak-1.0.0", "Python-2.0",
}
# Lockfiles of tools that only run at build time and are never shipped in the
# faztudo binary or packages. The documentation site's image tooling (sharp)
# bundles libvips under the LGPL; using it unmodified to build pages is fine.
BUILD_ONLY_LOCKFILES = {"site/package-lock.json"}
BUILD_ONLY_EXTRA = frozenset({"LGPL-3.0-or-later"})
# Add a package path here only after confirming it contains data, not code.
DATA_ONLY_NPM_PACKAGES = frozenset()
# npm packages whose license was reviewed by reading the LICENSE file they
# ship, because the package.json has no license field. Each entry is pinned to
# the exact lockfile integrity hash, so any other version or content fails.
REVIEWED_NPM_LICENSES = {
    # Pulled in by @react-three/drei through detect-gpu; LICENSE is MIT
    # (Copyright (c) 2019 Tim van Scherpenzeel), reviewed 2026-10-18.
    "node_modules/webgl-constants": ("MIT", "sha512-LkBXKjU5r9vAW7Gcu3T5u+5cvSvh5WwINdr0C+9jpzVB41cjQAP5ePArDtk/WHYdVj0GefCgM73BA7FlIiNtdg=="),
}
# Further permissive licenses that only crates use. Unicode-3.0 covers Unicode
# data tables, CDLA-Permissive-2.0 the Mozilla CA list in webpki-roots, and
# the LLVM exception only widens Apache-2.0.
CARGO_EXTRA = frozenset({"Unicode-3.0", "Zlib", "MIT-0", "CDLA-Permissive-2.0", "Apache-2.0-WITH-LLVM-exception"})
EXPRESSION = re.compile(r"[A-Za-z0-9.-]+|[()]", re.ASCII)
MATHUTIL_LICENSE_SHA256 = "bfa9bf72a72ca009fd62a8f84fca3dca67e51d93af96352723646599898b6cf5"


def allowed_license(value: str, data_only: bool = False, extra: frozenset = frozenset()) -> bool:
    if not value:
        return False
    parts = EXPRESSION.findall(value)
    if "".join(parts) != re.sub(r"\s+", "", value):
        return False
    expecting_license = True
    depth = 0
    for part in parts:
        if part == "(":
            if not expecting_license:
                return False
            depth += 1
        elif part == ")":
            if expecting_license or depth == 0:
                return False
            depth -= 1
        elif expecting_license:
            if part not in ALLOWED and part not in extra and not (data_only and part == "CC-BY-4.0"):
                return False
            expecting_license = False
        elif part in {"AND", "OR"}:
            expecting_license = True
        else:
            return False
    return not expecting_license and depth == 0


def check_go():
    errors = []
    rows = list(csv.reader(sys.stdin))
    if not rows:
        return ["go-licenses returned no modules"], 0
    for row in rows:
        if len(row) == 3 and row[0] == "modernc.org/mathutil" and row[2] == "Unknown":
            module = json.loads(subprocess.check_output(
                ["go", "list", "-m", "-json", "modernc.org/mathutil"], text=True))
            if module["Version"] == "v1.7.1":
                license_path = Path(module["Dir"]) / "LICENSE"
                if hashlib.sha256(license_path.read_bytes()).hexdigest() == MATHUTIL_LICENSE_SHA256:
                    continue  # Reviewed BSD-3-Clause text; classifier misses this file.
        if len(row) != 3 or not allowed_license(row[2]):
            errors.append("Go: " + ",".join(row))
    modules = set()
    for goos, goarch in (("linux", "amd64"), ("linux", "arm64"),
                         ("windows", "amd64"), ("darwin", "arm64")):
        environment = dict(os.environ, GOOS=goos, GOARCH=goarch)
        modules.update(subprocess.check_output(
            ["go", "list", "-deps", "-f", "{{if .Module}}{{.Module.Path}}{{end}}", "./..."],
            text=True, env=environment).splitlines())
    modules.discard("github.com/thiagodefreitas/faztudo")
    for module in sorted(modules):
        if not any(row[0] == module or row[0].startswith(module + "/") for row in rows):
            errors.append("Go: missing license report for " + module)
    return errors, len(rows)


def check_npm(paths):
    errors = []
    count = 0
    for path in paths:
        lock = json.loads(Path(path).read_text(encoding="utf-8"))
        if lock.get("lockfileVersion") != 3 or not isinstance(lock.get("packages"), dict):
            errors.append(f"{path}: unsupported lockfile")
            continue
        for name, package in lock["packages"].items():
            if not name or package.get("dev") is True:
                continue
            count += 1
            license_id = package.get("license")
            reviewed = REVIEWED_NPM_LICENSES.get(name)
            if license_id is None and reviewed and package.get("integrity") == reviewed[1]:
                license_id = reviewed[0]
            # CC-BY-4.0 requires a reviewed data-only exception. None is set.
            extra = BUILD_ONLY_EXTRA if Path(path).as_posix() in BUILD_ONLY_LOCKFILES else frozenset()
            if not isinstance(license_id, str) or not allowed_license(license_id, name in DATA_ONLY_NPM_PACKAGES, extra):
                errors.append(f"{path}: {name}: {license_id or 'missing license'}")
    return errors, count


def cargo_license(value: str) -> str:
    """Rewrites the old Cargo forms ("MIT/Apache-2.0") and the LLVM exception
    into plain expressions the checker reads."""
    value = re.sub(r"\s*/\s*", " OR ", value)
    return value.replace("Apache-2.0 WITH LLVM-exception", "Apache-2.0-WITH-LLVM-exception")


def check_cargo(paths):
    errors = []
    count = 0
    for path in paths:
        meta = json.loads(Path(path).read_text(encoding="utf-8"))
        used = {node["id"] for node in meta["resolve"]["nodes"]}
        for package in meta["packages"]:
            if package["id"] not in used or package.get("source") is None:
                continue  # the app itself, or a crate not built for this target
            count += 1
            license_id = package.get("license")
            if not isinstance(license_id, str) or not allowed_license(cargo_license(license_id), extra=CARGO_EXTRA):
                errors.append(f"Cargo: {package['name']} {package['version']}: {license_id or 'missing license'}")
    return errors, count


def main():
    args = sys.argv[1:]
    cargo = []
    while "--cargo" in args:
        i = args.index("--cargo")
        cargo.append(args[i + 1])
        del args[i:i + 2]
    go_errors, go_count = check_go()
    npm_errors, npm_count = check_npm(args)
    cargo_errors, cargo_count = check_cargo(cargo)
    errors = go_errors + npm_errors + cargo_errors
    for error in errors:
        print(error, file=sys.stderr)
    print(f"Checked {go_count} Go packages, {npm_count} production npm packages and {cargo_count} crates: {len(errors)} disallowed or missing licenses")
    return int(bool(errors))


if __name__ == "__main__":
    sys.exit(main())
