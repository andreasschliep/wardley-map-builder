'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { loadMap, validateMap, MapValidationError } = require('../src/loadMap');

const MAPS = path.join(__dirname, '..', '..', 'maps');

const minimalMap = () => ({
  title: 'Minimal',
  components: [
    { id: 'user', name: 'User', evolution: 0.5, value: 0.9 },
    { id: 'service', name: 'Service', evolution: 0.4, value: 0.5 },
  ],
  dependencies: [{ from: 'user', to: 'service' }],
});

function problemsOf(mapDef) {
  try {
    validateMap(mapDef);
  } catch (err) {
    assert.ok(err instanceof MapValidationError);
    return err.problems;
  }
  return [];
}

test('example maps are valid', () => {
  for (const file of ['bike-repair-service.yaml', 'quiz-tea-stall.yaml']) {
    const mapDef = loadMap(path.join(MAPS, file));
    assert.ok(mapDef.components.length > 0, file);
  }
});

test('minimal map is valid', () => {
  assert.deepEqual(problemsOf(minimalMap()), []);
});

test('evolution outside 0..1 is rejected', () => {
  const mapDef = minimalMap();
  mapDef.components[0].evolution = 1.2;
  assert.match(problemsOf(mapDef).join('\n'), /component 'user'\.evolution must be between 0 and 1, got 1\.2/);
});

test('unknown dependency target is named', () => {
  const mapDef = minimalMap();
  mapDef.dependencies.push({ from: 'user', to: 'databse' });
  assert.match(problemsOf(mapDef).join('\n'), /dependencies\[1\]\.to refers to unknown component "databse"/);
});

test('duplicate ids and unknown types are rejected', () => {
  const mapDef = minimalMap();
  mapDef.components.push({ ...mapDef.components[0] });
  mapDef.components[1].type = 'service';
  const problems = problemsOf(mapDef).join('\n');
  assert.match(problems, /id 'user' is used more than once/);
  assert.match(problems, /type must be one of activity, practice, data, knowledge/);
});

test('movement must stay on the map', () => {
  const mapDef = minimalMap();
  mapDef.movements = [{ from: 'user', delta: 0.7 }];
  assert.match(problemsOf(mapDef).join('\n'), /ends at evolution 1\.20, outside 0\.\.1/);
});

test('all problems are reported together', () => {
  const mapDef = minimalMap();
  mapDef.components[0].color = 'red';
  mapDef.groups = [{ name: 'G', bounds: { evolution: [0.6, 0.2], value: [0.1, 0.3] } }];
  const problems = problemsOf(mapDef);
  assert.equal(problems.length, 2);
});

test('non-mapping input is rejected', () => {
  assert.throws(() => validateMap(['a']), /must be a YAML mapping/);
});
