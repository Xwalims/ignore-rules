'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseFile } = require('../src/pattern.js');
const { createMatcher, normalizePath, ancestorsOf } = require('../src/matcher.js');

/** Build a matcher from .gitignore text. */
function matcherFor(text) {
  return createMatcher(parseFile(text).rules);
}

test('normalizePath strips prefixes and collapses separators', () => {
  assert.equal(normalizePath('./a/b'), 'a/b');
  assert.equal(normalizePath('/a/b'), 'a/b');
  assert.equal(normalizePath('a//b'), 'a/b');
  assert.equal(normalizePath('a/b/'), 'a/b');
  assert.equal(normalizePath('././a'), 'a');
  assert.equal(normalizePath(''), '');
});

test('ancestorsOf lists every parent directory outermost first', () => {
  assert.deepEqual(ancestorsOf('a/b/c.txt'), ['a', 'a/b']);
  assert.deepEqual(ancestorsOf('a'), []);
  assert.deepEqual(ancestorsOf('a/b'), ['a']);
});

test('a single rule ignores and tracks the right paths', () => {
  const m = matcherFor('build\n');
  assert.equal(m.ignore('build'), true);
  assert.equal(m.ignore('src/build'), true);
  assert.equal(m.ignore('src/index.js'), false);
  assert.equal(m.ignore('builder'), false);
});

test('the last matching rule wins', () => {
  const excludeThenInclude = matcherFor('*.log\n!important.log\n');
  assert.equal(excludeThenInclude.ignore('debug.log'), true);
  assert.equal(excludeThenInclude.ignore('important.log'), false, 'the negation comes last');

  // Order matters: whichever of the two rules is last decides the outcome.
  const includeThenExclude = matcherFor('important.log\n!debug.log\n');
  assert.equal(includeThenExclude.ignore('important.log'), true);
  assert.equal(includeThenExclude.ignore('debug.log'), false);

  // A trailing catch-all negation wins over an earlier specific exclusion.
  const catchAllLast = matcherFor('important.log\n!*.log\n');
  assert.equal(
    catchAllLast.ignore('important.log'),
    false,
    'the later negation re-includes it, because last match wins'
  );
  assert.equal(catchAllLast.ignore('other.log'), false);
});

test('a negation re-includes even when the earlier rule was directory-only', () => {
  const m = matcherFor('*.txt\n!keep.txt\n');
  assert.equal(m.ignore('a.txt'), true);
  assert.equal(m.ignore('keep.txt'), false);
  assert.equal(m.ignore('deep/keep.txt'), false, 'unanchored, so at any depth');
});

test('an excluded parent directory also covers everything beneath it', () => {
  const m = matcherFor('node_modules\n');
  assert.equal(m.ignore('node_modules'), true);
  assert.equal(m.ignore('node_modules/pkg'), true);
  assert.equal(m.ignore('node_modules/pkg/index.js'), true);
  assert.equal(m.ignore('src/node_modules/pkg/index.js'), true);
});

test('THE PARENT-DIRECTORY RULE: an excluded parent blocks re-inclusion', () => {
  // This is the rule that surprises everyone: git stops at the excluded
  // directory and never looks inside it, so a later negation cannot help.
  const m = matcherFor('build/\n!build/keep.txt\n');
  assert.equal(
    m.ignore('build/keep.txt'),
    true,
    'git never descends into an excluded directory, so the negation is dead'
  );

  const reason = m.explain('build/keep.txt');
  assert.equal(reason.blockingAncestor.path, 'build');
  assert.match(reason.reason, /parent directory "build" is excluded/);
});

test('THE PARENT-DIRECTORY RULE: it still applies several levels down', () => {
  const m = matcherFor('vendor/\n!vendor/keep.txt\n');
  assert.equal(m.ignore('vendor/deep/nested/keep.txt'), true);

  const reason = m.explain('vendor/deep/nested/keep.txt');
  // `vendor` is the outermost excluded ancestor and is reported first.
  assert.equal(reason.blockingAncestor.path, 'vendor');
});

test('THE PARENT-DIRECTORY RULE: re-inclusion works when the parent is NOT excluded', () => {
  // `build/*` matches the contents of build but not build itself, so git still
  // descends into the directory and the negation takes effect.
  const m = matcherFor('build/*\n!build/keep.txt\n');
  assert.equal(m.ignore('build/keep.txt'), false, 'the negation wins here');
  assert.equal(m.ignore('build/other.txt'), true);
  assert.equal(m.ignore('build'), false, 'build itself was never excluded');
});

test('a directory-only rule ignores the directory, which then covers its contents', () => {
  // `logs/` does not itself match the file `logs/today.log`. The file is
  // ignored because its parent directory is, which is the rule working
  // correctly rather than a rule that happens to match.
  const m = matcherFor('logs/\n');
  assert.equal(m.ignore('logs', true), true, 'the directory itself is ignored');
  assert.equal(
    m.ignore('logs', false),
    false,
    'and not a file of the same name'
  );
  assert.equal(m.ignore('logs/today.log'), true);

  const reason = m.explain('logs/today.log');
  assert.equal(reason.matched, false, 'the rule does not match the file directly');
  assert.equal(reason.blockingAncestor.path, 'logs');
  assert.match(reason.reason, /parent directory "logs" is excluded/);
});

test('a path with no matching rule is tracked', () => {
  const m = matcherFor('*.log\nbuild/\n');
  assert.equal(m.ignore('src/index.js'), false);
  const reason = m.explain('src/index.js');
  assert.equal(reason.reason, 'no rule matches it');
  assert.equal(reason.matched, false);
});

test('explain lists every rule considered, in order', () => {
  const m = matcherFor('# comment\n\n*.log\n!important.log\n');
  const r = m.explain('important.log');

  assert.equal(r.path, 'important.log');
  assert.equal(r.ignored, false);
  assert.equal(r.decidingRule.line, 4, 'the last matching rule decided');
  assert.equal(r.decidingRule.negated, true);

  // Every line of the file is represented, in file order - including the blank
  // line 2 and the empty final line that the trailing newline produces.
  assert.deepEqual(
    r.considered.map((c) => c.line),
    [1, 2, 3, 4, 5]
  );
  assert.equal(r.considered[0].action, 'comment');
  assert.equal(r.considered[1].action, 'blank');
  assert.equal(r.considered[2].action, 'ignore');
  assert.equal(r.considered[3].action, 're-include');
  assert.equal(r.considered[4].action, 'blank');
  assert.equal(r.considered[2].matched, true);
});

test('explain reports ancestors even when they do not match', () => {
  const m = matcherFor('*.log\n');
  const r = m.explain('src/lib/index.js');
  assert.deepEqual(
    r.ancestors.map((a) => a.path),
    ['src', 'src/lib']
  );
  assert.equal(r.blockingAncestor, null);
});

test('matches reports pattern-level coverage without negation logic', () => {
  const m = matcherFor('*.log\n!important.log\n');
  assert.equal(m.matches('important.log'), true, 'some rule matches it');
  assert.equal(m.ignore('important.log'), false, 'but the negation wins');
});

test('createMatcher rejects a non-array', () => {
  assert.throws(() => createMatcher('nope'), TypeError);
});

test('the ignored state for a realistic ruleset matches git', () => {
  const m = matcherFor(
    [
      'node_modules/',
      'dist/',
      '*.log',
      '!npm-debug.log',
      'coverage/',
      '.env.local',
      'src/**/*.test.js',
      '!src/index.test.js',
    ].join('\n')
  );

  const expectations = [
    ['node_modules/react/index.js', true],
    ['src/node_modules/x.js', true],
    ['dist/bundle.js', true],
    ['deep/dist/bundle.js', true],
    ['debug.log', true],
    ['npm-debug.log', false],
    ['logs/npm-debug.log', false],
    ['coverage/lcov.info', true],
    ['.env.local', true],
    ['src/a/b/x.test.js', true],
    ['src/index.test.js', false],
    ['README.md', false],
  ];

  for (const [p, want] of expectations) {
    assert.equal(m.ignore(p), want, `${p} should be ${want ? 'ignored' : 'tracked'}`);
  }
});

test('table-driven: pattern, path, isDir, expected', () => {
  const rules = [
    'build',
    '/dist',
    '*.log',
    '!keep.log',
    'a/**/b',
    'a/**',
    '?one.txt',
    '[xy].dat',
    'docs/',
    '!docs/index.md',
    '**/node_modules',
    'src/**/*.test.js',
  ];

  const table = [
    // pattern-level matching, in isolation
    ['build', 'build', false, true],
    ['build', 'a/build', false, true],
    ['build', 'build/x', false, false],
    ['build', 'build', true, true],
    ['/dist', 'dist', false, true],
    ['/dist', 'a/dist', false, false],
    ['/dist', 'dist', true, true],
    ['*.log', 'x/y.log', false, true],
    ['a/**/b', 'a/b', false, true],
    ['a/**/b', 'a/x/y/b', false, true],
    ['a/**', 'a/b/c', false, true],
    ['a/**', 'a', false, false],
    ['?one.txt', 'aone.txt', false, true],
    ['?one.txt', 'one.txt', false, false],
    ['[xy].dat', 'x.dat', false, true],
    ['[xy].dat', 'z.dat', false, false],
    ['docs/', 'docs', false, false],
    ['docs/', 'docs', true, true],
    ['docs/index.md', 'docs/index.md', false, true],
    ['**/node_modules', 'x/y/node_modules', true, true],
    ['src/**/*.test.js', 'src/a.test.js', false, true],
    ['src/**/*.test.js', 'src/a/b.test.js', false, true],
    ['src/**/*.test.js', 'src/a.js', false, false],
  ];

  for (const [pattern, path, isDir, expected] of table) {
    const m = matcherFor(pattern);
    const actual = m.matches(path, isDir);
    assert.equal(
      actual,
      expected,
      `pattern ${JSON.stringify(pattern)} vs path ${JSON.stringify(path)} isDir=${isDir}`
    );
  }
});

test('a character class never matches a slash', () => {
  // Every other token is barred from crossing a slash: `*` compiles to `[^/]*`
  // and `?` to `[^/]`. A bracket class holding `/` was the one exception -- it
  // emitted `[a\/]`, explicitly INCLUDING the character everything else excludes,
  // so `x[/]y` excluded `x/y`. Measured against `git check-ignore`; see
  // test/git-differential.test.js.
  const table = [
    ['x[/]y', 'x/y', false, 'a class of nothing but the slash matches nothing at all'],
    ['x[/]y', 'xy', false],
    ['x[a/]y', 'xay', true, 'the other members still work'],
    ['x[a/]y', 'x/y', false, 'but the slash still does not'],
    ['x[a/]y', 'x//y', false],
    // `[--/]` is the range 0x2D..0x2F, i.e. `-`, `.` and `/`.
    ['x[--/]y', 'x-y', true, 'the range is split around the slash, not dropped'],
    ['x[--/]y', 'x.y', true],
    ['x[--/]y', 'x/y', false],
    ['x[--/]y', 'x0y', false, 'and it does not grow past its endpoints'],
    // An in-class slash still anchors the pattern to the root.
    ['[a/]b', 'ab', true],
    ['[a/]b', 'z/ab', false, 'anchored by the in-class slash, so not at depth'],
    // The negated form excludes the slash too.
    ['x[!/]y', 'xay', true],
    ['x[!/]y', 'x/y', false],
  ];

  for (const [pattern, path, expected, why] of table) {
    assert.equal(
      matcherFor(pattern).ignore(path, false),
      expected,
      `${JSON.stringify(pattern)} vs ${JSON.stringify(path)}${why ? ` (${why})` : ''}`,
    );
  }
});

test('table-driven: full rule list, where negation and precedence apply', () => {
  const table = [
    // `keep.log` on its own is a plain exclusion; the `!keep.log` row is the
    // only thing that re-includes it.
    ['keep.log', 'keep.log', false, true],
    ['keep.log', 'other.log', false, false],
    ['*.log\n!keep.log', 'keep.log', false, false],
    ['*.log\n!keep.log', 'other.log', false, true],
    ['keep.log\n!*.log', 'keep.log', false, false, 'last match wins'],
    ['node_modules/', 'node_modules', false, false, 'a dir rule ignores the directory'],
    ['node_modules/', 'node_modules', true, true],
    ['node_modules/', 'node_modules/x.js', false, true],
    ['build/', 'build', true, true],
    ['build/', 'build', false, false, 'a dir rule ignores the directory'],
    ['build/', 'build/x.js', false, true],
    ['build/', 'a/build/x.js', false, true],
    ['build/*', 'build/x.js', false, true],
    ['build/*', 'build', true, false, 'the contents rule skips the directory itself'],
  ];

  for (const [rules, path, isDir, expected, why] of table) {
    const m = matcherFor(rules);
    assert.equal(
      m.ignore(path, isDir),
      expected,
      `${JSON.stringify(rules)} vs ${JSON.stringify(path)} isDir=${isDir}${why ? ` (${why})` : ''}`
    );
  }
});