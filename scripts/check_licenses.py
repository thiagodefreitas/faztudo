#!/usr/bin/env python3
"""Check go-licenses CSV on stdin and production npm lockfile entries."""

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
            # CC-BY-4.0 requires a reviewed data-only exception. None is set.
            extra = BUILD_ONLY_EXTRA if Path(path).as_posix() in BUILD_ONLY_LOCKFILES else frozenset()
            if not isinstance(license_id, str) or not allowed_license(license_id, name in DATA_ONLY_NPM_PACKAGES, extra):
                errors.append(f"{path}: {name}: {license_id or 'missing license'}")
    return errors, count


def main():
    go_errors, go_count = check_go()
    npm_errors, npm_count = check_npm(sys.argv[1:])
    errors = go_errors + npm_errors
    for error in errors:
        print(error, file=sys.stderr)
    print(f"Checked {go_count} Go packages and {npm_count} production npm packages: {len(errors)} disallowed or missing licenses")
    return int(bool(errors))


if __name__ == "__main__":
    sys.exit(main())
