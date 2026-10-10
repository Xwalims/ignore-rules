'use strict';

/**
 * lint.js - rule diagnostics for .gitignore files.
 *
 * Every diagnostic is `{ line, code, severity, message, fix? }`. Codes are
 * stable and are part of the public contract: they are safe to match on in
 * CI output and in editor integrations.
 *
 *   code                     severity  meaning
 *   -----------------------  --------  ----------------------------------------
 *   never-matches            error     the rule can never exclude anything
 *   shadowed-rule            error     a later rule already covers this one
 *   duplicate-rule           warning   an identical rule appears earlier
 *   redundant-globstar       warning   a leading globstar means the same as none
 *   trailing-whitespace      warning   unescaped trailing whitespace
 *   globstar-not-needed      warning   `**` where a single `*` does the job
 *   anchor-suspicious        info      anchoring likely not what was intended
 *
 * Shadow detection is semantic rather than syntactic: sample concrete paths
 * from the earlier rule and check that the later one matches all of them.
 */

const SEVERITIES = Object.freeze(['error', 'warning', 'info']);

const SEVERITY_RANK = Object.freeze({ error: 3, warning: 2, info: 1 });

/**
 * Expand a compiled pattern into concrete sample paths, so one rule can be
 * tested against another without hand-written heuristics.
 *
 * The expansion is deliberately bounded: enough samples to prove a superset
 * relation for every pattern shape this module produces, not a general
 * theorem prover.
 *
 * @param {object} rule compiled pattern
 * @param {number} [limit]
 * @returns {string[]}
 */
function samplePaths(rule, limit = 24) {
  if (!rule.tokens || rule.tokens.length === 0) return [];

  const { Globstar, Star, AnyChar, CharClass, Literal } = require('./pattern.js')._internal;

  // Each token expands to a few candidate strings; the cartesian product is
  // capped so a pathological pattern cannot blow up the linter.
  //
  // A character class with no ranges cannot match any character, so it has no
  // sample to offer and the whole pattern has none either. That is not a
  // hypothetical: a class whose only member was the slash has exactly zero
  // ranges, because no class ever matches a slash (see `excludeSlash`), and
  // `x[/]y` is therefore a rule that matches nothing at all. Returning [] for
  // it is also the only sound answer, since `covers` requires every sample of the
  // inner rule to be matched by the outer one and there is nothing to check.
  const expand = {
    [Globstar.name]: () => ['', 'x/', 'x/y/'],
    [Star.name]: () => ['', 'a', 'abc'],
    [AnyChar.name]: () => ['a', 'z'],
    [CharClass.name]: (t) => (t.ranges.length ? [t.ranges[0][0], t.ranges[0][1]] : []),
    [Literal.name]: (t) => [t.ch],
  };

  let current = [''];
  for (const token of rule.tokens) {
    const choices = (expand[token.constructor.name] || (() => ['']))(token);
    const next = [];
    for (const head of current) {
      for (const c of choices) next.push(head + c);
      if (next.length > limit * 4) break;
    }
    current = next.slice(0, limit);
    if (current.length === 0) return [];
  }

  const paths = current
    .map((p) => p.replace(/^\/+/, '').replace(/\/{2,}/g, '/').replace(/\/$/, ''))
    .filter((p) => p !== '');

  // A leading `.*`-style prefix comes from an unanchored pattern; sample it at
  // depth as well so `foo` and `a/foo` are both represented.
  const deep = paths
    .filter((p) => p !== '')
    .map((p) => `deep/${p}`)
    .map((p) => `deep/er/${p}`);

  const all = [...paths, ...deep];

  // Only keep samples the rule actually matches, so a superset test is sound.
  return all.filter((p) => rule.regex.test(p)).slice(0, limit);
}

/** True when `outer` matches everything `inner` matches (over the samples). */
function covers(outer, inner) {
  if (!outer.regex || !inner.regex) return false;
  if (outer.negated) return false;
  const samples = samplePaths(inner);
  if (samples.length === 0) return false;
  if (outer.dirOnly && !inner.dirOnly) {
    // A directory-only rule cannot cover a file rule: it never matches files,
    // so anything the file rule matches stays matched.
    const anyFileSample = samples.some((s) => inner.matches(s, false));
    if (anyFileSample) return false;
  }
  return samples.every((s) => outer.matches(s, inner.dirOnly));
}

/**
 * Lint one already-compiled rule list.
 *
 * @param {object[]} rules compiled patterns carrying `line` and `text`
 * @returns {{line: number, code: string, severity: string, message: string, fix?: string}[]}
 */
function lintRules(rules) {
  const out = [];
  const active = rules.filter((r) => !r.isComment && !r.isEmpty);

  const add = (rule, code, severity, message, fix) => {
    const d = { line: rule.line, code, severity, message };
    if (fix) d.fix = fix;
    out.push(d);
  };

  // Pass 1: what each individual rule looks like.
  for (const rule of rules) {
    // --- trailing whitespace, on any line including comments -------------
    if (rule.trailingWhitespace) {
      const shown = rule.text.replace(/\s+$/, '') + '<spaces>';
      add(
        rule,
        'trailing-whitespace',
        'warning',
        rule.trailingWhitespace.count === 1
          ? 'trailing whitespace is stripped by git and is almost certainly accidental'
          : `trailing ${rule.trailingWhitespace.count} spaces are stripped by git and are almost certainly accidental`,
        `remove the trailing space (use "\\ " to match a literal trailing space): ${shown}`
      );
    }

    if (rule.isComment || rule.isEmpty) continue;

    // --- a rule that can only match a doubled slash -----------------------
    // No path contains `//`, so the rule never fires. git agrees: `/**//`,
    // `a//b` and `a\//` all ignore nothing. Silence here is what let a rule that
    // git applies to zero paths look identical to a working one, and before the
    // matcher was fixed `/**//` was not merely useless but reported as
    // excluding the whole repository.
    // A rule can be inert for more than one reason, and the fix differs, so the
    // message has to name the actual one. `deadReason` is set by parsePattern;
    // anything without one is the doubled-slash case handled here.
    if (rule.isDead) {
      const DEAD = {
        'unterminated-class': [
          'this rule has a "[" that is never closed, and git drops the whole rule, so it never matches anything',
          'close the bracket, or escape it as "\\[" for a literal one',
        ],
        'dangling-escape': [
          'this rule ends with a backslash that escapes nothing, and git drops the whole rule, so it never matches anything',
          'remove the trailing backslash, or write "\\\\" for a literal one',
        ],
      };
      const [why, fix] = DEAD[rule.deadReason] || [
        'this rule requires a doubled "/", which no path can contain, so it never matches anything',
        'remove the duplicated separator',
      ];
      add(rule, 'never-matches', 'error', why, fix);
    }

    // --- negation with nothing to negate ---------------------------------
    const prior = active.slice(0, active.indexOf(rule)).filter((r) => !r.negated);
    if (rule.negated && prior.length === 0) {
      add(
        rule,
        'never-matches',
        'error',
        'negation with no preceding rule to undo, so it can never re-include anything',
        'add the rule this line is meant to undo above it'
      );
    }

    // --- redundant leading globstar --------------------------------------
    // `**/foo` and `foo` both mean "foo at any depth" for an unanchored name.
    if (
      rule.leadGlobstarPrefix &&
      rule.tokens.length > 0 &&
      !rule.body.includes('/') &&
      !rule.globstarOnly
    ) {
      const withoutGlobstar = rule.body;
      add(
        rule,
        'redundant-globstar',
        'warning',
        `leading globstar is redundant: "${rule.stripped}" and "${withoutGlobstar}" match the same paths`,
        withoutGlobstar
      );
    }

    // --- globstar where a star would do ----------------------------------
    if (rule.degradedGlobstarCount > 0) {
      // Collapse ONLY the runs git actually collapsed. A blanket
      // `.replace(/\*\*+/g, '*')` also caught the runs that work: on
      // `x**/y**/z` only the second run degrades, but the fix rewrote both and
      // offered `x*/y*/z`, which stops matching `x/a/y/z` -- a path git does
      // ignore. A fixer that changes which files are ignored is worse than no
      // fixer, so the spans come from the parser, not from a regex.
      const spans = (rule.degradedGlobstarSpans || []).slice().sort((a, b) => b[0] - a[0]);
      let collapsed = rule.stripped;
      for (const [at, len] of spans) collapsed = collapsed.slice(0, at) + '*' + collapsed.slice(at + len);
      add(
        rule,
        'globstar-not-needed',
        'warning',
        `"${rule.stripped}" contains a globstar that is not between slashes, so git collapses it to a single "*"`,
        collapsed
      );
    } else if (rule.globstarOnly && rule.tokens.length === 1) {
      // A bare `**` matches everything; say so, since it usually is a mistake.
      add(
        rule,
        'globstar-not-needed',
        'warning',
        'a bare "**" excludes every path in the tree, including .git internals'
      );
    }

    // --- anchoring that probably is not what was meant -------------------
    if (rule.anchored && !rule.slashAnchored && rule.body.includes('/')) {
      const [head] = rule.body.split('/');
      add(
        rule,
        'anchor-suspicious',
        'info',
        `"${rule.stripped}" contains a slash, which anchors it to the repository root; ` +
          `it will not match "${head}" at any other depth`,
        `**/${rule.stripped.replace(/^\/+/, '')}`
      );
    }
  }

  // Pass 2: relationships between rules.
  const seen = new Map();

  for (const rule of rules) {
    if (rule.isComment || rule.isEmpty) continue;

    // --- duplicate rule ---------------------------------------------------
    const key = `${rule.negated ? '!' : ''}|${rule.stripped}`;
    if (seen.has(key)) {
      add(
        rule,
        'duplicate-rule',
        'warning',
        `duplicate of the rule on line ${seen.get(key)}`,
        null
      );
    } else {
      seen.set(key, rule.line);
    }

    // --- shadowed by a later rule -----------------------------------------
    for (let j = active.indexOf(rule) + 1; j < active.length; j++) {
      const later = active[j];
      if (covers(later, rule)) {
        // A negation after the covering rule could still rescue some paths.
        const rescued = active.slice(j + 1).some((r) => r.negated);
        if (rescued) continue;
        add(
          rule,
          'shadowed-rule',
          'error',
          `this rule is shadowed by "${later.stripped}" on line ${later.line}, ` +
            'which already matches everything it matches',
          `remove this line or move it after line ${later.line}`
        );
        break;
      }
    }
  }

  out.sort((a, b) => a.line - b.line || SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
  return out;
}

/**
 * Lint raw .gitignore text.
 *
 * @param {string} text
 * @returns {{line: number, code: string, severity: string, message: string, fix?: string}[]}
 */
function lint(text) {
  const { parseFile } = require('./pattern.js');
  return lintRules(parseFile(text).rules);
}

module.exports = { lint, lintRules, samplePaths, covers, SEVERITIES, SEVERITY_RANK };