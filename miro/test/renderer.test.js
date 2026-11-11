'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadMap } = require('../src/loadMap');
const { createDryRunClient, summarise } = require('../src/dryRun');
const { WardleyMapRenderer, escapeHtml } = require('../src/wardleyMapRenderer');
const { main } = require('../render-to-miro');

const MAPS = path.join(__dirname, '..', '..', 'maps');
const BIKE = path.join(MAPS, 'bike-repair-service.yaml');
const QUIZ = path.join(MAPS, 'quiz-tea-stall.yaml');

test('toPixel maps corners of the map area', () => {
  const layout = { width: 1000, height: 800, padding: 100 };
  assert.deepEqual(WardleyMapRenderer.toPixel(0, 1, layout), { x: 100, y: 100 });
  assert.deepEqual(WardleyMapRenderer.toPixel(1, 0, layout), { x: 900, y: 700 });
});

test('dry run of the example map plans the expected items', async () => {
  const mapDef = loadMap(BIKE);
  const client = createDryRunClient();
  const result = await new WardleyMapRenderer(client).render('board-1', mapDef);
  const counts = summarise(client.calls);

  const deltaMovements = mapDef.movements.filter((m) => m.to === undefined).length;
  const labelledMovements = mapDef.movements.filter((m) => m.label).length;
  // axes: 2 bars + 4 labels; stages: 4 labels + 3 dividers
  const expectedShapes = 6 + 4 + 3
    + mapDef.groups.length + mapDef.highlights.length
    + 2 * mapDef.components.length
    + deltaMovements + labelledMovements
    + mapDef.annotations.length + mapDef.notes.length;

  assert.equal(counts.frames, 1);
  assert.equal(counts.shapes, expectedShapes);
  assert.equal(counts.connectors, mapDef.dependencies.length + mapDef.movements.length);
  assert.equal(result.componentIds.size, mapDef.components.length);
});

test('all shapes are parented to the frame and placed inside it', async () => {
  const mapDef = loadMap(BIKE);
  const client = createDryRunClient();
  const { frameId } = await new WardleyMapRenderer(client).render('board-1', mapDef);
  const shapes = client.calls.filter((c) => c.path.endsWith('/shapes'));
  for (const call of shapes) {
    assert.equal(call.body.parent.id, frameId);
    assert.ok(call.body.position.x >= 0 && call.body.position.x <= mapDef.layout.width, 'x inside frame');
    assert.ok(call.body.position.y >= 0 && call.body.position.y <= mapDef.layout.height, 'y inside frame');
  }
});

test('connectors only reference items created before them', async () => {
  const client = createDryRunClient();
  await new WardleyMapRenderer(client).render('board-1', loadMap(QUIZ));
  const created = new Set();
  for (const call of client.calls) {
    if (call.path.endsWith('/connectors')) {
      assert.ok(created.has(call.body.startItem.id));
      assert.ok(created.has(call.body.endItem.id));
    }
    created.add(call.result.id);
  }
});

test('component names are HTML-escaped', async () => {
  assert.equal(escapeHtml('<R&D> "lab"'), '&lt;R&amp;D&gt; &quot;lab&quot;');
  const mapDef = loadMap(QUIZ);
  mapDef.components[0].name = 'Tea & <cake>';
  const client = createDryRunClient();
  await new WardleyMapRenderer(client).render('board-1', mapDef);
  const labels = client.calls.map((c) => c.body?.data?.content || '').join('\n');
  assert.match(labels, /Tea &amp; &lt;cake&gt;/);
  assert.doesNotMatch(labels, /<cake>/);
});

test('CLI dry run writes a plan without network or token', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wardley-'));
  const plan = path.join(dir, 'plan.json');
  const lines = [];
  const code = await main([QUIZ, '--dry-run', '--plan', plan, '--quiet'], {
    env: {}, out: (l) => lines.push(l), err: (l) => lines.push(l),
  });
  assert.equal(code, 0);
  const written = JSON.parse(fs.readFileSync(plan, 'utf8'));
  assert.ok(written.calls.length > 10);
  assert.match(lines.join('\n'), /Plan written to/);
});

test('CLI refuses a real run without token', async () => {
  const errors = [];
  const code = await main([QUIZ, '--new-board'], { env: {}, out: () => {}, err: (l) => errors.push(l) });
  assert.equal(code, 1);
  assert.match(errors.join('\n'), /MIRO_ACCESS_TOKEN is not set/);
});

test('CLI usage errors exit with 2', async () => {
  const silent = { env: {}, out: () => {}, err: () => {} };
  assert.equal(await main([QUIZ], silent), 2);
  assert.equal(await main([], silent), 2);
  assert.equal(await main([QUIZ, '--board-id', 'x', '--new-board'], silent), 2);
});

test('CLI reports invalid maps with exit code 1', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wardley-'));
  const bad = path.join(dir, 'bad.yaml');
  fs.writeFileSync(bad, 'components:\n  - {id: a, name: A, evolution: 2, value: 0.5}\n');
  const errors = [];
  const code = await main([bad, '--dry-run'], { env: {}, out: () => {}, err: (l) => errors.push(l) });
  assert.equal(code, 1);
  assert.match(errors.join('\n'), /must be between 0 and 1/);
});
