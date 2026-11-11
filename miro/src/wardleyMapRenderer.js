'use strict';

/**
 * Render a Wardley map definition onto a Miro board: one frame containing
 * axes, stage labels, groups, highlights, components (shape per type),
 * dependencies, movements, annotations and notes.
 *
 * Coordinates in the YAML are normalised:
 *   evolution (x): 0.0 = Genesis (left)    -> 1.0 = Commodity (right)
 *   value     (y): 0.0 = Invisible (bottom) -> 1.0 = Visible (top)
 * They are mapped to pixels inside the frame (x right, y down).
 */

const { DEFAULT_LAYOUT, DEFAULT_MOVEMENT_DELTA, DEFAULT_STAGES } = require('./loadMap');

// Shape per component type; the PNG renderer uses matching markers.
const SHAPES = { activity: 'circle', practice: 'hexagon', data: 'rectangle', knowledge: 'rhombus' };
const TYPE_SYMBOLS = { activity: '●', practice: '⬢', data: '■', knowledge: '◆' };

const COLOURS = {
  component: '#1a1a1a',
  dependency: '#808080',
  movement: '#ef4444',
  group: '#e2e8f0',
  groupBorder: '#94a3b8',
  annotation: '#ef4444',
  highlight: '#fecaca',
  axis: '#334155',
  axisLabel: '#64748b',
  stageLabel: '#94a3b8',
  stageDivider: '#e2e8f0',
};

const LABEL_STYLE = { fillColor: '#ffffff', borderColor: '#ffffff', borderWidth: '1' };

function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

class WardleyMapRenderer {
  /**
   * @param {import('./miroClient').MiroClient} client
   * @param {{log?: (msg: string) => void}} [options]
   */
  constructor(client, options = {}) {
    this.client = client;
    this.log = options.log || (() => {});
  }

  /** Map (evolution, value) to pixel coordinates relative to the frame's top-left corner. */
  static toPixel(evolution, value, layout) {
    return {
      x: layout.padding + evolution * (layout.width - 2 * layout.padding),
      y: layout.padding + (1 - value) * (layout.height - 2 * layout.padding),
    };
  }

  /**
   * @param {string} boardId
   * @param {object} mapDef - validated map definition (see loadMap.js)
   * @param {{x: number, y: number}} [origin] - frame position on the board
   * @returns {Promise<{frameId: string, componentIds: Map<string, string>}>}
   */
  async render(boardId, mapDef, origin = { x: 0, y: 0 }) {
    const layout = { ...DEFAULT_LAYOUT, ...mapDef.layout };
    const colours = { ...COLOURS, ...mapDef.colors };

    this.log('Creating frame...');
    const frame = await this.client.createFrame(boardId, {
      title: mapDef.title || 'Wardley Map', x: origin.x, y: origin.y, width: layout.width, height: layout.height,
    });
    const shape = (item) => this.client.createShape(boardId, { ...item, parentId: frame.id });

    this.log('Drawing axes...');
    await this.renderAxes(shape, layout, colours, mapDef.axes || {});

    for (const group of mapDef.groups || []) await this.renderGroup(shape, group, layout, colours);
    for (const highlight of mapDef.highlights || []) await this.renderHighlight(shape, highlight, layout, colours);

    const componentIds = new Map();
    this.log(`Rendering ${mapDef.components.length} components...`);
    for (const comp of mapDef.components) {
      componentIds.set(comp.id, await this.renderComponent(shape, comp, layout, colours));
    }

    for (const dep of mapDef.dependencies || []) {
      await this.client.createConnector(boardId, {
        startItemId: componentIds.get(dep.from),
        endItemId: componentIds.get(dep.to),
        startCap: 'none',
        endCap: 'none',
        color: dep.color || colours.dependency,
        strokeWidth: dep.strokeWidth || 2,
      });
    }

    for (const mov of mapDef.movements || []) {
      await this.renderMovement(boardId, shape, mov, componentIds, mapDef.components, layout, colours);
    }
    for (const ann of mapDef.annotations || []) await this.renderAnnotation(shape, ann, layout, colours);
    for (const note of mapDef.notes || []) await this.renderNote(shape, note, layout);

    return { frameId: frame.id, componentIds };
  }

  async renderAxes(shape, layout, colours, axes) {
    const { padding: pad, width: w, height: h } = layout;
    const stages = axes.x?.stages || DEFAULT_STAGES;
    const label = (text, x, y, width, height, fontSize, fontColor) => shape({
      content: `<p><strong>${escapeHtml(text)}</strong></p>`, x, y, width, height,
      style: { ...LABEL_STYLE, fontSize, textAlign: 'center', fontColor },
    });
    const bar = (x, y, width, height, colour) => shape({
      x, y, width, height, style: { fillColor: colour, borderColor: colour, borderWidth: '1' },
    });

    await bar(pad, h / 2, 8, h - 2 * pad + 40, colours.axis); // value axis
    await bar(w / 2, h - pad, w - 2 * pad + 40, 8, colours.axis); // evolution axis
    await label(axes.y?.top || 'Visible', pad, pad - 100, 400, 100, 48, colours.axisLabel);
    await label(axes.y?.bottom || 'Invisible', pad, h - pad + 100, 400, 100, 48, colours.axisLabel);
    await label(axes.y?.label || 'Value Chain', 140, h / 2, 350, 120, 64, colours.axisLabel);
    await label(axes.x?.label || 'Evolution', w / 2, h - pad + 200, 500, 120, 64, colours.axisLabel);

    const stageWidth = (w - 2 * pad) / stages.length;
    for (let i = 0; i < stages.length; i += 1) {
      const [name, subtitle] = Array.isArray(stages[i]) ? stages[i] : [stages[i], ''];
      const text = subtitle
        ? `<p><strong>${escapeHtml(name)}</strong><br/>${escapeHtml(subtitle)}</p>`
        : `<p><strong>${escapeHtml(name)}</strong></p>`;
      await shape({
        content: text, x: pad + stageWidth * (i + 0.5), y: h - pad + 80, width: stageWidth - 20, height: 100,
        style: { ...LABEL_STYLE, fontSize: 48, textAlign: 'center', fontColor: colours.stageLabel },
      });
      if (i > 0) await bar(pad + stageWidth * i, h / 2, 8, h - 2 * pad, colours.stageDivider);
    }
  }

  async renderGroup(shape, group, layout, colours) {
    const topLeft = WardleyMapRenderer.toPixel(group.bounds.evolution[0], group.bounds.value[1], layout);
    const bottomRight = WardleyMapRenderer.toPixel(group.bounds.evolution[1], group.bounds.value[0], layout);
    await shape({
      content: `<p><strong>${escapeHtml(group.name || '')}</strong></p>`,
      shape: 'round_rectangle',
      x: (topLeft.x + bottomRight.x) / 2,
      y: (topLeft.y + bottomRight.y) / 2,
      width: bottomRight.x - topLeft.x,
      height: bottomRight.y - topLeft.y,
      style: {
        fillColor: group.color || colours.group,
        borderColor: group.borderColor || colours.groupBorder,
        borderWidth: '2',
        fontSize: 48,
        textAlign: 'left',
        fontColor: group.borderColor || colours.groupBorder,
      },
    });
  }

  async renderHighlight(shape, highlight, layout, colours) {
    const pos = WardleyMapRenderer.toPixel(highlight.evolution, highlight.value, layout);
    const diameter = 2 * (highlight.radius || 0.05) * (layout.width - 2 * layout.padding);
    const colour = highlight.color || colours.highlight;
    await shape({
      shape: 'circle', x: pos.x, y: pos.y, width: diameter, height: diameter,
      style: { fillColor: colour, borderColor: colour, borderWidth: '1' },
    });
  }

  async renderComponent(shape, comp, layout, colours) {
    const pos = WardleyMapRenderer.toPixel(comp.evolution, comp.value, layout);
    const type = comp.type || 'activity';
    const dotSize = 16; // small anchor shape that connectors attach to
    const dot = await shape({
      shape: SHAPES[type], x: pos.x, y: pos.y, width: dotSize, height: dotSize,
      style: { fillColor: comp.color || colours.component, borderColor: comp.borderColor || colours.component },
    });

    const labelWidth = Math.max(400, comp.name.length * 30 + 60);
    const offset = comp.labelOffset || { x: labelWidth / 2 + dotSize / 2 + 12, y: 0 };
    await shape({
      content: `<p><strong>${TYPE_SYMBOLS[type]}</strong>  ${escapeHtml(comp.name)}</p>`,
      x: pos.x + (offset.x ?? 0),
      y: pos.y + (offset.y ?? 0),
      width: labelWidth,
      height: 80,
      style: { ...LABEL_STYLE, fontSize: 48, textAlign: 'left', fontColor: colours.component },
    });
    return dot.id;
  }

  async renderMovement(boardId, shape, mov, componentIds, components, layout, colours) {
    const colour = mov.color || colours.movement;
    const from = components.find((c) => c.id === mov.from);
    const arrow = { startCap: 'none', endCap: 'arrow', color: colour, strokeWidth: 3, strokeStyle: 'dashed' };

    let target;
    let endItemId;
    if (mov.to !== undefined) {
      target = components.find((c) => c.id === mov.to);
      endItemId = componentIds.get(mov.to);
    } else {
      // Invisible anchor at the target position, so the arrow has something to point to.
      target = { evolution: from.evolution + (mov.delta ?? DEFAULT_MOVEMENT_DELTA), value: from.value };
      const pos = WardleyMapRenderer.toPixel(target.evolution, target.value, layout);
      const anchor = await shape({
        shape: 'circle', x: pos.x, y: pos.y, width: 10, height: 10,
        style: { fillColor: '#ffffff', borderColor: '#ffffff', borderWidth: '1' },
      });
      endItemId = anchor.id;
    }
    await this.client.createConnector(boardId, { startItemId: componentIds.get(mov.from), endItemId, ...arrow });

    if (mov.label) {
      const mid = WardleyMapRenderer.toPixel(
        (from.evolution + target.evolution) / 2, (from.value + target.value) / 2, layout,
      );
      await shape({
        content: `<p><strong>${escapeHtml(mov.label)}</strong></p>`,
        x: mid.x, y: mid.y + 60, width: Math.max(500, mov.label.length * 22), height: 70,
        style: { ...LABEL_STYLE, fontSize: 36, textAlign: 'center', fontColor: colour },
      });
    }
  }

  async renderAnnotation(shape, ann, layout, colours) {
    const pos = WardleyMapRenderer.toPixel(ann.evolution, ann.value, layout);
    await shape({
      content: `<p><strong>${escapeHtml(ann.text)}</strong></p>`,
      x: pos.x, y: pos.y, width: Math.max(600, ann.text.length * 22), height: 80,
      style: { ...LABEL_STYLE, fontSize: ann.fontSize || 36, textAlign: 'left', fontColor: ann.color || colours.annotation },
    });
  }

  async renderNote(shape, note, layout) {
    const width = 900;
    const height = 500;
    const y = (note.position || 'top-right') === 'top-right' ? layout.padding / 2 + height / 2 : layout.height / 2;
    await shape({
      content: `<p>${escapeHtml(note.text)}</p>`,
      shape: 'round_rectangle',
      x: layout.width - layout.padding / 2 - width / 2,
      y,
      width,
      height,
      style: {
        fillColor: '#f8fafc', borderColor: '#cbd5e1', borderWidth: '1', fontSize: 36, textAlign: 'left', fontColor: '#334155',
      },
    });
  }
}

module.exports = { WardleyMapRenderer, escapeHtml, SHAPES };
