'use strict';

/**
 * matcher.js - apply an ordered rule list to a path, the way git does.
 *
 * Three rules govern the outcome, in this order of authority:
 *
 *  1. LAST MATCH WINS. Every rule that matches the path is considered in file
 *     order; the final one decides. A negated pattern therefore re-includes a
 *     path that an earlier rule excluded, but only until some later rule
 *     excludes it again.
 *
 *  2. A DIRECTORY RULE ALSO COVERS ITS CONTENTS. `build/` excludes everything
 *     below `build`, which falls out of checking ancestors (see 3).
 *
 *  3. IT IS NOT POSSIBLE TO RE-INCLUDE A FILE IF A PARENT DIRECTORY OF IT IS
 *     EXCLUDED. This is the rule that surprises people, and it is not a
 *     special case in the code - it is what happens when you notice that git
 *     never descends into an excluded directory, so nothing inside it is ever
 *     examined and no negation inside can take effect.
 *
 *     Concretely:
 *         build/
 *         !build/keep.txt
 *     does NOT re-include `build/keep.txt`, because `build` itself is excluded
 *     and git stops at the directory boundary. Whereas
 *         build/*
 *         !build/keep.txt
 *     DOES re-include it, because `build/*` does not match the directory `build`
 *     itself - only its contents - so the directory is still traversed.
 *
 * The matcher models all of this explicitly so `explain()` can show its work.
 */

/**
 * Normalise a repository-relative path: strip a leading `./` or `/`, collapse
 * repeated slashes, and drop a trailing slash.
 *
 * A BACKSLASH IS NOT TOUCHED, and that is deliberate. This used to rewrite
 * every `\` to `/` as a Windows-path convenience, which silently broke every
 * pattern that mentions a backslash: on POSIX a backslash is an ordinary
 * filename character, so `a\b` and `a/b` are two different paths and git
 * compares them as such. The rewrite made the second unreachable.
 *
 * Measured with `git check-ignore`:
 *
 *     rules `a\\b`  path `a\b`     git IGNORES, this matcher said "kept"
 *     rules `a\\b`  path `a\\b`    git IGNORES, this matcher said "kept"
 *     rules `b/`   path `a\b/c`   git KEEPS, this matcher ignored it
 *
 * The third is the dangerous direction: a rule that git does not apply was
 * applied, which is a false "ignored" on a path nobody asked git about.
 *
 * Nothing needs the convenience: a repository-relative git path is already
 * `/`-separated (`git ls-files`, `git check-ignore` and `git status` all emit
 * forward slashes on every platform), and Node's `fs` accepts `/` on Windows
 * too. So callers already have a form that needs no rewriting.
 *
 * @param {string} p
 * @returns {string}
 */
function normalizePath(p) {
  let s = String(p == null ? '' : p);
  while (s.startsWith('./')) s = s.slice(2);
  s = s.replace(/^\/+/, '');
  s = s.replace(/\/{2,}/g, '/');
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

/**
 * Every ancestor directory of `path`, outermost first.
 *
 * `a/b/c.txt` yields `['a', 'a/b']`. A bare name yields `[]`.
 *
 * @param {string} path already normalised
 * @returns {string[]}
 */
function ancestorsOf(path) {
  const parts = path.split('/');
  parts.pop(); // drop the leaf itself
  const out = [];
  let acc = '';
  for (const part of parts) {
    acc = acc === '' ? part : `${acc}/${part}`;
    out.push(acc);
  }
  return out;
}

/**
 * Resolve a single path against the rule list, ignoring ancestors.
 *
 * @param {object[]} rules compiled patterns, in file order
 * @param {string} path normalised path
 * @param {boolean} isDir
 * @returns {{matched: boolean, ignored: boolean, rule: object|null, index: number,
 *   considered: object[]}}
 */
function resolveOwn(rules, path, isDir) {
  const considered = [];
  let decided = null;
  let index = -1;

  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    const entry = { rule, line: rule.line, text: rule.text, matched: false, action: 'skip' };

    if (rule.isComment) {
      entry.action = rule.isEmpty ? 'blank' : 'comment';
      considered.push(entry);
      continue;
    }

    if (!rule.regex || rule.isEmpty) {
      entry.action = 'no-effect';
      considered.push(entry);
      continue;
    }

    const hit = rule.matches(path, isDir);
    entry.matched = hit;
    if (hit) {
      entry.action = rule.negated ? 're-include' : 'ignore';
      decided = rule;
      index = i;
    }
    considered.push(entry);
  }

  return {
    matched: decided !== null,
    ignored: decided !== null && !decided.negated,
    rule: decided,
    index,
    considered,
  };
}

/**
 * Build a matcher from an ordered rule list.
 *
 * @param {object[]} rules compiled patterns (see pattern.js)
 * @returns {{
 *   rules: object[],
 *   matches(path: string, isDir?: boolean): boolean,
 *   ignore(path: string, isDir?: boolean): boolean,
 *   explain(path: string, isDir?: boolean): object
 * }}
 */
function createMatcher(rules) {
  if (!Array.isArray(rules)) {
    throw new TypeError('createMatcher expects an array of compiled patterns');
  }

  const list = rules.filter(Boolean);

  /**
   * Does any rule match this path? Ignores negation and ancestor handling, and
   * exists for callers that just want pattern-level coverage.
   */
  function matches(path, isDir = false) {
    const p = normalizePath(path);
    if (p === '') return false;
    return list.some((r) => !r.isComment && r.regex && !r.isEmpty && r.matches(p, isDir));
  }

  /**
   * Full precedence resolution. Returns true when the path is ignored.
   */
  function ignore(path, isDir = false) {
    return explain(path, isDir).ignored;
  }

  /**
   * Full precedence resolution, with the reasoning kept intact so the CLI can
   * print it.
   *
   * @param {string} path
   * @param {boolean} [isDir]
   * @returns {{
   *   path: string, isDir: boolean, ignored: boolean,
   *   rules: object[], ancestors: object[],
   *   blockingAncestor: object|null, decidingRule: object|null,
   *   reason: string
   * }}
   */
  function explain(path, isDir = false) {
    const p = normalizePath(path);
    const own = resolveOwn(list, p, isDir);

    const ancestors = [];
    let blockingAncestor = null;

    for (const a of ancestorsOf(p)) {
      const verdict = resolveOwn(list, a, true);
      ancestors.push({ path: a, ...verdict });
      if (verdict.ignored && blockingAncestor === null) {
        blockingAncestor = { path: a, ...verdict };
      }
    }

    // An excluded ancestor directory stops git before it ever looks inside, so
    // it outranks whatever the leaf's own rules decided.
    const ignored = blockingAncestor !== null ? true : own.ignored;

    let reason;
    if (ignored && blockingAncestor) {
      reason =
        `parent directory "${blockingAncestor.path}" is excluded, ` +
        `so nothing inside it can be re-included`;
    } else if (own.ignored) {
      reason = `last matching rule (line ${own.rule.line}) excludes it`;
    } else if (own.matched) {
      reason = `last matching rule (line ${own.rule.line}) re-includes it`;
    } else {
      reason = 'no rule matches it';
    }

    return {
      path: p,
      isDir,
      ignored,
      matched: own.matched,
      decidingRule: own.rule,
      decidingIndex: own.index,
      considered: own.considered,
      ancestors,
      blockingAncestor,
      reason,
    };
  }

  return { rules: list, matches, ignore, explain };
}

module.exports = {
  createMatcher,
  normalizePath,
  ancestorsOf,
  resolveOwn,
};