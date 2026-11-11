#!/usr/bin/env node
'use strict';

/**
 * Render a Wardley map YAML file onto a Miro board.
 *
 *   node render-to-miro.js <map.yaml> --dry-run [--plan <file.json>]   no network, no token needed
 *   node render-to-miro.js <map.yaml> --board-id <id>                  draw into an existing board
 *   node render-to-miro.js <map.yaml> --new-board                      create a new (private) board
 *
 * Real runs need MIRO_ACCESS_TOKEN in the environment or in ../.env (see ../.env.example).
 * Exit codes: 0 = done, 1 = invalid map or API error, 2 = usage error.
 */

const fs = require('fs');
const path = require('path');
const { loadMap, MapValidationError } = require('./src/loadMap');
const { MiroClient } = require('./src/miroClient');
const { createDryRunClient, summarise } = require('./src/dryRun');
const { WardleyMapRenderer } = require('./src/wardleyMapRenderer');

const USAGE = 'Usage: node render-to-miro.js <map.yaml> (--dry-run [--plan <file>] | --board-id <id> | --new-board)';

function parseArgs(argv) {
  const opts = { file: null, dryRun: false, newBoard: false, boardId: null, plan: null, quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--new-board') opts.newBoard = true;
    else if (arg === '--quiet') opts.quiet = true;
    else if (arg === '--board-id') opts.boardId = argv[++i];
    else if (arg === '--plan') opts.plan = argv[++i];
    else if (arg.startsWith('--')) throw new Error(`Unknown option ${arg}`);
    else if (!opts.file) opts.file = arg;
    else throw new Error(`Unexpected argument ${arg}`);
  }
  if (!opts.file) throw new Error('Missing map file');
  if (!opts.dryRun && !opts.newBoard && !opts.boardId) throw new Error('Choose --dry-run, --board-id <id> or --new-board');
  if (opts.newBoard && opts.boardId) throw new Error('Use either --board-id or --new-board, not both');
  return opts;
}

function loadEnvFile() {
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath) && typeof process.loadEnvFile === 'function') process.loadEnvFile(envPath);
}

async function main(argv, { env = process.env, out = console.log, err = console.error } = {}) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    err(`${e.message}\n${USAGE}`);
    return 2;
  }

  let mapDef;
  try {
    mapDef = loadMap(opts.file);
  } catch (e) {
    err(e instanceof MapValidationError ? e.message : `Cannot read ${opts.file}: ${e.message}`);
    return 1;
  }
  const log = opts.quiet ? () => {} : (msg) => out(`  ${msg}`);
  out(`Wardley map: ${mapDef.title || '(untitled)'} — ${mapDef.components.length} components`);

  let client;
  if (opts.dryRun) {
    client = createDryRunClient();
  } else {
    if (!env.MIRO_ACCESS_TOKEN) {
      err('MIRO_ACCESS_TOKEN is not set. Copy .env.example to .env and add a token, or use --dry-run.');
      return 1;
    }
    client = new MiroClient(env.MIRO_ACCESS_TOKEN);
  }

  try {
    await client.verifyConnection();
    let boardId = opts.boardId;
    if (opts.newBoard) boardId = (await client.createBoard(mapDef.title || 'Wardley Map')).id;
    if (!boardId) boardId = 'dry-run-board';

    const result = await new WardleyMapRenderer(client, { log }).render(boardId, mapDef);

    if (opts.dryRun) {
      const planFile = opts.plan || path.join('out', `${path.basename(opts.file).replace(/\.ya?ml$/, '')}.miro-plan.json`);
      fs.mkdirSync(path.dirname(planFile), { recursive: true });
      fs.writeFileSync(planFile, `${JSON.stringify({ map: mapDef.title, calls: client.calls }, null, 2)}\n`);
      out(`Dry run: ${client.calls.length} API calls planned, items to create: ${JSON.stringify(summarise(client.calls))}`);
      out(`Plan written to ${planFile}`);
    } else {
      out(`Done. Frame ${result.frameId}, ${result.componentIds.size} components.`);
      out(`Board: https://miro.com/app/board/${boardId}/`);
    }
    return 0;
  } catch (e) {
    err(`Error: ${e.message}`);
    return 1;
  }
}

if (require.main === module) {
  loadEnvFile();
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

module.exports = { main, parseArgs };
