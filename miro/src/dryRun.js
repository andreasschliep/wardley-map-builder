'use strict';

/**
 * Dry-run support: a MiroClient whose fetch records every request instead of
 * sending it. The recorded plan contains the exact payloads a real run would
 * send, so it doubles as a review artefact and as a test fixture.
 */

const { MiroClient } = require('./miroClient');

function createDryRunClient() {
  const calls = [];
  let counter = 0;

  const recordingFetch = async (url, init) => {
    counter += 1;
    const id = `dry-run-${counter}`;
    const { pathname, search } = new URL(url);
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method, path: `${pathname.replace(/^\/v2/, '')}${search}`, body, result: { id } });
    const result = init.method === 'POST' && pathname.endsWith('/boards')
      ? { id, viewLink: 'about:blank#dry-run' }
      : { id };
    return new Response(JSON.stringify(result), { status: 201, headers: { 'content-type': 'application/json' } });
  };

  const client = new MiroClient('dry-run-token', { fetch: recordingFetch, requestDelayMs: 0 });
  client.calls = calls;
  return client;
}

/** Count the items a run would create, per type (boards, frames, shapes, connectors). */
function summarise(calls) {
  const summary = {};
  for (const call of calls.filter((c) => c.method === 'POST')) {
    const type = call.path.split('?')[0].split('/').pop();
    summary[type] = (summary[type] || 0) + 1;
  }
  return summary;
}

module.exports = { createDryRunClient, summarise };
