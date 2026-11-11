"""Render a validated Wardley map definition to a PNG image with matplotlib."""

from __future__ import annotations

import textwrap
from pathlib import Path
from typing import Any

import matplotlib

matplotlib.use("Agg")  # headless rendering, no display needed

import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.lines import Line2D  # noqa: E402
from matplotlib.patches import Circle, FancyBboxPatch  # noqa: E402

from .model import COMPONENT_TYPES, DEFAULT_MOVEMENT_DELTA, layout_of, stage_names, validate_map  # noqa: E402

SIZES = {"large": (16, 10.67), "small": (12, 8.4)}
STAGE_BOUNDS = [0.0, 0.25, 0.50, 0.75, 1.0]

# Marker per component type; the Miro renderer uses the matching shapes
# (circle, hexagon, rectangle, rhombus).
MARKERS = {
    "activity": ("o", 8),
    "practice": ("h", 9),
    "data": ("s", 7),
    "knowledge": ("D", 7),
}

COLOURS = {
    "component": "#1a1a1a",
    "dependency": "#94a3b8",
    "movement": "#ef4444",
    "annotation": "#dc2626",
    "group": "#f1f5f9",
    "groupBorder": "#94a3b8",
    "highlight": "#fecaca",
    "axis": "#334155",
    "axisLabel": "#64748b",
    "stageLabel": "#94a3b8",
    "stageDivider": "#e2e8f0",
}


def _rgb(hex_colour: str) -> tuple[float, float, float]:
    value = hex_colour.lstrip("#")
    return tuple(int(value[i : i + 2], 16) / 255 for i in (0, 2, 4))  # type: ignore[return-value]


def render_map(mapdef: dict[str, Any], outfile: str | Path, size: str = "large", dpi: int = 100) -> Path:
    """Render `mapdef` to `outfile` (PNG). Validates first. Returns the output path."""
    validate_map(mapdef)
    if size not in SIZES:
        raise ValueError(f"size must be one of {', '.join(SIZES)}, got {size!r}")

    colours = {**COLOURS, **(mapdef.get("colors") or {})}
    fig, ax = plt.subplots(1, 1, figsize=SIZES[size])
    try:
        _draw_frame(ax, fig, mapdef, colours)
        positions = {c["id"]: (c["evolution"], c["value"]) for c in mapdef["components"]}
        _draw_groups(ax, mapdef.get("groups") or [], colours)
        _draw_highlights(ax, mapdef.get("highlights") or [], colours)
        _draw_dependencies(ax, mapdef.get("dependencies") or [], positions, colours)
        _draw_movements(ax, mapdef.get("movements") or [], positions, colours)
        _draw_components(ax, mapdef, colours)
        _draw_annotations(ax, mapdef.get("annotations") or [], colours)
        _draw_notes(ax, mapdef.get("notes") or [])
        _draw_legend(ax, mapdef["components"])
        ax.set_title(mapdef.get("title", ""), fontsize=14, fontweight="bold", color="#1e293b", pad=12)

        outfile = Path(outfile)
        outfile.parent.mkdir(parents=True, exist_ok=True)
        fig.tight_layout()
        fig.savefig(outfile, dpi=dpi, bbox_inches="tight", facecolor="white")
    finally:
        plt.close(fig)
    return outfile


# --------------------------------------------------------------------------- drawing steps


def _draw_frame(ax, fig, mapdef: dict[str, Any], colours: dict[str, str]) -> None:
    ax.set_xlim(0, 1)
    ax.set_ylim(0, 1)
    ax.set_facecolor("#fafafa")
    fig.patch.set_facecolor("#ffffff")

    for bound in STAGE_BOUNDS[1:-1]:
        ax.axvline(x=bound, color=colours["stageDivider"], linewidth=0.8, linestyle="--", zorder=1)
    for i, name in enumerate(stage_names(mapdef)):
        centre = (STAGE_BOUNDS[i] + STAGE_BOUNDS[i + 1]) / 2
        ax.text(centre, -0.03, name, ha="center", va="top", fontsize=9, color=colours["stageLabel"])

    axes = mapdef.get("axes") or {}
    y_axis = axes.get("y") or {}
    x_axis = axes.get("x") or {}
    ax.set_ylabel(y_axis.get("label", "Value Chain"), fontsize=11, color=colours["axis"])
    ax.set_xlabel(x_axis.get("label", "Evolution"), fontsize=11, color=colours["axis"], labelpad=30)
    ax.text(-0.02, 1.0, y_axis.get("top", "Visible"), ha="right", va="top", fontsize=8,
            color=colours["axisLabel"], transform=ax.transAxes)
    ax.text(-0.02, 0.0, y_axis.get("bottom", "Invisible"), ha="right", va="bottom", fontsize=8,
            color=colours["axisLabel"], transform=ax.transAxes)

    ax.set_xticks([])
    ax.set_yticks([])
    for name, spine in ax.spines.items():
        spine.set_visible(name in ("left", "bottom"))
        spine.set_color(colours["axis"])


def _draw_groups(ax, groups: list[dict[str, Any]], colours: dict[str, str]) -> None:
    for grp in groups:
        (e0, e1), (v0, v1) = grp["bounds"]["evolution"], grp["bounds"]["value"]
        fill = _rgb(grp.get("color", colours["group"]))
        border = _rgb(grp.get("borderColor", colours["groupBorder"]))
        ax.add_patch(FancyBboxPatch(
            (e0, v0), e1 - e0, v1 - v0, boxstyle="round,pad=0.01",
            facecolor=(*fill, 0.4), edgecolor=(*border, 0.7), linewidth=1.5, zorder=2,
        ))
        ax.text(e0 + 0.01, v1 - 0.01, grp.get("name", ""), fontsize=7, color=border,
                va="top", fontstyle="italic", zorder=3)


def _draw_highlights(ax, highlights: list[dict[str, Any]], colours: dict[str, str]) -> None:
    for hl in highlights:
        ax.add_patch(Circle((hl["evolution"], hl["value"]), hl.get("radius", 0.05),
                            color=_rgb(hl.get("color", colours["highlight"])), alpha=0.35, zorder=2))


def _draw_dependencies(ax, dependencies, positions, colours) -> None:
    for dep in dependencies:
        (x1, y1), (x2, y2) = positions[dep["from"]], positions[dep["to"]]
        ax.plot([x1, x2], [y1, y2], color=_rgb(dep.get("color", colours["dependency"])),
                linewidth=0.8, alpha=0.6, zorder=3)


def _draw_movements(ax, movements, positions, colours) -> None:
    for mov in movements:
        x1, y1 = positions[mov["from"]]
        if "to" in mov:
            x2, y2 = positions[mov["to"]]
        else:
            x2, y2 = x1 + mov.get("delta", DEFAULT_MOVEMENT_DELTA), y1
        colour = _rgb(mov.get("color", colours["movement"]))
        ax.annotate("", xy=(x2, y2), xytext=(x1, y1), zorder=5,
                    arrowprops=dict(arrowstyle="->", color=colour, lw=1.8, linestyle="--"))
        if mov.get("label"):
            # below the arrow, because component labels sit above their markers
            ax.text((x1 + x2) / 2, (y1 + y2) / 2 - 0.015, mov["label"], fontsize=6.5, color=colour,
                    ha="center", va="top", zorder=6,
                    bbox=dict(boxstyle="round,pad=0.2", facecolor="white", alpha=0.8, edgecolor="none"))


def _draw_components(ax, mapdef: dict[str, Any], colours: dict[str, str]) -> None:
    layout = layout_of(mapdef)
    usable_w = layout["width"] - 2 * layout["padding"]
    usable_h = layout["height"] - 2 * layout["padding"]
    for comp in mapdef["components"]:
        x, y = comp["evolution"], comp["value"]
        marker, size = MARKERS[comp.get("type", "activity")]
        edge = comp.get("borderColor", comp.get("color", colours["component"]))
        ax.plot(x, y, marker=marker, markersize=size, color=_rgb(edge), markerfacecolor="white",
                markeredgewidth=1.8, zorder=8)

        offset = comp.get("labelOffset")
        if offset:
            # labelOffset is given in board pixels (x right, y down), like on the Miro board
            tx, ty, va = x + offset.get("x", 0) / usable_w, y - offset.get("y", 0) / usable_h, "center"
        else:
            tx, ty, va = x, y + 0.025, "bottom"
        ax.text(tx, ty, comp["name"], fontsize=7, ha="center", va=va, color="#1a1a1a", zorder=9,
                bbox=dict(boxstyle="round,pad=0.15", facecolor="white", alpha=0.85, edgecolor="none"))


def _draw_annotations(ax, annotations, colours) -> None:
    for ann in annotations:
        ax.text(ann["evolution"], ann["value"], textwrap.fill(ann["text"], 38), fontsize=6.5,
                color=_rgb(ann.get("color", colours["annotation"])), fontstyle="italic", zorder=7,
                bbox=dict(boxstyle="round,pad=0.2", facecolor="white", alpha=0.85, edgecolor="none"))


def _draw_notes(ax, notes) -> None:
    for note in notes:
        y = 0.99 if note.get("position", "top-right") == "top-right" else 0.5
        ax.text(0.99, y, textwrap.fill(note["text"], 42), transform=ax.transAxes, ha="right",
                va="top" if y > 0.9 else "center", fontsize=7, color="#334155", zorder=10,
                bbox=dict(boxstyle="round,pad=0.4", facecolor="#f8fafc", edgecolor="#cbd5e1"))


def _draw_legend(ax, components) -> None:
    used = [t for t in COMPONENT_TYPES if any(c.get("type", "activity") == t for c in components)]
    if len(used) < 2:
        return
    handles = [
        Line2D([], [], linestyle="none", marker=MARKERS[t][0], markersize=MARKERS[t][1] * 0.8,
               markerfacecolor="white", markeredgecolor="#1a1a1a", markeredgewidth=1.5, label=t)
        for t in used
    ]
    ax.legend(handles=handles, loc="lower left", fontsize=7, frameon=True, framealpha=0.9,
              title="Component type", title_fontsize=7)
