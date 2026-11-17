// Token Launch Radar v3 — the program the grader runs (Node 22, stdlib only).
//
// It reads the sealed snapshot, fits the radar-4 comps model in lib/model.ts,
// and writes the ranked board, the dashboard's data, the page itself, the
// screenshots and the dossier into the output directory. Every run writes the
// same bytes: the model fits from the snapshot alone, the bootstrap is seeded,
// and nothing here reads the clock or the network.
//
// Local run:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

/** The repository root, from this file's own location: never the working directory. */
const ROOT = fileURLToPath(new URL('.', import.meta.url));

/** The dossier's text cap, and the screenshot and dashboard caps the scorer refuses past. */
const DOSSIER_TEXT_BYTES = 65_536;
const SHOT_LIMIT = { max: 4, max_bytes: 524_288 };
const DASH_LIMIT = { max_files: 400, max_bytes: 4_194_304 };
const PLAIN_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** Read `--flag value` or `--flag=value` from the arguments, else the fallback. */
function flag(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const glued = process.argv.find((a) => a.startsWith(`--${name}=`));
  return glued === undefined ? fallback : glued.slice(name.length + 3);
}

function fail(message: string): never {
  process.stderr.write(`token-radar-01-v3: ${message}\n`);
  process.exit(1);
}

const inputGiven = flag('input', '/input');
const snapshotPath = inputGiven.endsWith('.json') ? inputGiven : join(inputGiven, 'snapshot.json');
if (!existsSync(snapshotPath)) {
  fail(`no snapshot at ${snapshotPath}: pass --input <snapshot.json|directory>`);
}
const outDir = flag('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(snapshotPath, 'utf8'));
const { board, radar } = buildRadar(snapshot);
const problem = boardIssue(board, snapshot);
if (problem !== null) fail(`the model wrote a board the gate refuses: ${problem}`);

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(outDir, 'data.js'), dataScript(radar));

/** Copy a directory's plain files into a fresh directory, dot-names skipped. Returns the names copied. */
function copyPlainFiles(fromDir: string, toDir: string): string[] {
  if (!existsSync(fromDir)) return [];
  mkdirSync(toDir, { recursive: true });
  const names: string[] = [];
  for (const name of readdirSync(fromDir)) {
    if (name.startsWith('.')) continue;
    if (!statSync(join(fromDir, name)).isFile()) continue;
    copyFileSync(join(fromDir, name), join(toDir, name));
    names.push(name);
  }
  return names;
}

const pageFiles = copyPlainFiles(join(ROOT, 'dashboard'), join(outDir, 'dashboard'));
const shotFiles = copyPlainFiles(join(ROOT, 'screenshots'), join(outDir, 'screenshots'));
if (pageFiles.length === 0) fail('dashboard/ holds no files to hand in');
if (shotFiles.length < 3) fail(`screenshots/ holds ${shotFiles.length} images: hand in 3, the board, a detail view and a filtered view`);
for (const name of shotFiles) {
  if (!PLAIN_NAME.test(name)) fail(`screenshots/${name}: names are letters, digits and . _ -, 1 to 128 characters`);
}

// The dossier goes last: the scorer rebuilds it from this output and compares bytes.
writeFileSync(
  join(outDir, 'dossier.json'),
  buildDossier(outDir, { text_max_bytes: DOSSIER_TEXT_BYTES, screenshots: SHOT_LIMIT, dashboard: DASH_LIMIT }),
);

const v = radar.validation;
process.stdout.write(
  `radar-4: ${snapshot.protocols.length} protocols, ${radar.model.comps} comps, ${board.length} rows (${radar.earlySize} early, ${radar.watchlistCount} watchlist)\n` +
    `radar-4: validation LOO x${v.loo.toFixed(2)} (flat x${v.flatLoo.toFixed(2)}), time-split x${v.oos.toFixed(2)}, 5-fold x${v.cv5.toFixed(2)}\n` +
    `radar-4: wrote ${join(outDir, 'board.json')}, data.js, dashboard/ (${pageFiles.length} files), screenshots/ (${shotFiles.length} images), dossier.json\n`,
);
