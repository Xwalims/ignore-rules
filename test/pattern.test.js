'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parsePattern, parseFile, stripTrailingSpaces, excludeSlash } = require('../src/pattern.js');

/** Compile and match, failing loudly with both inputs on a mismatch. */
function match(pattern, path, isDir = false) {
  const r = parsePattern(pattern);
  assert.ok(
    !r.isComment,
    `expected ${JSON.stringify(pattern)} to compile as a rule, got a comment`
  );
  return r.matches(path, isDir);
}

test('excludeSlash drops the slash and splits any range that spans it', () => {
  // Every case below is measured against `git check-ignore`, not reasoned about.
  const table = [
    [[['-', '-']], [['-', '-']]], // no slash, untouched
    [[['a', 'z']], [['a', 'z']]],
    [[['/', '/']], []], // slash alone leaves nothing
    [[['a', 'a'], ['/', '/']], [['a', 'a']]], // slash member dropped, others kept
    // `--/` is 0x2D..0x2F: `-`, `.` and `/`. git matches `-` and `.`.
    [[['-', '/']], [['-', '.']]],
    // `+-0` is 0x2B..0x30: git matches `+`, `,`, `-`, `.` and `0`.
    [[['+', '0']], [['+', '.'], ['0', '0']]],
    // `,-1` is 0x2C..0x31: git matches `,`, `-`, `.`, `0` and `1`.
    [[[',', '1']], [[',', '.'], ['0', '1']]],
    // `/-0` is 0x2F..0x30: git matches `0` only.
    [[['/','0']], [['0', '0']]],
    // A reversed span cannot contain a slash in git's model either: `z` and
    // `a` do not bracket `/`, so the span is dropped as an empty range. What
    // survives is handled by parseRanges, not here -- this function only
    // strips the slash, and a reversed span that never reaches it is already
    // discarded by CharClass's own `lo > hi` check.
    [[['z', 'a']], []],
  ];

  for (const [input, expected] of table) {
    assert.deepEqual(
      excludeSlash(input),
      expected,
      `excludeSlash(${JSON.stringify(input)}) should be ${JSON.stringify(expected)}`,
    );
  }
});

test('literal patterns match at any depth but not as a prefix of a longer name', () => {
  assert.equal(match('build', 'build'), true);
  assert.equal(match('build', 'a/build'), true);
  assert.equal(match('build', 'a/b/build'), true);
  assert.equal(match('build', 'build/out.js'), false);
  assert.equal(match('build', 'buildings'), false);
});

test('a star matches within one segment and never crosses a slash', () => {
  assert.equal(match('*.log', 'a.log'), true);
  assert.equal(match('*.log', 'deep/a.log'), true);
  // `*.log` has no slash, so like any unanchored rule it matches the basename
  // at any depth. The star itself never spans a separator - see the anchored
  // cases below, where that is directly observable.
  assert.equal(match('*.log', 'a/b.log'), true);
  assert.equal(match('a/*', 'a/b'), true);
  assert.equal(match('a/*', 'a/b/c'), false, 'the star stops at the next slash');
  assert.equal(match('a/*/c', 'a/b/c'), true);
  assert.equal(match('a/*/c', 'a/b/x/c'), false, 'one star, one segment');
  assert.equal(match('/*', 'a'), true);
  assert.equal(match('/*', 'a/b'), false);
});

test('a question mark matches exactly one character and never a slash', () => {
  assert.equal(match('?.txt', 'a.txt'), true);
  assert.equal(match('?.txt', 'ab.txt'), false);
  assert.equal(match('a?c', 'abc'), true);
  assert.equal(match('a?c', 'ac'), false);
  // `?.txt` has no slash, so like any unanchored rule it matches the basename
  // at any depth - this is git's behaviour, not a bug.
  assert.equal(match('?.txt', 'deep/dir/a.txt'), true);
});

test('character classes accept ranges and reject negated sets', () => {
  assert.equal(match('[a-c].txt', 'b.txt'), true);
  assert.equal(match('[a-c].txt', 'd.txt'), false);
  assert.equal(match('[!a-c].txt', 'd.txt'), true);
  assert.equal(match('[!a-c].txt', 'b.txt'), false);
  assert.equal(match('file[!0-9]', 'filea'), true);
  assert.equal(match('file[!0-9]', 'file7'), false);
  // A slash inside a class is still one single character, so it can never match
  // a path separator: `[a/b]` matches a one-segment name like `a`, never `a/b`.
  assert.equal(match('[a/b]', 'a'), true);
  assert.equal(match('[a/b]', 'a/b'), false, 'a class is one character, not a path');
  assert.equal(match('x/[a-c]/y', 'x/b/y'), true);
  assert.equal(match('x/[a-c]/y', 'x/z/y'), false);
  // An unterminated class degrades to a literal `[`.
  assert.equal(match('[abc', '[abc'), true);
});

test('a globstar spans directories, including zero of them', () => {
  assert.equal(match('**/foo', 'foo'), true);
  assert.equal(match('**/foo', 'a/foo'), true);
  assert.equal(match('**/foo', 'a/b/c/foo'), true);
  assert.equal(match('a/**/b', 'a/b'), true, 'zero directories');
  assert.equal(match('a/**/b', 'a/x/b'), true, 'one directory');
  assert.equal(match('a/**/b', 'a/x/y/b'), true, 'several directories');
  assert.equal(match('a/**/b', 'a/x/b/c'), false, 'the tail is still fixed');
  assert.equal(match('a/**/b', 'x/a/b'), false, 'the head is still fixed');
  assert.equal(match('a/**/b/**/c', 'a/b/c'), true);
  assert.equal(match('a/**/b/**/c', 'a/x/b/y/c'), true);
});

test('a trailing globstar matches the contents of a directory, not the directory', () => {
  assert.equal(match('a/**', 'a/b'), true);
  assert.equal(match('a/**', 'a/b/c/d'), true);
  assert.equal(match('a/**', 'a'), false);
  assert.equal(match('a/**', 'b/c'), false);
});

test('a bare globstar matches every path', () => {
  assert.equal(match('**', 'anything'), true);
  assert.equal(match('**', 'a/b/c'), true);
});

test('a globstar glued to text degrades to a single star, as git does', () => {
  // `a**b` is not a globstar: git collapses it to `a*b`, which cannot cross a
  // slash.
  assert.equal(match('a**b', 'axxb'), true);
  assert.equal(match('a**b', 'ax/xb'), false);
  assert.equal(match('a**b', 'a/b'), false);
  const r = parsePattern('a**b');
  assert.equal(r.degradedGlobstarCount, 1);
  assert.equal(r.globstarCount, 0);
});

test('a globstar after a literal prefix is still a globstar', () => {
  // git strips the leading literal run first (simple_length, stopping at the
  // first `*`, `?`, `[` or `\`), then runs wildmatch on the remainder -- so the
  // run in `q**/b` sits at the start of what wildmatch sees, which is the one
  // position its globstar test allows.
  assert.equal(parsePattern('q**/b').globstarCount, 1);
  assert.equal(parsePattern('q**/b').degradedGlobstarCount, 0);

  assert.equal(match('q**/b', 'qb'), true, 'zero directories, no separator');
  assert.equal(match('q**/b', 'q/b'), true);
  assert.equal(match('q**/b', 'q/a/b'), true);
  assert.equal(match('q**/b', 'q/a/c/b'), true);
  assert.equal(match('q**/b', 'p/qb'), false, 'a slash still anchors the pattern');
  assert.equal(match('q**/b', 'q/a/b/c'), false, 'the tail is still fixed');

  // Anything that ends the literal prefix puts the run back inside the
  // remainder, where a preceding `q` spoils the globstar test.
  assert.equal(parsePattern('*q**/b').globstarCount, 0);
  assert.equal(parsePattern('?q**/b').globstarCount, 0);
  assert.equal(parsePattern('[q]**/b').globstarCount, 0);

  // An ESCAPE ends the prefix too, and here that changes the answer: git hands
  // wildmatch `\.x**/b`, so the run is preceded by `x` rather than by nothing,
  // and the test fails. Measured with `git check-ignore`, which keeps `a.x/b`
  // (the collapsed `a\.x*b` star matching nothing) but drops `a.xxb`:
  assert.equal(parsePattern('a\\.x**/b').globstarCount, 0);
  assert.equal(parsePattern('a\\.x**/b').degradedGlobstarCount, 1);
});

test('the compiled regex grows linearly, not exponentially, with globstars', () => {
  // Spelling "zero directories OR any directories" as `(?:rest|.*\/rest)` is
  // the obvious reading, but it re-renders the tail at every globstar: the
  // source grew as 2^n and fourteen of them compiled to 277 KB. `(?:.*\/)?rest`
  // says the same thing in linear size. Checked on the doubling, so the old
  // shape fails loudly instead of merely getting slower.
  const size = (n) => {
    const parts = [];
    for (let i = 0; i < n; i++) parts.push(`d${i}`, '**');
    parts.push('end');
    return parsePattern(parts.join('/')).regex.source.length;
  };
  assert.ok(size(10) < 500, `10 globstars should stay small, got ${size(10)}`);
  assert.ok(
    size(14) - size(13) < 40,
    `each extra globstar must add a bounded amount, got ${size(13)} -> ${size(14)}`,
  );
  assert.ok(size(20) < 1000, `20 globstars should stay small, got ${size(20)}`);
});

test('anchoring: a leading slash anchors to the root', () => {
  assert.equal(match('/build', 'build'), true);
  assert.equal(match('/build', 'a/build'), false, 'anchored, so no leading dirs');
  assert.equal(match('/build', 'a/b/build'), false);
});

test('anchoring: an interior slash also anchors to the root', () => {
  assert.equal(match('doc/frotz', 'doc/frotz'), true);
  assert.equal(match('doc/frotz', 'a/doc/frotz'), false);
  assert.equal(match('a/b', 'a/b'), true);
  assert.equal(match('a/b', 'x/a/b'), false);
});

test('anchoring: a pattern with no slash matches at any depth', () => {
  assert.equal(match('target', 'target'), true);
  assert.equal(match('target', 'a/target'), true);
  assert.equal(match('target', 'a/b/target'), true);
  assert.equal(parsePattern('target').anchored, false);
  assert.equal(parsePattern('/target').anchored, true);
  assert.equal(parsePattern('a/target').anchored, true);
  assert.equal(parsePattern('**/target').anchored, false, 'leading globstar unanchors');
});

test('a trailing slash restricts a rule to directories', () => {
  const r = parsePattern('build/');
  assert.equal(r.dirOnly, true);
  assert.equal(r.matches('build', true), true);
  assert.equal(r.matches('build', false), false, 'not a directory');
  assert.equal(match('build', 'build/out.js'), false);
  assert.equal(parsePattern('/build/').anchored, true);
  assert.equal(parsePattern('/build/').dirOnly, true);
});

test('a leading bang negates, and an escaped bang is literal', () => {
  assert.equal(parsePattern('!build').negated, true);
  assert.equal(parsePattern('build').negated, false);
  assert.equal(match('\\!important', '!important'), true, 'escaped bang is literal');
  assert.equal(parsePattern('\\!important').negated, false);
  assert.equal(parsePattern('!\\#file').negated, true);
});

test('a hash starts a comment unless it is escaped', () => {
  const c = parsePattern('# a comment');
  assert.equal(c.isComment, true);
  assert.equal(c.commentKind, 'comment');
  assert.equal(c.matches('# a comment'), false, 'a comment matches nothing');

  const escaped = parsePattern('\\#file');
  assert.equal(escaped.isComment, false);
  assert.equal(escaped.matches('#file'), true);
  assert.equal(escaped.matches('deep/#file'), true, 'no slash, so any depth');
});

test('blank and whitespace-only lines are comments, not rules', () => {
  assert.equal(parsePattern('').isComment, true);
  assert.equal(parsePattern('   ').isComment, true);
  assert.equal(parsePattern('   ').commentKind, 'blank');
});

test('unescaped trailing spaces are stripped', () => {
  assert.equal(stripTrailingSpaces('build   '), 'build');
  assert.equal(stripTrailingSpaces('build'), 'build');
  assert.equal(match('trail   ', 'trail'), true);
  assert.equal(match('trail   ', 'trail   '), false, 'the spaces are not part of it');
});

test('an escaped trailing space is significant', () => {
  assert.equal(stripTrailingSpaces('trail\\ '), 'trail\\ ');
  assert.equal(match('trail\\ ', 'trail '), true);
  assert.equal(match('trail\\ ', 'trail'), false);
});

test('backslash escapes the next character', () => {
  assert.equal(match('\\#file', '#file'), true);
  assert.equal(match('\\!file', '!file'), true);
  assert.equal(match('\\*file', '*file'), true, 'an escaped star is a literal star');
  assert.equal(match('\\*file', 'xfile'), false);
  assert.equal(match('\\[abc]', '[abc]'), true);
});

test('a compiled pattern reports its own shape', () => {
  const r = parsePattern('!src/**/*.log');
  assert.equal(r.source, '!src/**/*.log');
  assert.equal(r.negated, true);
  assert.equal(r.dirOnly, false);
  assert.equal(r.anchored, true);
  assert.equal(r.isGlob, true);
  assert.equal(r.isComment, false);

  const lit = parsePattern('README.md');
  assert.equal(lit.isGlob, false);
  assert.equal(lit.negated, false);
  assert.equal(lit.anchored, false);
});

test('parseFile preserves line numbers and raw text', () => {
  const { rules, lines } = parseFile('# header\n\nbuild\n*.log\n');
  assert.equal(lines.length, 5, 'the trailing newline yields a final empty line');
  assert.equal(rules[0].line, 1);
  assert.equal(rules[0].isComment, true);
  assert.equal(rules[1].line, 2);
  assert.equal(rules[1].commentKind, 'blank');
  assert.equal(rules[2].line, 3);
  assert.equal(rules[2].text, 'build');
  assert.equal(rules[4].line, 5);
  assert.equal(rules[4].isEmpty, true);
});

test('a rule with no matching power is flagged as empty rather than matching all', () => {
  for (const src of ['!', '/', '!/', '']) {
    const r = parsePattern(src);
    assert.equal(r.isComment || r.isEmpty, true, `${JSON.stringify(src)} should match nothing`);
    assert.equal(r.matches('anything'), false);
  }
});