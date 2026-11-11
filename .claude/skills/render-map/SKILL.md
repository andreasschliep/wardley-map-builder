---
name: render-map
description: Create, validate and render Wardley maps from YAML, to PNG (matplotlib) or onto a Miro board. Use when the user wants a Wardley map drawn, checked, changed or turned into an image or a board.
argument-hint: <map.yaml or folder> [png|miro]
allowed-tools: Read Write Edit Glob Grep Bash(.venv/bin/python *) Bash(python3 -m venv *) Bash(.venv/bin/pip install *) Bash(node *) Bash(npm install) Bash(npm test)
---

# Render Wardley maps

Turn a Wardley map described in YAML into a PNG image or a Miro board.
All commands run from the repository root unless stated otherwise.

## Setup (once)

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
cd miro && npm install          # only for Miro output
```

## Workflow

1. **Write or edit the YAML** (format below). Start from `maps/bike-repair-service.yaml`.
   Ask the user for the user need at the top of the value chain before placing components.
2. **Validate** and fix every reported problem:
   `.venv/bin/python render_map.py <file-or-folder> --check`
3. **Render to PNG**:
   `.venv/bin/python render_map.py <file> -o out/<name>.png` (`--size small` for quiz-size images).
4. **Look at the PNG** with the Read tool. If labels overlap, add `labelOffset` to the affected
   components or move annotations, then render again.
5. **Miro (optional)**: always do a dry run first and show the user the summary:
   `cd miro && node render-to-miro.js ../<file> --dry-run`
   Only run against a real board when the user asks for it and `MIRO_ACCESS_TOKEN` is set in `.env`:
   `node render-to-miro.js ../<file> --new-board` or `--board-id <id>`.

Never put real company, customer or people names into example maps unless the user provides them
for their own map.

## YAML format

```yaml
title: "Map title"
layout: { width: 9000, height: 6500, padding: 500, componentSize: 28 }  # board pixels (Miro, labelOffset)
axes:
  y: { label: "Value Chain", top: "Visible", bottom: "Invisible" }
  x:
    label: "Evolution"
    stages: [["Genesis", ""], ["Custom-Built", ""], ["Product (+rental)", ""], ["Commodity (+utility)", ""]]
components:            # required; evolution and value between 0 and 1
  - { id: user, name: "Customer", type: activity, evolution: 0.55, value: 0.95 }
  - { id: know, name: "Know-how", type: knowledge, evolution: 0.40, value: 0.50, labelOffset: { x: 0, y: -60 } }
dependencies:          # from/to are component ids
  - { from: user, to: know }
movements:             # either `to: <id>` or `delta` (default 0.1) to the right
  - { from: know, delta: 0.15, label: "standardise", color: "#ef4444" }
groups:
  - { name: "Build in-house", bounds: { evolution: [0.05, 0.5], value: [0.4, 0.9] }, color: "#dbeafe", borderColor: "#3b82f6" }
highlights:
  - { evolution: 0.40, value: 0.50, radius: 0.05, color: "#fecaca" }
annotations:
  - { text: "Why this matters", evolution: 0.05, value: 0.30, color: "#dc2626" }
notes:
  - { text: "Context for the reader", position: top-right }   # top-right | right
```

Component types and shapes: activity = circle, practice = hexagon, data = square, knowledge = diamond.
Colours are hex values like `#1a1a1a`.

## Checks before handing over

- `--check` reports no problems.
- Tests pass: `.venv/bin/python -m unittest discover -s tests -t .` and `cd miro && npm test`.
- The rendered PNG has been looked at, not just generated.
