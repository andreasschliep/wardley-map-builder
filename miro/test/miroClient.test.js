'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MiroClient, MiroApiError, MAX_BOARD_NAME } = require('../src/miroClient');

/** Fake fetch answering with queued responses; records every request. */
function fakeFetch(responses) {
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    const { status = 200, body = { id: 'item-1' }, headers = {} } = next || {};
    return new Response(JSON.stringify(body), { status, headers });
  };
  return { fetch, requests };
}

/** Fake clock: sleep advances time instead of waiting. */
function fakeClock() {
  let now = 1000;
  const sleeps = [];
  return {
    now: () => now,
    sleep: async (ms) => { sleeps.push(ms); now += ms; },
    sleeps,
  };
}

function client(responses, options = {}) {
  const { fetch, requests } = fakeFetch(responses);
  const clock = fakeClock();
  const miro = new MiroClient('test-token', {
    fetch, now: clock.now, sleep: clock.sleep, warn: () => {}, retryBaseDelayMs: 100, ...options,
  });
  return { miro, requests, clock };
}

test('requires an access token', () => {
  assert.throws(() => new MiroClient(''), /MIRO_ACCESS_TOKEN/);
});

test('sends bearer token and JSON payload', async () => {
  const { miro, requests } = client([{ status: 201, body: { id: 'frame-1' } }]);
  const frame = await miro.createFrame('board-1', { title: 'Map', x: 0, y: 0, width: 800, height: 600 });
  assert.equal(frame.id, 'frame-1');
  assert.equal(requests[0].url, 'https://api.miro.com/v2/boards/board-1/frames');
  assert.equal(requests[0].init.headers.Authorization, 'Bearer test-token');
  assert.deepEqual(requests[0].body.geometry, { width: 800, height: 600 });
});

test('spaces requests out to respect the rate limit', async () => {
  const { miro, clock } = client([{}, {}], { requestDelayMs: 650 });
  await miro.verifyConnection();
  await miro.verifyConnection();
  assert.deepEqual(clock.sleeps, [650]);
});

test('retries 500 with backoff, then succeeds', async () => {
  const { miro, requests, clock } = client([{ status: 500 }, { status: 502 }, { status: 201 }], { requestDelayMs: 0 });
  const result = await miro.createShape('b', { x: 1, y: 2, width: 3, height: 4 });
  assert.equal(result.id, 'item-1');
  assert.equal(requests.length, 3);
  assert.deepEqual(clock.sleeps, [100, 200]);
});

test('honours Retry-After on 429', async () => {
  const { miro, clock } = client([{ status: 429, headers: { 'retry-after': '3' } }, {}], { requestDelayMs: 0 });
  await miro.verifyConnection();
  assert.deepEqual(clock.sleeps, [3000]);
});

test('retries network errors', async () => {
  const { miro, requests } = client([new TypeError('fetch failed'), {}], { requestDelayMs: 0 });
  await miro.verifyConnection();
  assert.equal(requests.length, 2);
});

test('does not retry other 4xx errors', async () => {
  const { miro, requests } = client([{ status: 400, body: { message: 'bad shape' } }], { requestDelayMs: 0 });
  await assert.rejects(miro.createShape('b', { x: 0, y: 0, width: 1, height: 1 }), (err) => {
    assert.ok(err instanceof MiroApiError);
    assert.equal(err.status, 400);
    assert.match(err.message, /bad shape/);
    return true;
  });
  assert.equal(requests.length, 1);
});

test('gives up after maxAttempts', async () => {
  const { miro, requests } = client([{ status: 503 }, { status: 503 }, { status: 503 }], {
    requestDelayMs: 0, maxAttempts: 3,
  });
  await assert.rejects(miro.verifyConnection(), /failed with 503/);
  assert.equal(requests.length, 3);
});

test('board names are cut to the Miro maximum', async () => {
  const { miro, requests } = client([{ status: 201 }]);
  await miro.createBoard('x'.repeat(80));
  assert.equal(requests[0].body.name.length, MAX_BOARD_NAME);
  assert.equal(requests[0].body.policy, undefined, 'keeps Miro default (private) sharing');
});

test('connector caps are mapped to API values', async () => {
  const { miro, requests } = client([{ status: 201 }]);
  await miro.createConnector('b', { startItemId: '1', endItemId: '2', endCap: 'arrow', strokeStyle: 'dashed' });
  assert.equal(requests[0].body.style.endStrokeCap, 'stealth');
  assert.equal(requests[0].body.style.strokeStyle, 'dashed');
});
