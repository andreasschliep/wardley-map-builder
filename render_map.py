#!/usr/bin/env python3
"""Render Wardley map YAML files to PNG.

Examples:
  python render_map.py maps/bike-repair-service.yaml -o out/bike-repair-service.png
  python render_map.py maps/ --out-dir out --size small
  python render_map.py maps/*.yaml --check          # validate only, no images

Exit codes: 0 = all files fine, 1 = at least one file invalid, 2 = usage error.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import yaml

from wardley_map import SIZES, MapValidationError, load_map, render_map


def collect_inputs(inputs: list[str]) -> list[Path]:
    files: list[Path] = []
    for item in inputs:
        path = Path(item)
        if path.is_dir():
            files.extend(sorted([*path.glob("*.yaml"), *path.glob("*.yml")]))
        else:
            files.append(path)
    return files


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Render Wardley map YAML files to PNG.")
    parser.add_argument("inputs", nargs="+", help="YAML map files or folders containing them")
    parser.add_argument("-o", "--output", help="output PNG path (only with a single input file)")
    parser.add_argument("--out-dir", default="out", help="output folder for multiple inputs (default: out)")
    parser.add_argument("--size", choices=sorted(SIZES), default="large", help="figure size (default: large)")
    parser.add_argument("--dpi", type=int, default=100, help="image resolution (default: 100)")
    parser.add_argument("--check", action="store_true", help="validate only, do not render")
    args = parser.parse_args(argv)

    files = collect_inputs(args.inputs)
    if not files:
        parser.error("no YAML files found")
    if args.output and len(files) != 1:
        parser.error("-o/--output only works with a single input file; use --out-dir instead")

    failures = 0
    for path in files:
        try:
            mapdef = load_map(path)
        except FileNotFoundError:
            print(f"ERROR {path}: file not found", file=sys.stderr)
            failures += 1
            continue
        except (MapValidationError, yaml.YAMLError) as err:
            print(f"ERROR {err}", file=sys.stderr)
            failures += 1
            continue

        if args.check:
            print(f"OK    {path}")
            continue
        target = Path(args.output) if args.output else Path(args.out_dir) / f"{path.stem}.png"
        render_map(mapdef, target, size=args.size, dpi=args.dpi)
        print(f"OK    {path} -> {target} ({target.stat().st_size // 1024} KB)")

    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
