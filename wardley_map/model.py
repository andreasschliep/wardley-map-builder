"""Load and validate Wardley map definitions written in YAML.

Coordinates are normalised:
  evolution (x): 0.0 = Genesis (left)    -> 1.0 = Commodity (right)
  value     (y): 0.0 = Invisible (bottom) -> 1.0 = Visible (top)

All problems found in a map are collected and reported together, so a map
author can fix them in one pass.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import yaml

COMPONENT_TYPES = ("activity", "practice", "data", "knowledge")
NOTE_POSITIONS = ("top-right", "right")
DEFAULT_STAGES = [
    ["Genesis", ""],
    ["Custom-Built", ""],
    ["Product (+rental)", ""],
    ["Commodity (+utility)", ""],
]
DEFAULT_LAYOUT = {"width": 8000, "height": 6000, "padding": 400, "componentSize": 30}
DEFAULT_MOVEMENT_DELTA = 0.1

_HEX_COLOUR = re.compile(r"^#[0-9a-fA-F]{6}$")


class MapValidationError(ValueError):
    """Raised when a map definition is invalid. `problems` lists every issue found."""

    def __init__(self, problems: list[str], source: str | None = None):
        self.problems = list(problems)
        self.source = source
        heading = f"Invalid map definition{f' in {source}' if source else ''}:"
        super().__init__("\n".join([heading, *[f"  - {p}" for p in self.problems]]))


def load_map(path: str | Path) -> dict[str, Any]:
    """Read a YAML map file and validate it. Returns the parsed mapping."""
    path = Path(path)
    with path.open(encoding="utf-8") as handle:
        mapdef = yaml.safe_load(handle)
    validate_map(mapdef, source=str(path))
    return mapdef


def stage_names(mapdef: dict[str, Any]) -> list[str]:
    """Return the four stage labels of the evolution axis."""
    stages = (mapdef.get("axes") or {}).get("x", {}).get("stages") or DEFAULT_STAGES
    return [s[0] if isinstance(s, (list, tuple)) else str(s) for s in stages]


def layout_of(mapdef: dict[str, Any]) -> dict[str, float]:
    """Return the board layout (pixel units, used by the Miro renderer and labelOffset)."""
    return {**DEFAULT_LAYOUT, **(mapdef.get("layout") or {})}


def validate_map(mapdef: Any, source: str | None = None) -> None:
    """Validate a parsed map definition. Raises MapValidationError listing all problems."""
    if not isinstance(mapdef, dict):
        raise MapValidationError(["the map definition must be a YAML mapping"], source)

    problems: list[str] = []
    _check_layout(mapdef.get("layout"), problems)
    _check_axes(mapdef.get("axes"), problems)

    components = mapdef.get("components")
    if not isinstance(components, list) or not components:
        problems.append("'components' must be a non-empty list")
        components = []

    positions: dict[str, tuple[float, float]] = {}
    for i, comp in enumerate(components):
        where = f"components[{i}]"
        if not isinstance(comp, dict):
            problems.append(f"{where} must be a mapping")
            continue
        comp_id = comp.get("id")
        if not isinstance(comp_id, str) or not comp_id:
            problems.append(f"{where}.id must be a non-empty string")
        elif comp_id in positions:
            problems.append(f"{where}.id '{comp_id}' is used more than once")
        else:
            where = f"component '{comp_id}'"
        if not isinstance(comp.get("name"), str) or not comp["name"].strip():
            problems.append(f"{where}.name must be a non-empty string")
        comp_type = comp.get("type", "activity")
        if comp_type not in COMPONENT_TYPES:
            problems.append(f"{where}.type must be one of {', '.join(COMPONENT_TYPES)}, got {comp_type!r}")
        ok_evo = _unit(comp.get("evolution"), f"{where}.evolution", problems)
        ok_val = _unit(comp.get("value"), f"{where}.value", problems)
        _colour(comp.get("color"), f"{where}.color", problems)
        _colour(comp.get("borderColor"), f"{where}.borderColor", problems)
        offset = comp.get("labelOffset")
        if offset is not None and not (
            isinstance(offset, dict) and all(_is_number(offset.get(k, 0)) for k in ("x", "y"))
        ):
            problems.append(f"{where}.labelOffset must be a mapping with numeric x and y")
        if isinstance(comp_id, str) and comp_id and comp_id not in positions:
            positions[comp_id] = (
                comp.get("evolution") if ok_evo else 0.0,
                comp.get("value") if ok_val else 0.0,
            )

    for i, dep in enumerate(_list(mapdef, "dependencies", problems)):
        where = f"dependencies[{i}]"
        if not isinstance(dep, dict):
            problems.append(f"{where} must be a mapping")
            continue
        for end in ("from", "to"):
            _known(dep.get(end), positions, f"{where}.{end}", problems)
        _colour(dep.get("color"), f"{where}.color", problems)

    for i, mov in enumerate(_list(mapdef, "movements", problems)):
        where = f"movements[{i}]"
        if not isinstance(mov, dict):
            problems.append(f"{where} must be a mapping")
            continue
        start_known = _known(mov.get("from"), positions, f"{where}.from", problems)
        if "to" in mov:
            _known(mov.get("to"), positions, f"{where}.to", problems)
        else:
            delta = mov.get("delta", DEFAULT_MOVEMENT_DELTA)
            if not _is_number(delta):
                problems.append(f"{where}.delta must be a number, got {delta!r}")
            elif start_known:
                target = positions[mov["from"]][0] + delta
                if not 0 <= target <= 1:
                    problems.append(
                        f"{where}: '{mov['from']}' moved by {delta} ends at evolution {target:.2f}, outside 0..1"
                    )
        _colour(mov.get("color"), f"{where}.color", problems)

    for i, grp in enumerate(_list(mapdef, "groups", problems)):
        where = f"groups[{i}]"
        if not isinstance(grp, dict):
            problems.append(f"{where} must be a mapping")
            continue
        bounds = grp.get("bounds")
        if not isinstance(bounds, dict):
            problems.append(f"{where}.bounds must contain 'evolution' and 'value' ranges")
        else:
            _range(bounds.get("evolution"), f"{where}.bounds.evolution", problems)
            _range(bounds.get("value"), f"{where}.bounds.value", problems)
        _colour(grp.get("color"), f"{where}.color", problems)
        _colour(grp.get("borderColor"), f"{where}.borderColor", problems)

    for i, hl in enumerate(_list(mapdef, "highlights", problems)):
        where = f"highlights[{i}]"
        if not isinstance(hl, dict):
            problems.append(f"{where} must be a mapping")
            continue
        _unit(hl.get("evolution"), f"{where}.evolution", problems)
        _unit(hl.get("value"), f"{where}.value", problems)
        radius = hl.get("radius", 0.05)
        if not _is_number(radius) or not 0 < radius <= 0.5:
            problems.append(f"{where}.radius must be a number in (0, 0.5], got {radius!r}")
        _colour(hl.get("color"), f"{where}.color", problems)

    for i, ann in enumerate(_list(mapdef, "annotations", problems)):
        where = f"annotations[{i}]"
        if not isinstance(ann, dict):
            problems.append(f"{where} must be a mapping")
            continue
        if not isinstance(ann.get("text"), str) or not ann["text"].strip():
            problems.append(f"{where}.text must be a non-empty string")
        _unit(ann.get("evolution"), f"{where}.evolution", problems)
        _unit(ann.get("value"), f"{where}.value", problems)
        _colour(ann.get("color"), f"{where}.color", problems)

    for i, note in enumerate(_list(mapdef, "notes", problems)):
        where = f"notes[{i}]"
        if not isinstance(note, dict):
            problems.append(f"{where} must be a mapping")
            continue
        if not isinstance(note.get("text"), str) or not note["text"].strip():
            problems.append(f"{where}.text must be a non-empty string")
        position = note.get("position", "top-right")
        if position not in NOTE_POSITIONS:
            problems.append(f"{where}.position must be one of {', '.join(NOTE_POSITIONS)}, got {position!r}")

    if problems:
        raise MapValidationError(problems, source)


# --------------------------------------------------------------------------- helpers


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _unit(value: Any, where: str, problems: list[str]) -> bool:
    if not _is_number(value):
        problems.append(f"{where} must be a number between 0 and 1, got {value!r}")
        return False
    if not 0 <= value <= 1:
        problems.append(f"{where} must be between 0 and 1, got {value}")
        return False
    return True


def _range(value: Any, where: str, problems: list[str]) -> None:
    if not (isinstance(value, (list, tuple)) and len(value) == 2):
        problems.append(f"{where} must be a list [min, max]")
        return
    results = [_unit(v, f"{where}[{i}]", problems) for i, v in enumerate(value)]
    if all(results) and value[0] >= value[1]:
        problems.append(f"{where} must have min < max, got {list(value)}")


def _colour(value: Any, where: str, problems: list[str]) -> None:
    if value is not None and not (isinstance(value, str) and _HEX_COLOUR.match(value)):
        problems.append(f"{where} must be a hex colour like '#1a1a1a', got {value!r}")


def _known(comp_id: Any, positions: dict[str, Any], where: str, problems: list[str]) -> bool:
    if comp_id in positions:
        return True
    problems.append(f"{where} refers to unknown component {comp_id!r}")
    return False


def _list(mapdef: dict[str, Any], key: str, problems: list[str]) -> list[Any]:
    value = mapdef.get(key)
    if value is None:
        return []
    if not isinstance(value, list):
        problems.append(f"'{key}' must be a list")
        return []
    return value


def _check_layout(layout: Any, problems: list[str]) -> None:
    if layout is None:
        return
    if not isinstance(layout, dict):
        problems.append("'layout' must be a mapping")
        return
    for key in ("width", "height", "padding", "componentSize"):
        if key in layout and (not _is_number(layout[key]) or layout[key] <= 0):
            problems.append(f"layout.{key} must be a positive number, got {layout[key]!r}")
    merged = {**DEFAULT_LAYOUT, **layout}
    if all(_is_number(merged[k]) for k in ("width", "height", "padding")):
        if 2 * merged["padding"] >= min(merged["width"], merged["height"]):
            problems.append("layout.padding is too large for the layout width/height")


def _check_axes(axes: Any, problems: list[str]) -> None:
    if axes is None:
        return
    if not isinstance(axes, dict):
        problems.append("'axes' must be a mapping")
        return
    stages = (axes.get("x") or {}).get("stages")
    if stages is None:
        return
    if not isinstance(stages, list) or len(stages) != 4:
        problems.append("axes.x.stages must list exactly four stages (Genesis to Commodity)")
        return
    for i, stage in enumerate(stages):
        if isinstance(stage, str):
            continue
        if not (isinstance(stage, (list, tuple)) and 1 <= len(stage) <= 2 and all(isinstance(s, str) for s in stage)):
            problems.append(f"axes.x.stages[{i}] must be a name or [name, subtitle]")
