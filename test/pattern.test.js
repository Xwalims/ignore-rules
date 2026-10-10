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
  // An unterminated class does NOT degrade to a literal `[`: git drops the WHOLE
  // rule. Measured with `git check-ignore`, which ignores nothing for any of
  // these -- not `[abc`, not `a[bc`, not `x[abc`:
  //
  //     [abc    nothing     a[bc    nothing     x*[bc   nothing
  //
  // The old reading compiled the remainder as literal text, so `x[abc` fired on
  // a file named `x[abc` -- one git keeps.
  assert.equal(match('[abc', '[abc'), false, 'git drops an unterminated class');
  assert.equal(match('a[bc', 'a[bc'), false);
  assert.equal(parsePattern('[abc').isDead, true);
  assert.equal(parsePattern('x*[bc').isDead, true);
  assert.equal(parsePattern('[abc').deadReason, 'unterminated-class');
  // The controls: an ESCAPED `[` is a literal, not an opening bracket.
  assert.equal(match('a\\[b', 'a[b'), true);
  assert.equal(parsePattern('a\\[b').isDead, undefined);
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

test('a trailing globstar GLUED to text may match nothing at all', () => {
  // The other half of the trailing-run rule. `a/**` needs a slash in front of
  // the run, so the directory must exist; `a**` is glued to the `a` and the run
  // is free to expand to the empty string, which makes the BARE NAME `a` a
  // match. Measured with `git check-ignore` -- the pattern is listed with what
  // git ignores:
  //
  //     a/**        a      kept     component run: one or more required
  //     a/**/**     a      kept
  //     a*/**       a, ax  kept
  //     **/a/**     a, x/a kept
  //     a\/b/**     a/b    kept
  //
  //     a**         a      IGNORED  glued run: may be empty
  //     ab**        ab     IGNORED
  //     x/a**       x/a    IGNORED
  //     a**/**      a      IGNORED
  //     a**/**/**   a      IGNORED
  //     a**/        a(dir) IGNORED
  //
  // An unconditional `.+` for a trailing run made every one of the second group
  // keep the one path it exists to cover.
  assert.equal(match('a**', 'a'), true, 'the run may be empty');
  assert.equal(match('a**', 'ab'), true);
  assert.equal(match('a**', 'a/b'), true);
  assert.equal(match('a**', 'x/a'), true, 'unanchored, so any depth');
  assert.equal(match('a**', 'x/ab'), true);

  assert.equal(match('ab**', 'ab'), true);
  assert.equal(match('x/a**', 'x/a'), true, 'anchored, the head is still fixed');
  assert.equal(match('a**/**', 'a'), true);
  assert.equal(match('a**/**/**', 'a'), true);

  // And the component form keeps its own behaviour, so the fix is not just a
  // blanket `.*`.
  assert.equal(match('a/**', 'a'), false);
  assert.equal(match('a/**/**', 'a'), false);
  assert.equal(match('a*/**', 'a'), false);
  assert.equal(match('a*/**', 'ax'), false);
  assert.equal(match('**/a/**', 'a'), false);
  assert.equal(match('a\\/**', 'a'), false, 'an escaped slash is still a slash');
});

test('a repeated slash is a dead pattern: it can never match a path', () => {
  // A path has no doubled separator, so a rule that demands one matches
  // nothing. `git check-ignore` agrees on every shape below -- the listed paths
  // are all KEPT:
  //
  //     a//      a/b/c        **//     a/b       a//b     a/b
  //     a///     a a/b        *//      a a/b     a//b/c   a/b/c
  //     a/b//    a/b a/b/c    //       everything a//b//   everything
  //     a\//     everything   ///      everything
  //
  // `/**//` is the one that shipped a wrong answer, and it is the worst kind.
  // parseBody strips ONE trailing slash, leaving the body `/**/`; the globstar
  // then absorbs the second separator and leaves a lone Globstar token, which
  // hit the "lone globstar matches everything" shortcut and compiled to /.*/.
  // A rule git ignores NOTHING was reported as ignoring every directory in the
  // repository.
  for (const rule of ['a//', 'a///', 'a/b//', '*//', '**//', '/**//', 'a/**//', '**/**//', '//', '///', 'a//b', 'a//b/c', '/a//b', 'a\\//']) {
    for (const p of ['a', 'a/b', 'a/b/c', 'b', 'ab']) {
      assert.equal(match(rule, p), false, `${JSON.stringify(rule)} must not match ${p}`);
    }
  }

  // The escaped slash alone is live, so the test cannot just look for a slash.
  assert.equal(match('a\\/b', 'a/b'), true, 'an escaped slash is one literal slash');
  assert.equal(match('a\\/b/c', 'a/b/c'), true);
  assert.equal(match('a\\//', 'a/'), false, 'an escaped slash plus a real one is doubled');

  assert.equal(parsePattern('/**//').isDead, true);
  assert.equal(parsePattern('a//b').isDead, true);
  assert.equal(parsePattern('a\\/b').isDead, undefined, 'a single escaped slash is live');
  assert.equal(parsePattern('a/').isDead, undefined);
});

test('a doubled slash is LIVE when a glued run absorbs the first of the two', () => {
  // "A doubled slash is always dead" is wrong, and the differential fuzzer is
  // what proved it. A globstar run GLUED to the text before it eats one of the
  // two separators, so only the second has to match a real one, and the rule
  // collapses to the plain rule it looks like. All of it measured with
  // `git check-ignore`, which lists what each pattern actually ignores:
  //
  //     a[STARSTAR]/[SLASH]b       a/b and everything under it
  //     a[STARSTAR]/[SLASH]*       a/b
  //     a[STARSTAR]/[SLASH][STARSTAR]  a/b and everything under it
  //     a[STARSTAR]/[SLASH]bc      a/bc
  //     x/a[STARSTAR]/[SLASH]      x/a as a directory, and everything under it
  //     ab[STARSTAR]/[SLASH]       ab as a directory, and everything under it
  //
  // The run is pinned to the empty string, which is what separates these from
  // the ordinary glued form: `a**/b` also matches `a/x/b` and this does not.
  assert.equal(match('a**//b', 'a/b'), true);
  assert.equal(match('a**//b', 'a/x/b'), false, 'the run cannot expand at all');
  assert.equal(match('a**//bc', 'a/bc'), true);
  assert.equal(match('a**//b/c', 'a/b/c'), true);
  assert.equal(match('a**//*', 'a/b'), true);
  assert.equal(match('a**//*', 'a/b/c'), false, 'a single star does not cross a slash');
  assert.equal(match('a**//**', 'a/b/c'), true);

  // Control: the same pattern WITHOUT the doubled slash does expand.
  assert.equal(match('a**/b', 'a/b'), true);
  assert.equal(match('a**/b', 'a/x/b'), true, 'here the run does expand');

  // The trailing form collapses to the directory the run is glued to, and the
  // dir-only flag then means "as a directory". Plain `/a/` compiles to the
  // same thing, and git treats the two alike.
  assert.equal(parsePattern('a**//').isDead, undefined);
  assert.equal(match('a**//', 'a', true), true);
  assert.equal(match('a**//', 'a', false), false, 'dir-only: a bare file is kept');
  assert.equal(match('a**//', 'ab'), false, 'the run is glued, so `ab` does not match');
  assert.equal(match('ab**//', 'ab', true), true);
  assert.equal(match('ab**//', 'abc', true), false);
  assert.equal(match('x/a**//', 'x/a', true), true);

  // A leading globstar prefix puts the run in the middle of the pattern, where
  // there is nothing left for it to absorb into, so these die after all.
  assert.equal(parsePattern('**/a**//').isDead, true);
  assert.equal(parsePattern('**/a**//b').isDead, true);
  assert.equal(parsePattern('a/**//').isDead, true, 'a component run is not glued');

  // A run with NOTHING in front of it is not glued either. Pinning it to the
  // empty string would leave the pattern with no left-hand side at all, and the
  // result was a match-everything regex -- "ignore the entire repository" out of
  // a rule git applies to nothing. Measured: a single star, a globstar and runs
  // of three and four asterisks each followed by a doubled separator all ignore
  // nothing, and so does the same run glued to an `a`.
  //
  // Two of them are reported as EMPTY rather than dead, because they leave no
  // tokens at all -- a globstar already eats the separators around it. Both mean
  // the rule matches nothing, but they are different facts, so assert the right
  // one rather than lumping them together.
  for (const rule of ['*//', '***//', '****//', '*****//', 'a*//', 'a*//b']) {
    assert.equal(parsePattern(rule).isDead, true, `${rule} ignores nothing in git`);
    assert.equal(match(rule, 'a'), false);
    assert.equal(match(rule, 'a/b'), false);
  }
  for (const rule of ['**//', '//']) {
    assert.equal(parsePattern(rule).isEmpty, true, `${rule} leaves no tokens at all`);
    assert.equal(parsePattern(rule).isDead, undefined);
    assert.equal(match(rule, 'a'), false);
  }
  // The live counterpart, so the loops above are not just "every run dies".
  assert.equal(parsePattern('a**//').isDead, undefined);
  assert.equal(parsePattern('a***//').isDead, undefined, 'a longer run glued to text still absorbs');
  assert.equal(match('a***//b', 'a/b'), true);
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

test('an escaped trailing space run collapses to a SINGLE space, as git does', () => {
  // This is git's own trim_trailing_spaces(), not "an odd backslash count makes
  // the whole run literal". Measured with `git check-ignore` on a file named
  // after the resolved rule:
  //
  //     foo\        (2 spaces)  -> ignores `foo `    ONE space
  //     foo\        (3 spaces)  -> ignores `foo `    ONE space
  //     foo\        (4 spaces)  -> ignores `foo `    ONE space
  //     foo\ \      (2 spaces)  -> ignores `foo  `   the whole run
  //
  // The old code returned the line untouched on an odd backslash count, so all
  // three of the middle cases compiled to two, three and four literal spaces and
  // matched nothing git would have matched.
  for (const n of [2, 3, 4]) {
    const rule = 'foo\\' + ' '.repeat(n);
    assert.equal(match(rule, 'foo '), true, `${n} spaces -> one`);
    assert.equal(match(rule, 'foo' + ' '.repeat(n)), false, `${n} spaces is not literal`);
  }
  assert.equal(match('foo\\ ' + '\\ ', 'foo  '), true, 'every escaped space survives');

  // An unescaped run is stripped whole.
  assert.equal(stripTrailingSpaces('build   '), 'build');
  // A dangling escape aborts the scan: nothing is trimmed at all.
  assert.equal(stripTrailingSpaces('foo\\'), 'foo\\');
  assert.equal(stripTrailingSpaces('foo\\   '), 'foo\\ ');
});

test('a dangling escape kills the whole rule, as git does', () => {
  // git rejects a pattern that ends mid-escape, rather than compiling the stray
  // backslash as an ordinary literal. Measured with `git check-ignore`:
  //
  //     foo\      ignores nothing      foo\\     ignores the file `foo\`
  //     foo\\\    ignores nothing      foo\\\\   ignores the file `foo\\`
  //
  // The old code read the stray backslash as a literal, so `foo\` fired on a file
  // named `foo\` -- one git keeps.
  for (const n of [1, 3, 5]) {
    const rule = 'foo' + '\\'.repeat(n);
    assert.equal(parsePattern(rule).isDead, true, `${n} backslashes is a dangling escape`);
    assert.equal(match(rule, 'foo' + '\\'.repeat(n - 1)), false);
  }
  for (const n of [2, 4]) {
    const rule = 'foo' + '\\'.repeat(n);
    assert.equal(parsePattern(rule).isDead, undefined, `${n} backslashes is a literal`);
    assert.equal(match(rule, 'foo' + '\\'.repeat(n / 2)), true);
  }
  assert.equal(parsePattern('foo\\').deadReason, 'dangling-escape');

  // The dir-only marker is removed BEFORE this test, so a trailing escaped slash
  // leaves a dangling escape in the body. Measured: `foo\/` ignores nothing --
  // not even the directory foo -- while `foo\\/` still ignores the directory
  // `foo\`. Testing the raw line instead of the body got all three of these
  // backwards (`foo\/`, `foo\\\/`, `**\/`).
  assert.equal(parsePattern('foo\\/').isDead, true);
  assert.equal(parsePattern('foo\\\\/').isDead, undefined);
  assert.equal(parsePattern('foo\\\\\\/').isDead, true);
  assert.equal(parsePattern('**\\/').isDead, true);
  assert.equal(parsePattern('**\\\\/').isDead, undefined);
  // The live one still matches the directory it names.
  assert.equal(match('foo\\\\/', 'foo\\', true), true);
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