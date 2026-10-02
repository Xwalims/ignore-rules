'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { DEFAULTS, parseArgs, run, UsageError } = require('../src/cli.js');

const REPO_ROOT = path.resolve(__dirname, '..');
const BIN = path.join(REPO_ROOT, 'bin', 'gitignore-lint.js');

/** Write a temporary .gitignore and return its path. */
function writeIgnore(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitignore-lint-'));
  const file = path.join(dir, '.gitignore');
  fs.writeFileSync(file, contents, 'utf8');
  return file;
}

/** Run the real binary and capture everything about the run. */
function cli(args, opts = {}) {
  const res = spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    cwd: opts.cwd || REPO_ROOT,
    env: { ...process.env, ...(opts.env || {}) },
  });
  return {
    status: res.status,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    signal: res.signal,
  };
}

test('DEFAULTS is frozen and holds every option default', () => {
  assert.equal(Object.isFrozen(DEFAULTS), true);
  assert.deepEqual(DEFAULTS, {
    json: false,
    color: true,
    strict: false,
    severity: 'info',
    explain: null,
    files: Object.freeze([]),
  });
});

test('parseArgs returns the defaults for no arguments', () => {
  const opts = parseArgs([]);
  assert.equal(opts.json, false);
  assert.equal(opts.color, true);
  assert.equal(opts.strict, false);
  assert.equal(opts.severity, 'info');
  assert.equal(opts.explain, null);
  assert.deepEqual(opts.files, []);
});

test('parseArgs handles every flag, in both spaced and equals form', () => {
  const opts = parseArgs([
    '--json',
    '--strict',
    '--no-color',
    '--severity',
    'warning',
    '--explain',
    '*.log',
    'a',
    'b',
  ]);
  assert.equal(opts.json, true);
  assert.equal(opts.strict, true);
  assert.equal(opts.color, false);
  assert.equal(opts.severity, 'warning');
  assert.equal(opts.explain, '*.log');
  assert.deepEqual(opts.files, ['a', 'b']);

  const eq = parseArgs(['--severity=error', '--explain=build/']);
  assert.equal(eq.severity, 'error');
  assert.equal(eq.explain, 'build/');
});

test('parseArgs rejects an unknown option', () => {
  assert.throws(() => parseArgs(['--nope']), UsageError);
});

test('parseArgs rejects an invalid severity', () => {
  assert.throws(() => parseArgs(['--severity', 'loud']), UsageError);
});

test('parseArgs rejects a flag with a missing value', () => {
  assert.throws(() => parseArgs(['--severity']), UsageError);
  assert.throws(() => parseArgs(['--explain', '--json']), UsageError);
});

test('the bin exits 0 on a clean file', () => {
  const file = writeIgnore('# comment\nnode_modules/\ndist/\n*.log\n!keep.log\n');
  const r = cli([file, '--no-color']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /no problems found/);
});

test('the bin exits 1 when an error-severity diagnostic is present', () => {
  const file = writeIgnore('*.log\n**\n');
  const r = cli([file, '--no-color']);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /shadowed-rule/);
});

test('the bin exits 0 for warnings alone, unless --strict is given', () => {
  const file = writeIgnore('build   \n');

  const plain = cli([file, '--no-color']);
  assert.equal(plain.status, 0, 'a warning does not fail the build');
  assert.match(plain.stdout, /trailing-whitespace/);

  const strict = cli([file, '--no-color', '--strict']);
  assert.equal(strict.status, 1, 'strict turns any diagnostic into a failure');
});

test('--severity filters which diagnostics are shown', () => {
  const file = writeIgnore('build   \n'); // a warning

  const shown = cli([file, '--no-color', '--severity', 'warning']);
  assert.match(shown.stdout, /trailing-whitespace/);

  const hidden = cli([file, '--no-color', '--severity', 'error']);
  assert.doesNotMatch(hidden.stdout, /trailing-whitespace/);
  assert.equal(hidden.status, 0);
});

test('the output carries the file, line, severity, code and a fix', () => {
  const file = writeIgnore('build   \n');
  const r = cli([file, '--no-color']);
  assert.match(r.stdout, new RegExp(`.gitignore:1`));
  assert.match(r.stdout, /warning/);
  assert.match(r.stdout, /trailing-whitespace/);
  assert.match(r.stdout, /fix:/);
});

test('--json emits parseable JSON with the documented shape', () => {
  const file = writeIgnore('*.log\n**\n');
  const r = cli([file, '--json']);
  assert.equal(r.status, 1);

  const data = JSON.parse(r.stdout);
  assert.equal(data.ok, false);
  assert.equal(data.exitCode, 1);
  assert.equal(data.files.length, 1);
  assert.equal(data.files[0].file, file);

  const d = data.files[0].diagnostics.find((x) => x.code === 'shadowed-rule');
  assert.ok(d, 'expected a shadowed-rule diagnostic');
  assert.equal(d.severity, 'error');
  assert.equal(typeof d.line, 'number');
  assert.equal(typeof d.message, 'string');
});

test('--json reports ok for a clean file', () => {
  const file = writeIgnore('node_modules/\n');
  const r = cli([file, '--json']);
  assert.equal(r.status, 0);
  const data = JSON.parse(r.stdout);
  assert.equal(data.ok, true);
  assert.deepEqual(data.files[0].diagnostics, []);
});

test('several files are linted in one run', () => {
  const a = writeIgnore('!orphan\n');
  const b = writeIgnore('build \n');
  const r = cli([a, b, '--no-color']);
  assert.equal(r.status, 1, 'an error-severity diagnostic in one file fails the run');
  assert.match(r.stdout, /never-matches/);
  assert.match(r.stdout, /trailing-whitespace/);
});

test('--explain shows every rule considered, in order, and the verdict', () => {
  const file = writeIgnore('*.log\n!important.log\n');
  const r = cli([file, '--no-color', '--explain', 'build/'], { cwd: REPO_ROOT });
  assert.equal(r.status, 0, r.stdout + r.stderr);

  assert.match(r.stdout, /pattern: build\//, 'names the pattern under test');
  assert.match(r.stdout, /README\.md/, 'resolves sample paths');
  assert.match(r.stdout, /ignored|tracked/, 'gives a verdict per path');
  assert.match(r.stdout, /^why$/m, 'explains why');
  assert.match(r.stdout, /last matching rule|parent directory|no rule matches/);
});

test('--explain --json includes every rule considered for each path', () => {
  // A comment and a blank line are present so the trace has to show them too.
  const file = writeIgnore('# logs\n*.log\n\n!important.log\n');
  const r = cli([file, '--json', '--explain', 'build/']);
  assert.equal(r.status, 0, r.stdout + r.stderr);

  const data = JSON.parse(r.stdout);
  assert.ok(Array.isArray(data.explanations), 'has an explanations array');
  assert.equal(data.explanations.length, 1);
  assert.equal(data.explanations[0].pattern, 'build/');

  const results = data.explanations[0].results;
  assert.ok(results.length > 0, 'resolves sample paths');

  const withRules = results.find((x) => x.considered.length > 0);
  assert.ok(withRules, 'each result lists the rules considered');

  // The real file rules keep their order; the pattern under test is appended
  // last and carries no line number. Comments and blank lines are kept so that
  // every line of the file appears in the trace.
  const real = withRules.considered.filter((c) => !c.synthetic);
  assert.deepEqual(real.map((c) => c.line), [1, 2, 3, 4, 5], 'every line, in file order');

  const synthetic = withRules.considered.filter((c) => c.synthetic);
  assert.equal(synthetic.length, 1, 'the pattern under test is listed once');
  assert.equal(synthetic[0].line, null, 'and has no line number of its own');

  assert.ok(withRules.considered.some((c) => c.action === 'comment'));
  assert.ok(withRules.considered.some((c) => typeof c.matched === 'boolean'));
});

test('--explain demonstrates the parent-directory rule', () => {
  const file = writeIgnore('node_modules\n');
  const r = cli([file, '--json', '--explain', '!keep.txt']);
  assert.equal(r.status, 0, r.stdout + r.stderr);

  const data = JSON.parse(r.stdout);
  const results = data.explanations[0].results;

  const nested = results.find((x) => x.path.includes('node_modules/'));
  assert.ok(nested, 'samples include a path inside node_modules');
  assert.equal(nested.ignored, true);
  assert.equal(nested.blockingAncestor, 'node_modules');
  assert.match(nested.reason, /parent directory "node_modules" is excluded/);
});

test('a missing file is a usage/IO error with exit code 2', () => {
  const r = cli([path.join(REPO_ROOT, 'does-not-exist'), '--no-color']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /cannot read/);
});

test('an unknown option exits 2 and prints usage', () => {
  const r = cli(['--nope']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown option/);
  assert.match(r.stderr, /Usage: gitignore-lint/);
});

test('no input files exits 2', () => {
  const r = cli([]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no input files/);
});

test('--help exits 0 and documents the options', () => {
  const r = cli(['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage: gitignore-lint/);
  for (const flag of ['--json', '--severity', '--explain', '--no-color', '--strict']) {
    assert.match(r.stdout, new RegExp(flag.replace(/-/g, '\\-')), `documents ${flag}`);
  }
  assert.match(r.stdout, /Exit codes:/);
});

test('--version prints the package version', () => {
  const r = cli(['--version']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), require('../package.json').version);
});

test('the bin sets a non-zero exit code on stderr for failures', () => {
  // Guards the regression where a missing `process.exitCode` assignment makes
  // every failure exit 0.
  const file = writeIgnore('*.log\n**\n');
  const r = cli([file, '--no-color']);
  assert.notEqual(r.status, 0, 'must not exit 0 on failure');
  assert.equal(r.signal, null, 'exited normally rather than being killed');
});

test('run() returns an exit code without touching the real process', () => {
  const file = writeIgnore('*.log\n**\n');
  const chunks = [];
  const code = run([file, '--no-color'], {
    stdout: { write: (s) => chunks.push(s), isTTY: false },
    stderr: { write: () => {} },
  });
  assert.equal(code, 1);
  assert.ok(chunks.join('').includes('shadowed-rule'));
});

test('the linter is clean on its own .gitignore', () => {
  const r = cli([path.join(REPO_ROOT, '.gitignore'), '--strict', '--no-color']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('colour is emitted only when stdout is a TTY', () => {
  const file = writeIgnore('build   \n');

  const plain = cli([file]); // spawnSync pipes stdout, so not a TTY
  assert.doesNotMatch(plain.stdout, /\[/, 'no ANSI codes when piped');

  const chunks = [];
  run([file], {
    stdout: { write: (s) => chunks.push(s), isTTY: true },
    stderr: { write: () => {} },
  });
  assert.match(chunks.join(''), /\[/, 'ANSI codes when stdout is a TTY');
});