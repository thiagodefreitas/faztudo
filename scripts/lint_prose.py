#!/usr/bin/env python3
"""Checks prose files for the project's writing rules.

Rules (see CONTRIBUTING.md):
  - ASCII only: no long dashes, curly quotes, ellipsis characters or emoji.
  - None of a short list of stock phrases that make text sound generated.

Usage: scripts/lint_prose.py [paths...]   (default: tracked *.md files)
"""
from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

STOCK_PHRASES = [
    r"\bdelve\b",
    r"\bseamless(ly)?\b",
    r"\bleverag(e|es|ing)\b",
    r"\bgame[- ]chang(er|ing)\b",
    r"\bunlock(s|ing)? the (full )?power\b",
    r"\brobust and scalable\b",
    r"\bin today's fast-paced\b",
    r"\bcutting[- ]edge\b",
    r"\bit'?s worth noting\b",
    r"\bembark\b",
    r"\btapestry\b",
    r"\belevate your\b",
]
STOCK_RE = re.compile("|".join(STOCK_PHRASES), re.IGNORECASE)
SKIP_PARTS = {"node_modules", "dist", ".astro", "vendor"}


def default_paths() -> list[Path]:
    out = subprocess.run(
        ["git", "ls-files", "*.md", "*.mdx"], capture_output=True, text=True, check=True
    ).stdout
    return [Path(p) for p in out.splitlines()]


def check(path: Path) -> list[str]:
    problems: list[str] = []
    if SKIP_PARTS & set(path.parts):
        return problems
    for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        for col, ch in enumerate(line, 1):
            if ord(ch) > 127:
                problems.append(f"{path}:{n}:{col}: non-ASCII character U+{ord(ch):04X}")
                break
        m = STOCK_RE.search(line)
        if m:
            problems.append(f"{path}:{n}: stock phrase '{m.group(0)}'")
    return problems


def main(argv: list[str]) -> int:
    paths = [Path(a) for a in argv] or default_paths()
    problems = [p for path in paths if path.is_file() for p in check(path)]
    for p in problems:
        print(p)
    if not problems:
        print(f"prose: ok ({len(paths)} files)")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
