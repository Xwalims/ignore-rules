'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { lint, SEVERITIES } = require('../src/lint.js');

/** The codes present in a lint result, sorted for stable comparison. */
function codesOf(text) {
  return lint(text).map((d) => d.code).sort();
}

/** Assert that a rule reports exactly this code, at this line and severity. */
function assertCode(text, code, line, severity) {
  const found = lint(text).filter((d) => d.code === code);
  assert.equal(found.length, 1, `expected exactly one ${code}, got ${JSON.stringify(codesOf(text))}`);
  if (line !== undefined) assert.equal(found[0].line, line, `${code} line`);
  if (severity !== undefined) assert.equal(found[0].severity, severity, `${code} severity`);
  return found[0];
}

test('a clean file produces no diagnostics', () => {
  const clean = ['# build output', 'node_modules/', 'dist/', '*.log', '!npm-debug.log', ''].join(
    '\n'
  );
  assert.deepEqual(lint(clean), []);
});

test('every diagnostic carries line, code, severity and message', () => {
  for (const d of lint('*.log\n**\n')) {
    assert.equal(typeof d.line, 'number');
    assert.equal(typeof d.code, 'string');
    assert.ok(SEVERITIES.includes(d.severity), `bad severity ${d.severity}`);
    assert.equal(typeof d.message, 'string');
    assert.ok(d.message.length > 0);
  }
});

test('never-matches: a negation with nothing before it to undo', () => {
  const d = assertCode('!build/\n', 'never-matches', 1, 'error');
  assert.match(d.message, /no preceding rule/);
  assert.ok(d.fix, 'offers a fix');
});

test('never-matches: not reported when a positive rule does precede it', () => {
  assert.ok(!codesOf('build/\n!build/keep.txt\n').includes('never-matches'));
});

test('duplicate-rule: the same rule twice', () => {
  const d = assertCode('*.log\n*.log\n', 'duplicate-rule', 2, 'warning');
  assert.match(d.message, /line 1/);
});

test('duplicate-rule: a negated duplicate is compared as its own rule', () => {
  assert.ok(codesOf('*.log\n!keep.log\n!keep.log\n').includes('duplicate-rule'));
  // `*.log` and `!*.log` are different rules, not duplicates.
  assert.ok(!codesOf('*.log\n!*.log\n').includes('duplicate-rule'));
});

test('redundant-globstar: a leading globstar on an unanchored name', () => {
  const d = assertCode('**/node_modules\n', 'redundant-globstar', 1, 'warning');
  assert.equal(d.fix, 'node_modules');
  assert.match(d.message, /same paths/);
});

test('redundant-globstar: not reported when the globstar does real work', () => {
  // A slash in the body anchors the rule, so the globstar is not redundant.
  assert.ok(!codesOf('**/src/build\n').includes('redundant-globstar'));
  // Two globstars in a row are a real multi-directory wildcard.
  assert.ok(!codesOf('**/a/**/b\n').includes('redundant-globstar'));
});

test('trailing-whitespace: unescaped spaces git will silently drop', () => {
  const d = assertCode('build   \n', 'trailing-whitespace', 1, 'warning');
  assert.match(d.message, /3 spaces/);
  assert.match(d.fix, /\\ /, 'mentions the escape');
});

test('trailing-whitespace: a single space is reported too', () => {
  assertCode('build \n', 'trailing-whitespace', 1, 'warning');
});

test('trailing-whitespace: an escaped trailing space is intentional, not reported', () => {
  assert.ok(!codesOf('build\\ \n').includes('trailing-whitespace'));
});

test('trailing-whitespace: reported on comments too', () => {
  assertCode('# a comment   \n', 'trailing-whitespace', 1, 'warning');
});

test('globstar-not-needed: a globstar that git collapses to a single star', () => {
  const d = assertCode('a**b\n', 'globstar-not-needed', 1, 'warning');
  assert.equal(d.fix, 'a*b');
  assert.match(d.message, /collapses it to a single/);
});

test('globstar-not-needed: a bare globstar excludes the whole tree', () => {
  const d = assertCode('**\n', 'globstar-not-needed', 1, 'warning');
  assert.match(d.message, /every path/);
});

test('globstar-not-needed: a well-formed multi-directory globstar is fine', () => {
  assert.ok(!codesOf('a/**/b\n').includes('globstar-not-needed'));
  assert.ok(!codesOf('a/**\n').includes('globstar-not-needed'));
});

test('anchor-suspicious: an interior slash quietly anchors to the root', () => {
  const d = assertCode('doc/frotz\n', 'anchor-suspicious', 1, 'info');
  assert.match(d.message, /repository root/);
  assert.equal(d.fix, '**/doc/frotz');
});

test('anchor-suspicious: an explicit leading slash is not suspicious', () => {
  assert.ok(!codesOf('/doc/frotz\n').includes('anchor-suspicious'));
});

test('anchor-suspicious: a globstar rule that already spans depths is not flagged', () => {
  assert.ok(!codesOf('**/doc/frotz\n').includes('anchor-suspicious'));
});

test('shadowed-rule: a later catch-all already covers an earlier rule', () => {
  const d = assertCode('*.log\n**\n', 'shadowed-rule', 1, 'error');
  assert.match(d.message, /shadowed by "\*\*" on line 2/);
});

test('shadowed-rule: a narrower later rule does not shadow a wider one', () => {
  assert.ok(!codesOf('**\n*.log\n').includes('shadowed-rule'));
});

test('shadowed-rule: a later negation can rescue paths, so nothing is reported', () => {
  const text = '*.log\n**\n!keep.log\n';
  assert.ok(
    !codesOf(text).includes('shadowed-rule'),
    'the trailing negation means the rule is not entirely dead'
  );
});

test('shadowed-rule: two rules with the same coverage shadow each other', () => {
  const text = 'build/\nbuild/\n';
  const codes = codesOf(text);
  assert.ok(codes.includes('shadowed-rule'));
  assert.ok(codes.includes('duplicate-rule'));
});

test('diagnostics are ordered by line', () => {
  const diags = lint('!orphan\n*.log\n*.log\n');
  const lines = diags.map((d) => d.line);
  assert.deepEqual(lines, [...lines].sort((a, b) => a - b), 'sorted by line');
});

test('lint is stable: the same input yields the same output', () => {
  const text = '**/node_modules\n!orphan\na**b\ndoc/frotz\nbuild   \n';
  assert.deepEqual(lint(text), lint(text));
});

test('an empty file and a comments-only file are both clean', () => {
  assert.deepEqual(lint(''), []);
  assert.deepEqual(lint('# just a comment\n\n# another\n'), []);
});

test('a realistic problematic file reports every code', () => {
  // The fixture deliberately avoids a bare `**` and avoids repeating a rule in
  // two equivalent forms, both of which would shadow other lines and drown out
  // the findings this test is about.
  const text = [
    '!orphan', // 1  never-matches
    'a**b', // 2  globstar-not-needed
    '*.log', // 3  shadowed-rule (covered by the duplicate on line 5)
    'dist/', // 4  no diagnostic of its own
    '*.log', // 5  duplicate-rule
    'doc/frotz', // 6  anchor-suspicious
    'build   ', // 7  trailing-whitespace
  ].join('\n');

  const diags = lint(text);
  const found = new Map();
  for (const d of diags) {
    if (!found.has(d.code)) found.set(d.code, []);
    found.get(d.code).push(d.line);
  }

  assert.deepEqual(found.get('never-matches'), [1]);
  assert.deepEqual(found.get('globstar-not-needed'), [2]);
  assert.deepEqual(found.get('shadowed-rule'), [3]);
  assert.deepEqual(found.get('duplicate-rule'), [5]);
  assert.deepEqual(found.get('anchor-suspicious'), [6]);
  assert.deepEqual(found.get('trailing-whitespace'), [7]);
});

test('an equivalent rule later in the file shadows the earlier one', () => {
  // `node_modules` on line 2 already matches everything `**/node_modules` on
  // line 1 matches, so the first rule can never take effect.
  const diags = lint('**/node_modules\nnode_modules\n');
  const shadow = diags.find((d) => d.code === 'shadowed-rule');
  assert.ok(shadow, 'expected a shadowed-rule diagnostic');
  assert.equal(shadow.line, 1);
  assert.match(shadow.message, /shadowed by "node_modules" on line 2/);
});

test('a bare globstar shadows every rule above it', () => {
  // `**` matches every path, so anything listed before it is unreachable.
  const text = '*.log\nnode_modules/\n**\n';
  const shadowed = lint(text).filter((d) => d.code === 'shadowed-rule');
  assert.deepEqual(shadowed.map((d) => d.line).sort(), [1, 2]);
  for (const d of shadowed) assert.match(d.message, /shadowed by "\*\*" on line 3/);
});

test('every documented code is reachable', () => {
  const fixtures = {
    'never-matches': '!orphan\n',
    'shadowed-rule': '*.log\n**\n',
    'duplicate-rule': '*.log\n*.log\n',
    'redundant-globstar': '**/node_modules\n',
    'trailing-whitespace': 'build \n',
    'globstar-not-needed': 'a**b\n',
    'anchor-suspicious': 'doc/frotz\n',
  };
  const documented = new Set(Object.keys(fixtures));

  for (const [code, text] of Object.entries(fixtures)) {
    assert.ok(
      lint(text).some((d) => d.code === code),
      `fixture for ${code} does not produce it`
    );
  }

  // And the module's own diagnostics never invent a code outside that set.
  const everything = lint(Object.values(fixtures).join(''));
  for (const d of everything) {
    assert.ok(documented.has(d.code), `undocumented code ${d.code}`);
  }
});