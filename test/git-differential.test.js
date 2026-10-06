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
  {
    // A character class never matches a slash, even when the slash is written
    // inside the class. `*` compiles to `[^/]*` and `?` to `[^/]`, so a class
    // holding `/` was the one token that DID cross a slash -- it was emitted as
    // `[a\/]`, explicitly including the character every other token excludes.
    name: 'a slash inside a character class never matches a slash',
    rules: ['x[/]y'],
    paths: ['x/y', 'xy', 'xay', 'x/zy'],
  },
  {
    name: 'a class with other members still matches them, just not the slash',
    rules: ['x[a/]y'],
    paths: ['xay', 'x/y', 'x//y'],
  },
  {
    // A range whose span contains the slash keeps the members on either side of
    // it. `-` is 0x2D and `.` is 0x2E, so `[--/]` covers `-`, `.` and `/` and
    // must match the first two only.
    name: 'a range spanning the slash is split around it',
    rules: ['x[--/]y'],
    paths: ['x-y', 'x.y', 'x/y'],
  },
  {
    name: 'an in-class slash still anchors the pattern to the root',
    rules: ['[a/]b'],
    paths: ['ab', 'z/ab'],
  },
  {
    name: 'an escaped slash inside a class is still just the slash',
    rules: ['x[\\/]y'],
    paths: ['x/y', 'xy'],
  },
  {
    // A run of THREE asterisks is a globstar, exactly as two are. It used to
    // be read as `**` plus a stray `*`, so `***/**` demanded a slash and
    // ignored nothing at the top level, where git ignores everything.
    name: 'three asterisks are a globstar, not a globstar and a star',
    rules: ['***/**'],
    paths: ['a.txt', 'd/b.txt', 'd/e/c.txt', 'x/a.txt'],
  },
  {
    name: 'four asterisks are also a globstar',
    rules: ['****/**'],
    paths: ['a.txt', 'd/b.txt', 'd/e/c.txt'],
  },
  {
    // The unbounded-run rule is unchanged and still holds: `a**b` does not
    // cross a slash, because git collapses a run that is bounded by neither
    // slash nor string end into a single `*`.
    name: 'an unbounded asterisk run does not cross a slash',
    rules: ['a**b', 'a***b'],
    paths: ['axb', 'a/b', 'p/q/r'],
  },

  // --------------------------------------------------------------------
  // Reversed character ranges.
  //
  // git does not treat `9-0` as an error, and it does not treat it as "the
  // whole class matches nothing" either. It keeps the FIRST endpoint as an
  // ordinary member and resumes parsing after the second one. Every
  // expectation below was measured with `git check-ignore` by substituting
  // each printable ASCII character into `x<ch>y`.
  //
  //     [9-0]   => {9}
  //     [z-a]   => {z}
  //     [b-a0]  => {b, 0}    resumes past the high endpoint
  //     [9-0-8] => {9, -, 8}
  //     [a-c-e] => {a, b, c, e}
  //
  // The old parser failed twice over. It never advanced its cursor past a
  // rejected range, so the dash and the high endpoint were re-read as fresh
  // members ({9, -, 0}); and a lone dash next to a real range emitted
  // `[9-0]`, a reversed range in the RegExp, which made `new RegExp` THROW.
  // A .gitignore line that git accepts therefore crashed the linter.
  // --------------------------------------------------------------------
  {
    name: 'a reversed range keeps its first endpoint and drops the rest',
    rules: ['x[9-0]y'],
    paths: ['x9y', 'x0y', 'x-y', 'xy', 'xmy'],
  },
  {
    name: 'a reversed range of letters behaves the same way',
    rules: ['x[z-a]y'],
    paths: ['xzy', 'xay', 'xmy', 'xby'],
  },
  {
    name: 'parsing resumes after a reversed range, keeping what follows',
    rules: ['x[b-a0]y'],
    paths: ['xby', 'x0y', 'xay', 'xy'],
  },
  {
    name: 'a reversed range followed by an ordered range',
    rules: ['x[9-0-8]y'],
    paths: ['x9y', 'x-y', 'x8y', 'xay'],
  },
  {
    name: 'an ordered range followed by a reversed one',
    rules: ['x[a-c-e]y'],
    paths: ['xay', 'xby', 'xcy', 'xey', 'xdy'],
  },
  {
    name: 'a reversed range whose low endpoint is not a digit',
    rules: ['x[!-0]y'],
    paths: ['x-y', 'x0y', 'xay'],
  },
  {
    name: 'a reversed range with a bracket as its escaped high endpoint',
    rules: ['x[a-\\]]y'],
    paths: ['xay', 'x]y', 'x-y'],
  },
  {
    // A bare dash as a class member is the shape that produced the invalid
    // RegExp, so it is pinned on its own as well as in combination.
    name: 'a dash used as a class member',
    rules: ['x[-]y', 'x[-a]y', 'a[0-9-]'],
    paths: ['x-y', 'xy', 'xay', 'xzy', 'a5', 'a-', 'ax', 'a'],
  },
  {
    // git's own special case: a `]` immediately after `[` (or after the
    // negation) is a literal member, not the end of the class.
    name: 'a leading right bracket is a literal member',
    rules: ['x[]a]y'],
    paths: ['x]y', 'xay', 'x[]a]y', 'xa]y'],
  },
  {
    name: 'a leading right bracket with nothing after it',
    rules: ['x[]]y'],
    paths: ['x]y', 'xay'],
  },
  {
    name: 'a negated class with a leading right bracket matches nothing',
    rules: ['x[^]a]y'],
    paths: ['x]y', 'xay', 'xb]y'],
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