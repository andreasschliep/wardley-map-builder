'use strict';

/**
 * Load and validate a Wardley map YAML file.
 * Mirrors the rules of the Python renderer (wardley_map/model.py) so a map
 * that renders to PNG also renders to Miro.
 */

const fs = require('fs');
const yaml = require('js-yaml');

const COMPONENT_TYPES = ['activity', 'practice', 'data', 'knowledge'];
const NOTE_POSITIONS = ['top-right', 'right'];
const DEFAULT_STAGES = [
  ['Genesis', ''],
  ['Custom-Built', ''],
  ['Product (+rental)', ''],
  ['Commodity (+utility)', ''],
];
const DEFAULT_LAYOUT = { width: 8000, height: 6000, padding: 400, componentSize: 30 };
const DEFAULT_MOVEMENT_DELTA = 0.1;
const HEX_COLOUR = /^#[0-9a-fA-F]{6}$/;

class MapValidationError extends Error {
  constructor(problems, source) {
    const heading = `Invalid map definition${source ? ` in ${source}` : ''}:`;
    super([heading, ...problems.map((p) => `  - ${p}`)].join('\n'));
    this.name = 'MapValidationError';
    this.problems = problems;
  }
}

const isNumber = (v) => typeof v === 'number' && Number.isFinite(v);
const isMapping = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const show = (v) => JSON.stringify(v);

function unit(value, where, problems) {
  if (!isNumber(value)) {
    problems.push(`${where} must be a number between 0 and 1, got ${show(value)}`);
    return false;
  }
  if (value < 0 || value > 1) {
    problems.push(`${where} must be between 0 and 1, got ${value}`);
    return false;
  }
  return true;
}

function range(value, where, problems) {
  if (!Array.isArray(value) || value.length !== 2) {
    problems.push(`${where} must be a list [min, max]`);
    return;
  }
  const ok = value.map((v, i) => unit(v, `${where}[${i}]`, problems));
  if (ok.every(Boolean) && value[0] >= value[1]) {
    problems.push(`${where} must have min < max, got ${show(value)}`);
  }
}

function colour(value, where, problems) {
  if (value !== undefined && !(typeof value === 'string' && HEX_COLOUR.test(value))) {
    problems.push(`${where} must be a hex colour like '#1a1a1a', got ${show(value)}`);
  }
}

function list(mapDef, key, problems) {
  const value = mapDef[key];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    problems.push(`'${key}' must be a list`);
    return [];
  }
  return value;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Validate a parsed map definition. Throws MapValidationError listing all problems.
 * @param {unknown} mapDef
 * @param {string} [source]
 */
function validateMap(mapDef, source) {
  if (!isMapping(mapDef)) throw new MapValidationError(['the map definition must be a YAML mapping'], source);
  const problems = [];

  if (mapDef.layout !== undefined) {
    if (!isMapping(mapDef.layout)) problems.push("'layout' must be a mapping");
    else {
      for (const key of ['width', 'height', 'padding', 'componentSize']) {
        if (key in mapDef.layout && !(isNumber(mapDef.layout[key]) && mapDef.layout[key] > 0)) {
          problems.push(`layout.${key} must be a positive number, got ${show(mapDef.layout[key])}`);
        }
      }
      const l = { ...DEFAULT_LAYOUT, ...mapDef.layout };
      if ([l.width, l.height, l.padding].every(isNumber) && 2 * l.padding >= Math.min(l.width, l.height)) {
        problems.push('layout.padding is too large for the layout width/height');
      }
    }
  }

  const stages = mapDef.axes?.x?.stages;
  if (stages !== undefined) {
    if (!Array.isArray(stages) || stages.length !== 4) {
      problems.push('axes.x.stages must list exactly four stages (Genesis to Commodity)');
    } else {
      stages.forEach((s, i) => {
        const ok = typeof s === 'string'
          || (Array.isArray(s) && s.length >= 1 && s.length <= 2 && s.every((p) => typeof p === 'string'));
        if (!ok) problems.push(`axes.x.stages[${i}] must be a name or [name, subtitle]`);
      });
    }
  }

  let components = mapDef.components;
  if (!Array.isArray(components) || components.length === 0) {
    problems.push("'components' must be a non-empty list");
    components = [];
  }

  const positions = new Map();
  components.forEach((comp, i) => {
    let where = `components[${i}]`;
    if (!isMapping(comp)) {
      problems.push(`${where} must be a mapping`);
      return;
    }
    const id = comp.id;
    let register = false;
    if (!nonEmptyString(id)) problems.push(`${where}.id must be a non-empty string`);
    else if (positions.has(id)) problems.push(`${where}.id '${id}' is used more than once`);
    else {
      where = `component '${id}'`;
      register = true;
    }
    if (!nonEmptyString(comp.name)) problems.push(`${where}.name must be a non-empty string`);
    const type = comp.type ?? 'activity';
    if (!COMPONENT_TYPES.includes(type)) {
      problems.push(`${where}.type must be one of ${COMPONENT_TYPES.join(', ')}, got ${show(type)}`);
    }
    const okEvo = unit(comp.evolution, `${where}.evolution`, problems);
    const okVal = unit(comp.value, `${where}.value`, problems);
    colour(comp.color, `${where}.color`, problems);
    colour(comp.borderColor, `${where}.borderColor`, problems);
    if (comp.labelOffset !== undefined
      && !(isMapping(comp.labelOffset) && ['x', 'y'].every((k) => isNumber(comp.labelOffset[k] ?? 0)))) {
      problems.push(`${where}.labelOffset must be a mapping with numeric x and y`);
    }
    if (register) positions.set(id, { evolution: okEvo ? comp.evolution : 0, value: okVal ? comp.value : 0 });
  });

  const known = (id, where) => {
    if (positions.has(id)) return true;
    problems.push(`${where} refers to unknown component ${show(id)}`);
    return false;
  };

  list(mapDef, 'dependencies', problems).forEach((dep, i) => {
    const where = `dependencies[${i}]`;
    if (!isMapping(dep)) return problems.push(`${where} must be a mapping`);
    known(dep.from, `${where}.from`);
    known(dep.to, `${where}.to`);
    colour(dep.color, `${where}.color`, problems);
    return undefined;
  });

  list(mapDef, 'movements', problems).forEach((mov, i) => {
    const where = `movements[${i}]`;
    if (!isMapping(mov)) return problems.push(`${where} must be a mapping`);
    const startKnown = known(mov.from, `${where}.from`);
    if ('to' in mov) known(mov.to, `${where}.to`);
    else {
      const delta = mov.delta ?? DEFAULT_MOVEMENT_DELTA;
      if (!isNumber(delta)) problems.push(`${where}.delta must be a number, got ${show(delta)}`);
      else if (startKnown) {
        const target = positions.get(mov.from).evolution + delta;
        if (target < 0 || target > 1) {
          problems.push(`${where}: '${mov.from}' moved by ${delta} ends at evolution ${target.toFixed(2)}, outside 0..1`);
        }
      }
    }
    colour(mov.color, `${where}.color`, problems);
    return undefined;
  });

  list(mapDef, 'groups', problems).forEach((grp, i) => {
    const where = `groups[${i}]`;
    if (!isMapping(grp)) return problems.push(`${where} must be a mapping`);
    if (!isMapping(grp.bounds)) problems.push(`${where}.bounds must contain 'evolution' and 'value' ranges`);
    else {
      range(grp.bounds.evolution, `${where}.bounds.evolution`, problems);
      range(grp.bounds.value, `${where}.bounds.value`, problems);
    }
    colour(grp.color, `${where}.color`, problems);
    colour(grp.borderColor, `${where}.borderColor`, problems);
    return undefined;
  });

  list(mapDef, 'highlights', problems).forEach((hl, i) => {
    const where = `highlights[${i}]`;
    if (!isMapping(hl)) return problems.push(`${where} must be a mapping`);
    unit(hl.evolution, `${where}.evolution`, problems);
    unit(hl.value, `${where}.value`, problems);
    const radius = hl.radius ?? 0.05;
    if (!(isNumber(radius) && radius > 0 && radius <= 0.5)) {
      problems.push(`${where}.radius must be a number in (0, 0.5], got ${show(radius)}`);
    }
    colour(hl.color, `${where}.color`, problems);
    return undefined;
  });

  list(mapDef, 'annotations', problems).forEach((ann, i) => {
    const where = `annotations[${i}]`;
    if (!isMapping(ann)) return problems.push(`${where} must be a mapping`);
    if (!nonEmptyString(ann.text)) problems.push(`${where}.text must be a non-empty string`);
    unit(ann.evolution, `${where}.evolution`, problems);
    unit(ann.value, `${where}.value`, problems);
    colour(ann.color, `${where}.color`, problems);
    return undefined;
  });

  list(mapDef, 'notes', problems).forEach((note, i) => {
    const where = `notes[${i}]`;
    if (!isMapping(note)) return problems.push(`${where} must be a mapping`);
    if (!nonEmptyString(note.text)) problems.push(`${where}.text must be a non-empty string`);
    const position = note.position ?? 'top-right';
    if (!NOTE_POSITIONS.includes(position)) {
      problems.push(`${where}.position must be one of ${NOTE_POSITIONS.join(', ')}, got ${show(position)}`);
    }
    return undefined;
  });

  if (problems.length) throw new MapValidationError(problems, source);
}

/** Read and validate a YAML map file. */
function loadMap(file) {
  const mapDef = yaml.load(fs.readFileSync(file, 'utf8'));
  validateMap(mapDef, file);
  return mapDef;
}

module.exports = {
  COMPONENT_TYPES,
  DEFAULT_LAYOUT,
  DEFAULT_MOVEMENT_DELTA,
  DEFAULT_STAGES,
  MapValidationError,
  loadMap,
  validateMap,
};
