'use strict';

/**
 * Differential test: the matcher must agree with REAL git.
 *
 * The pure-logic tests in matcher.test.js encode this project's reading of the
 * spec. This file checks that reading against `git check-ignore` itself, so a
 * misreading of the rules cannot survive as a "verified" behaviour.
 *
 * git is the authority here, not the project's own tests. Two rules in
 * particular are easy to get backwards:
 *
 *   1. `logs/` followed by `!logs/keep.log` does NOT re-include the file. Once
 *      a parent directory is excluded, git does not descend into it, so no
 *      negation inside can win.
 *   2. `build/*` DOES exclude `build/a/b.txt` -- not because `*` crosses the
 *      slash, but because `build/a` is itself excluded and everything beneath
 *      an excluded directory is excluded too.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parsePattern, createMatcher } = require('../src/index.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ignore-rules-git-'));

/**
 * Build a throwaway repository and ask git itself what it ignores.
 *
 * @param {string[]} rules .gitignore contents.
 * @param {string[]} paths paths to materialise inside the repo.
 * @returns {Record<string, boolean>} true when git ignores the path.
 */
function gitSays(rules, paths) {
  const dir = path.join(TMP, `r${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  const run = (args) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  run(['init', '-q']);
  run(['config', 'user.email', 'test@example.invalid']);
  run(['config', 'user.name', 'test']);

  for (const p of paths) {
    const full = path.join(dir, p);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, 'x\n');
  }
  fs.writeFileSync(path.join(dir, '.gitignore'), `${rules.join('\n')}\n`);

  const result = {};
  for (const p of paths) {
    try {
      run(['check-ignore', '-q', '--', p]);
      result[p] = true;
    } catch {
      result[p] = false;
    }
  }
  return result;
}

/**
 * This project's verdict for the same inputs.
 *
 * @param {string[]} rules
 * @param {string} target
 * @returns {boolean}
 */
function matcherSays(rules, target) {
  return createMatcher(rules.map(parsePattern)).ignore(target, false);
}

const CASES = [
  {
    name: 'an excluded directory cannot be re-included from inside it',
    rules: ['logs/', '!logs/keep.log'],
    paths: ['logs/keep.log', 'logs/other.log'],
  },
  {
    name: 'star does not cross a slash, but the excluded child directory still wins',
    rules: ['build/*'],
    paths: ['build/x.txt', 'build/a/b.txt'],
  },
  {
    name: 'double star crosses slashes at any depth',
    rules: ['build/**'],
    paths: ['build/a/b/c.txt'],
  },
  {
    name: 'a leading slash anchors the rule to the repository root',
    rules: ['/build/'],
    paths: ['build/x', 'src/build/y'],
  },
  {
    name: 'a rule without a slash matches at any depth',
    rules: ['*.log'],
    paths: ['a.log', 'deep/nested/b.log', 'deep/nested/b.txt'],
  },
  {
    name: 'the last matching rule wins',
    rules: ['*.log', '!important.log'],
    paths: ['a.log', 'important.log'],
  },
  {
    name: 'a negation works when the parent directory is not excluded',
    rules: ['/logs', '!logs/keep.log'],
    paths: ['logs/keep.log', 'logs/other.log'],
  },
  {
    name: 'double star prefix is equivalent to the unanchored form',
    rules: ['**/tmp'],
    paths: ['tmp', 'a/tmp', 'a/b/tmp'],
  },
  {
    name: 'a character class is honoured',
    rules: ['file[0-9].txt'],
    paths: ['file1.txt', 'file9.txt', 'filex.txt'],
  },
  {
    name: 'a single character wildcard does not cross a slash',
    rules: ['a?c'],
    paths: ['abc', 'a/c'],
  },
  {
    name: 'an escaped hash is a literal hash, not a comment',
    rules: ['\\#notes.txt'],
    paths: ['#notes.txt'],
  },
];

for (const { name, rules, paths } of CASES) {
  test(`agrees with git: ${name}`, () => {
    const truth = gitSays(rules, paths);
    for (const p of paths) {
      assert.equal(
        matcherSays(rules, p),
        truth[p],
        `pattern ${JSON.stringify(rules)} on ${JSON.stringify(p)}: git says ${
          truth[p] ? 'ignored' : 'kept'
        }`,
      );
    }
  });
}

test('git is actually available, otherwise the differential tests are vacuous', () => {
  // Guards the whole file: if git is missing, every case above would "pass"
  // by comparing the matcher against itself.
  const out = execFileSync('git', ['--version'], { encoding: 'utf8' });
  assert.match(out, /git version/);
});