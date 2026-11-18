// Token Radar v3 — entrypoint (Node 22, standard library only).
//
// Reads the sealed snapshot, fits the comps model on the traded protocols,
// prices every pre-token protocol, and writes the board, the dashboard data,
// the dashboard, the screenshots and the dossier into /output (or
// MAKEFUN_OUTPUT_DIR outside the grader). The run is deterministic: the same
// snapshot bytes always produce the same bytes out, so the grader's two runs
// agree.
//
//   MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json|directory>
//
// Layout of the repository this file lives in:
//   main.ts            this file
//   lib/fit.ts         OLS, leave-one-out, bootstrap refits
//   lib/board.ts       snapshot parsing, board building, farm plans
//   vendor/makefun-board.ts  the dossier library, the kit's copy byte for byte
//   dashboard/         index.html + app.css + app.js, no network
//   screenshots/       board.png, detail.png, filtered.png

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardProblem, buildAll, dataScript, parseSnap } from './lib/board.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const root = fileURLToPath(new URL('.', import.meta.url));
const TEXT_CAP = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };

/** Read `--name <value>` / `--name=<value>` out of the arguments. */
function flag(name: string, fallback: string): string {
  const argv = process.argv;
  const at = argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < argv.length) return argv[at + 1]!;
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  return eq === undefined ? fallback : eq.slice(name.length + 3);
}

/** Fail with a message on stderr and a non-zero exit. */
function die(message: string, code = 1): never {
  process.stderr.write(`token-radar-v3: ${message}\n`);
  process.exit(code);
}

const inputArg = flag('input', '/input');
const snapPath = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(snapPath)) {
  die(`no snapshot at ${snapPath}: pass --input <snapshot.json|directory> or mount the sealed /input`, 2);
}
const outDir = flag('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

let snap;
try {
  snap = parseSnap(readFileSync(snapPath, 'utf8'));
} catch (err) {
  die(`cannot read the snapshot: ${err instanceof Error ? err.message : String(err)}`);
}

const data = buildAll(snap);
const problem = boardProblem(data.rows, snap);
if (problem !== null) die(`the board fails the gate: ${problem}`);

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'board.json'), `${JSON.stringify({ rows: data.rows })}\n`);
writeFileSync(join(outDir, 'data.js'), dataScript(data));

/** Copy a directory's plain files into `to`, skipping dot-names. */
function copyDir(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const names: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const src = join(from, name);
    if (!statSync(src).isFile()) continue;
    copyFileSync(src, join(to, name));
    names.push(name);
  }
  return names;
}

const dash = copyDir(join(root, 'dashboard'), join(outDir, 'dashboard'));
const shots = copyDir(join(root, 'screenshots'), join(outDir, 'screenshots'));
if (dash.length === 0) die('dashboard/ is empty: the page must ship with the entry');
if (shots.length < 3) {
  die(`screenshots/ holds ${shots.length} image${shots.length === 1 ? '' : 's'}: hand in 3, the board, a detail view and a filtered view`);
}
const badName = shots.find((n) => !/^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/.test(n));
if (badName !== undefined) die(`screenshots/${badName}: a name is letters, digits and . _ -, 1 to 128 characters`);

try {
  // buildDossier returns the dossier bytes; the file is written here, last,
  // so the scorer can rebuild it from this /output and compare byte for byte.
  writeFileSync(
    join(outDir, 'dossier.json'),
    buildDossier(outDir, {
      text_max_bytes: TEXT_CAP,
      screenshots: SCREENSHOT_CAPS,
      dashboard: { max_files: 400, max_bytes: 4_194_304 },
    }),
  );
} catch (err) {
  die(`the dossier could not be written: ${err instanceof Error ? err.message : String(err)}`);
}

process.stdout.write(
  `token-radar-v3: ${data.boardCount} rows (${data.watchCount} watchlist, ${data.preTokenCount} pre-token of ${data.universeCount}), ` +
    `model ${data.model.version} R²=${data.model.rSquared} LOO median err=${(data.model.looMedianErr * 100).toFixed(1)}%, ` +
    `${dash.length} dashboard files, ${shots.length} screenshots\n`,
);
