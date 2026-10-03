'use strict';

/**
 * Flag/help contract.
 *
 * `--color` is accepted by the parser but used to appear in neither `--help`
 * nor the README, so the only way to learn that colour can be forced on was to
 * read the source. Both directions are checked here: a flag the parser accepts
 * must be documented, and a flag `--help` documents must parse.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SRC = path.join(__dirname, '..', 'src', 'cli.js');
const BIN = path.join(__dirname, '..', 'bin', 'gitignore-lint.js');

/** Every flag name the argument parser's switch statement handles. */
function parserFlags() {
  const source = fs.readFileSync(SRC, 'utf8');
  const flags = new Set();
  for (const m of source.matchAll(/case '(--[a-z][a-z0-9-]*)'/g)) flags.add(m[1]);
  return [...flags].sort();
}

const help = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' }).stdout;

test('the scanner finds the parser flags it claims to', () => {
  const flags = parserFlags();
  assert.ok(flags.length >= 5, `expected to find the parser's flags, got ${JSON.stringify(flags)}`);
  for (const known of ['--json', '--strict', '--help', '--version']) {
    assert.ok(flags.includes(known), `scanner should find ${known}`);
  }
});

test('every flag the parser accepts is documented in --help', () => {
  const undocumented = parserFlags().filter((flag) => !help.includes(flag));
  assert.deepEqual(undocumented, [], `undocumented but accepted: ${undocumented.join(' ')}`);
});

test('the reverse direction holds: every flag in --help parses', () => {
  const inHelp = [...help.matchAll(/(--[a-z][a-z0-9-]*)/g)].map((m) => m[1]);
  const known = new Set(parserFlags());
  known.add('-h');
  known.add('-v');
  const phantom = [...new Set(inHelp)].filter((flag) => !known.has(flag));
  assert.deepEqual(phantom, [], `documented but not accepted: ${phantom.join(' ')}`);
});

test('--color and --no-color are both documented', () => {
  assert.ok(help.includes('--color'), '--color should be documented');
  assert.ok(help.includes('--no-color'), '--no-color should be documented');
});

test('the binary accepts both colour flags', () => {
  for (const flag of ['--color', '--no-color']) {
    const result = spawnSync(process.execPath, [BIN, '--version', flag], { encoding: 'utf8' });
    assert.doesNotMatch(
      result.stderr,
      /unknown option/,
      `${flag} is documented but the parser rejects it`,
    );
  }
});

test('the README quotes the real --help output verbatim', () => {
  // The README embeds a copy of the usage block, and a copy is a second source
  // of truth that drifts: `--color` was added to --help and left out of the
  // README, which then advertised a flag set the tool no longer had.
  //
  // Compare only the fenced block that quotes the usage text. Comparing the
  // whole README pulls in prose after the block, and `npm test` there reads as
  // a flag the tool must accept.
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  const fence = readme.slice(readme.indexOf('Usage: gitignore-lint'));
  const block = fence.slice(0, fence.indexOf('```', fence.indexOf('\n')));
  const helpOptions = help.slice(help.indexOf('Options:'), help.indexOf('Exit codes:'));
  const flagsIn = (text) => new Set([...text.matchAll(/(?<![-\w])(--[a-z][a-z0-9-]*)/g)]
    .map((m) => m[1]));
  const quotedFlags = flagsIn(block);
  const realFlags = flagsIn(helpOptions);

  const missing = [...realFlags].filter((f) => !quotedFlags.has(f));
  assert.deepEqual(missing, [],
    `README usage block omits: ${missing.join(' ')}`);

  const extra = [...quotedFlags].filter((f) => !realFlags.has(f));
  assert.deepEqual(extra, [],
    `README usage block invents: ${extra.join(' ')}`);
});
