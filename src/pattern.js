'use strict';

/**
 * pattern.js - compile one .gitignore line into a matcher.
 *
 * Supported syntax (a faithful subset of git's gitignore(5)):
 *
 *   literal          build            matches build at any depth
 *   star             *.log            any run of characters, never crossing /
 *   globstar         a[STARSTAR]/b    zero or more directories
 *   any-char         ?.txt            exactly one character, never /
 *   class            [a-z], [!ab]     one character from / not in a set,
 *                                   and never a / either -- see excludeSlash
 *   anchor           /build, a/b      a slash anywhere but the end anchors to root
 *   dir-only         build/           matches directories only
 *   negation         !build/keep.txt  re-includes a previously ignored path
 *   comment          # note           ignored (an escaped hash is not)
 *   escape           "\ ", "\#", "\!" backslash escapes the next character
 *
 * NOTE: never write a globstar immediately followed by a slash inside a
 * [STARSTAR]-delimited doc comment - the slash closes the comment. Patterns
 * that need it are quoted, e.g. "a[STARSTAR]/b", in prose.
 *
 * Trailing spaces are stripped unless backslash-escaped, matching git.
 *
 * A compiled pattern exposes:
 *   source     the raw text this pattern was compiled from
 *   negated    leading `!` (and was a rule, not a comment)
 *   dirOnly    trailing slash
 *   anchored   a slash appears anywhere except at the very end
 *   isGlob     the pattern contains at least one wildcard
 *   comment    the line was a comment / blank, i.e. it is not a rule
 *   matches(path, isDir)  does this pattern match path?
 */

const GLOBSTAR = '**';
const STAR = '*';

/** Character source for `?`: one character that is not a slash. */
const NON_SLASH = '[^/]';

/** The slash itself. */
const SLASH = '/';

/** The same slash, escaped for use inside a RegExp. */
const SLASH_RE = '\\/';

/**
 * Remove the slash from a set of ranges, splitting any range that spans it.
 *
 * This is the one place a bracket class and the rest of the pattern have to
 * agree. Everywhere else a wildcard that matches "any characters" is barred
 * from crossing a slash -- `*` compiles to `[^/]*`, `?` to `[^/]`, a literal
 * slash is emitted escaped -- and a class is supposed to be barred the same
 * way. It was not: the class was emitted as `[a\/]` and `[--\/]`, i.e. with
 * the slash EXPLICITLY INCLUDED, which is the exact opposite of every other
 * token. Measured against `git check-ignore`, the real behaviour is that no
 * character class ever matches a slash:
 *
 *     [x/a]y   on "xay" -> ignored     [x/a]y  on "x/y"  -> kept
 *     [x/-]y   on "x-y" -> ignored     [x/-]y  on "x/y"  -> kept
 *     [x!/]y   on "xay" -> ignored     [x!/]y  on "x/y"  -> kept
 *
 * The negated form needs no change here, for the same reason: "every class is
 * barred from the slash" is the same statement as "a negated class excludes
 * the slash", which `classToRegex` already spells by starting its set with `/`.
 *
 * A RANGE that straddles the slash is split rather than dropped, so its other
 * members survive -- also measured, because the naive fixes disagree here:
 *
 *     [+-0]  (0x2B..0x30) -> matches + , - . 0 but never /     -> two ranges
 *     [,-1]  (0x2C..0x31) -> matches , - . 0 1 but never /     -> two ranges
 *     [+-/]  (0x2B..0x2F) -> matches + , - .                   -> one range
 *     [/-0]  (0x2F..0x30) -> matches 0                         -> one range
 *
 * Dropping such a range outright would lose `0-9` in `[0-9/`-shaped classes and
 * keeping it whole would reintroduce the slash, so it is split at 0x2F.
 *
 * @param {Array<[string, string]>} ranges
 * @returns {Array<[string, string]>} ranges with the slash removed
 */
function excludeSlash(ranges) {
  const slash = SLASH.charCodeAt(0);
  const before = String.fromCharCode(slash - 1);
  const after = String.fromCharCode(slash + 1);
  const out = [];
  for (const [lo, hi] of ranges) {
    const loCode = lo.charCodeAt(0);
    const hiCode = hi.charCodeAt(0);
    if (loCode > hiCode) {
      // A reversed range matches nothing at all, so there is nothing to keep.
      continue;
    }
    if (hiCode < slash) {
      out.push([lo, hi]);
    } else if (loCode > slash) {
      out.push([lo, hi]);
    } else {
      // The span contains the slash: keep what is on either side of it.
      if (loCode < slash) out.push([lo, before]);
      if (hiCode > slash) out.push([after, hi]);
    }
  }
  return out;
}

/** Escape a character for literal use inside a RegExp. */
function escapeRe(ch) {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A `[...]` character class, parsed into ranges so matching needs no RegExp.
 *
 * The ranges never contain the slash: see `excludeSlash`, which strips it while
 * parsing. A class that held nothing but a slash therefore arrives here with an
 * empty range list, and such a class matches NOTHING -- verified against git,
 * which keeps `x[/]y` from matching `x[/]y`, `x[]y`, `x/]y` or anything else.
 * Emitting an empty `[...]` is exactly that: JavaScript treats `[]` as a class
 * with no members, so the RegExp matches no character at all and the pattern can
 * never fire.
 */
class CharClass {
  constructor(negated, ranges) {
    this.negated = negated;
    this.ranges = excludeSlash(ranges);
  }

  test(ch) {
    let hit = false;
    for (let k = 0; k < this.ranges.length; k++) {
      if (ch >= this.ranges[k][0] && ch <= this.ranges[k][1]) {
        hit = true;
        break;
      }
    }
    return this.negated ? !hit : hit;
  }

  /** Rough count of possible matches, used by lint's shadow analysis. */
  get size() {
    return this.negated ? 62 : this.ranges.length;
  }

  toString() {
    return `[${this.negated ? '!' : ''}${this.ranges
      .map(([lo, hi]) => (lo === hi ? lo : `${lo}-${hi}`))
      .join('')}]`;
  }
}

/** A globstar: any sequence of characters, slashes included. */
class Globstar {
  constructor(followedBySlash, escapedSlash) {
    this.followedBySlash = Boolean(followedBySlash);
    // Set when the slash that follows this run is an ESCAPED one. The run still
    // spans directory levels, but the separator becomes MANDATORY. See
    // buildRegex.
    this.escapedSlash = Boolean(escapedSlash);
    // Set when this run absorbs one of the two separators of a doubled pair,
    // which pins its expansion to the empty string. See parsePattern.
    this.absorbsSlash = false;
  }

  get size() {
    return Infinity;
  }

  toString() {
    return GLOBSTAR;
  }
}

/** A single `*`: any run of characters, but never a slash. */
class Star {
  get size() {
    return 62;
  }

  toString() {
    return STAR;
  }
}

/** A `?`: exactly one character, never a slash. */
class AnyChar {
  get size() {
    return 62;
  }

  toString() {
    return '?';
  }
}

/** A literal character, possibly produced by a backslash escape. */
class Literal {
  constructor(ch) {
    this.ch = ch;
  }

  get size() {
    return 1;
  }

  toString() {
    return this.ch;
  }
}

/**
 * Find the index of the `]` closing a class opened at `start`.
 * Returns -1 when the class is unterminated (git then treats `[` as literal).
 */
function findClassEnd(s, start) {
  let i = start + 1;
  if (s[i] === '!' || s[i] === '^') i++;
  if (s[i] === ']') i++; // a leading `]` is a literal member
  while (i < s.length) {
    if (s[i] === '\\') {
      i += 2;
      continue;
    }
    if (s[i] === ']') return i;
    i++;
  }
  return -1;
}

/**
 * Parse the interior of a `[...]` class into `[lo, hi]` ranges.
 * Handles `a-z` spans and backslash-escaped endpoints.
 *
 * A REVERSED range (`9-0`, `z-a`, `b-a`) is not an error and not a whole-class
 * rejection: git keeps the first endpoint as an ordinary member and carries on
 * parsing after the second one. Measured with `git check-ignore`, probing every
 * printable ASCII character in place of the class:
 *
 *     [9-0]    => {9}          not {9, -, 0}   and not nothing
 *     [z-a]    => {z}
 *     [b-a0]   => {0, b}       resumes after the high endpoint, so the trailing
 *                                literal 0 survives as a member
 *     [9-0-8]  => {-, 8, 9}    resumes at the `-`, which is then a literal
 *     [a-\]]   => {a}
 *
 * Two things had to change for that. The old code only tested `hi >= lo` and,
 * on failure, fell through to `ranges.push([lo, lo])` WITHOUT advancing the
 * cursor -- so the `-` and the high endpoint were parsed again as ordinary
 * members, giving {9, -, 0}. And a lone `-` member next to another range emits
 * `[9-8]`, which is a reversed range in the emitted RegExp and makes
 * `new RegExp` throw "Range out of order in character class" -- so a `.gitignore`
 * line that git accepts took the whole linter down at parse time.
 */
function parseRanges(clsBody) {
  const ranges = [];
  let k = 0;
  while (k < clsBody.length) {
    const readChar = () => {
      let ch = clsBody[k];
      if (ch === '\\' && k + 1 < clsBody.length) return [clsBody[k + 1], 2];
      return [ch, 1];
    };

    const [lo, loStep] = readChar();
    k += loStep;

    // A range needs `lo`, a literal `-`, and a higher endpoint.
    if (k < clsBody.length && clsBody[k] === '-' && k + 1 < clsBody.length) {
      const [hi, hiStep] = readCharAt(clsBody, k + 1);
      if (hi >= lo) {
        ranges.push([lo, hi]);
        k += 1 + hiStep;
        continue;
      }
      // Reversed: `lo` survives as a member and parsing resumes past `hi`. The
      // cursor must move to the END of the rejected range, not stay where it
      // was -- leaving it put re-reads both the dash and the high endpoint as
      // fresh members, which is how {9} became {9, -, 0}.
      ranges.push([lo, lo]);
      k += 1 + hiStep;
      continue;
    }
    ranges.push([lo, lo]);
  }
  return ranges;
}

function readCharAt(s, i) {
  if (s[i] === '\\' && i + 1 < s.length) return [s[i + 1], 2];
  return [s[i], 1];
}

/** A negated class needs an explicit safe set; enumerating is least surprising. */
function classToRegex(cls) {
  // Inside a character class a slash still needs escaping, otherwise the
  // trailing `/]` of the emitted class would terminate the RegExp early.
  //
  // A DASH needs escaping too, but only in one specific case. When a lone `-`
  // member is adjacent to a real range the two merge into something the RegExp
  // engine reads as a reversed range: {9}, {-}, {0, 8} emitted as `[9--0-8]` or
  // `[9-0-8]`, and `new RegExp` throws "Range out of order in character class".
  // That is reachable from ordinary gitignore text, because `[9-0]` parses to
  // exactly {9} and `[9-0-8]` to {-, 8, 9} -- see parseRanges.
  //
  // Escaping it unconditionally is simpler than working out when the
  // neighbour could bind it, and `\-` means the same character as `-` inside a
  // class, so the escape is free. It is applied to a lone dash only: the dash
  // BETWEEN the endpoints of a genuine range must stay unescaped or the range
  // stops being a range.
  const member = (ch) => {
    if (ch === '/') return '\\/';
    if (ch === '-') return '\\-';
    return escapeRe(ch);
  };

  if (cls.negated) {
    const excluded = [];
    for (const [lo, hi] of cls.ranges) {
      for (let c = lo.codePointAt(0); c <= hi.codePointAt(0); c++) {
        excluded.push(String.fromCodePoint(c));
      }
    }
    const body = excluded.map(member).join('') || '\\x00';
    return `[^/${body}]`;
  }

  const alts = cls.ranges.map(([lo, hi]) => {
    const a = member(lo);
    return lo === hi ? a : `${a}-${member(hi)}`;
  });
  return `[${alts.join('')}]`;
}

function tokenToRegex(token) {
  if (token instanceof Globstar) return '.*';
  if (token instanceof Star) return '[^/]*';
  if (token instanceof AnyChar) return NON_SLASH;
  if (token instanceof CharClass) return classToRegex(token);
  // A literal slash must be escaped, or it would terminate the RegExp.
  if (token.ch === '/') return '\\/';
  return escapeRe(token.ch);
}

/**
 * Strip unescaped trailing spaces. A trailing space run is literal only when it
 * is escaped by an *odd* number of immediately preceding backslashes, which is
 * exactly how git decides it.
 */
function stripTrailingSpaces(line) {
  let end = line.length;
  while (end > 0 && line[end - 1] === ' ') end--;
  if (end === line.length) return line;
  let i = end - 1;
  let backslashes = 0;
  while (i >= 0 && line[i] === '\\') {
    backslashes++;
    i--;
  }
  return backslashes % 2 === 1 ? line : line.slice(0, end);
}

/**
 * Raw line metadata used by the linter. Kept apart from compilation so lint
 * rules can see what the author *wrote* rather than what it means.
 */
function inspectRaw(line) {
  const escapeAt = [];
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\' && i + 1 < line.length) {
      escapeAt.push(i);
      i++;
    }
  }

  // A trailing space run that is *not* escaped.
  let end = line.length;
  while (end > 0 && line[end - 1] === ' ') end--;
  let trailingWhitespace = null;
  if (end < line.length) {
    let i = end - 1;
    let backslashes = 0;
    while (i >= 0 && line[i] === '\\') {
      backslashes++;
      i--;
    }
    if (backslashes % 2 === 0) {
      trailingWhitespace = {
        start: end,
        end: line.length,
        count: line.length - end,
      };
    }
  }

  return { escapeAt, trailingWhitespace };
}

/**
 * Turn a pattern body into a flat token array plus the structural facts the
 * matcher and the linter both need.
 *
 * @param {string} raw the line with negation, dir-only marker and comment
 *   syntax already removed but escapes still intact.
 */
function parseBody(raw) {
  let body = raw;

  // Leading `!` negates. An escaped `\!` is a literal bang and must NOT negate,
  // matching git: `\!important` is a rule for a file named `!important`.
  let negated = false;
  if (body[0] === '!') {
    negated = true;
    body = body.slice(1);
  }

  // How much has been cut off the FRONT by the syntax handled below. Spans of
  // degraded runs are collected against the sliced `body`, so anything that
  // reports a character offset -- the linter's fixer -- needs this to translate
  // back into the line the user actually wrote.
  let frontOffset = negated ? 1 : 0;

  // A trailing slash restricts the rule to directories.
  let dirOnly = body.length > 0 && body[body.length - 1] === '/';
  if (dirOnly) body = body.slice(0, -1);

  // A leading globstar means "at any depth", which is *not* anchoring even
  // though it contains a slash.
  let leadGlobstarPrefix = false;
  if (body === GLOBSTAR) {
    // A bare globstar: matches everything. Keep it as a token so the matcher
    // and the linter can both see it.
    leadGlobstarPrefix = true;
  } else if (body.startsWith(`${GLOBSTAR}/`)) {
    leadGlobstarPrefix = true;
    body = body.slice(GLOBSTAR.length + 1);
    frontOffset += GLOBSTAR.length + 1;
  }

  // A remaining leading slash is the explicit anchor form.
  const slashAnchored = body.startsWith('/');
  if (slashAnchored) {
    body = body.slice(1);
    frontOffset += 1;
  }

  // Any other slash anywhere in the body anchors the pattern to the root.
  // A leading globstar is the one exception: it means "at any depth".
  const anchored = !leadGlobstarPrefix && (slashAnchored || body.includes('/'));

  const n = body.length;
  const tokens = [];
  let leadGlobstar = false;
  let trailingGlobstar = false;
  let innerGlobstar = false;
  let globstarCount = 0;
  let degradedGlobstarCount = 0;
  const degradedGlobstarSpans = [];
  let isGlob = false;
  // True while nothing but LITERAL characters have been consumed. git matches a
  // pattern in two steps (dir.c): it strips the leading run of non-wildcard
  // characters -- `simple_length()`, which stops at the first of `*`, `?`, `[`
  // or `\` -- and hands the REMAINDER to wildmatch(3) on its own. So a `**` that
  // begins the remainder is at the start of the pattern wildmatch sees, which is
  // exactly the position its globstar test allows:
  //
  //     else if ((prev_p - pattern < 2 || *(prev_p - 2) == '/') && ...)
  //
  // That is why `q**/b` is a globstar and spans directories even though `q`
  // precedes the run: the `q` was stripped as the literal prefix before the run
  // was ever examined. It is also why `*q**/b` is NOT one: its prefix is empty,
  // so the run is preceded by `q` inside the pattern proper, and it degrades.
  //
  // Verified with `git check-ignore`, one throwaway repo per case:
  //
  //     q**/b      qb IGN   q/b IGN   q/a/b IGN   q/a/c/b IGN   (globstar)
  //     q*/b       qb ---   q/b IGN   q/a/b ---                      (control)
  //     *q**/b     qb ---   p/qb ---   p/qb/c ---                    (degraded)
  //     ?q**/b     aqb ---  p/aqb ---                                  (degraded)
  //     [q]**/b    qb ---   p/qb ---                                   (degraded)
  //     a\.x**/b   a.bc --- ...                     (the backslash starts the remainder)
  let atGlobBase = true;

  for (let i = 0; i < n; ) {
    const ch = body[i];

    // Escape: the next character is literal.
    if (ch === '\\' && i + 1 < n) {
      tokens.push(new Literal(body[i + 1]));
      // A backslash is one of the characters `simple_length()` stops at, so an
      // escape begins the remainder even though it contributes a literal token.
      atGlobBase = false;
      i += 2;
      continue;
    }

    if (ch === STAR) {
      isGlob = true;

      // Measure the WHOLE run of asterisks. Two asterisks only start a
      // globstar when the run ENDS there; `***` is not `**` plus a stray `*`,
      // and treating it that way both mis-classified the token and left the
      // third asterisk to be read as a separate star. `a**b` is still a plain
      // star (git collapses an unbounded run), which is why the bound is
      // checked on the run's own end rather than on the two-char lookahead.
      let run = 1;
      while (i + run < n && body[i + run] === STAR) run++;

      if (run >= 2) {
        // wildmatch's own test (dir.c / wildmatch.c):
        //
        //     (prev_p - pattern < 2 || *(prev_p - 2) == '/')
        //         && (*p == '\0' || *p == '/' || (p[0] == '\\' && p[1] == '/'))
        //
        // Read that as TWO conditions. On the right: the run must be followed by
        // a slash (possibly escaped) or by the end of the pattern -- `q**b` and
        // `ab**c` degrade. On the left: the two characters the run starts with
        // must be the start of the pattern wildmatch was handed, or be preceded
        // by a slash.
        //
        // `pattern` there is NOT the whole gitignore line: git strips the leading
        // literal prefix first (simple_length, which stops at the first `*`, `?`,
        // `[` or `\`). So "the start of the pattern" means "the start of whatever
        // is left after the prefix", which is exactly what `atGlobBase` tracks.
        // A slash is not a stop character, so a prefix may contain slashes and the
        // run still qualifies on its left-hand side.
        const after = i + run >= n ? null : body[i + run];
        const escapedSlash = after === '\\' && body[i + run + 1] === '/';
        const rightOk = after === null || after === '/' || escapedSlash;
        // `i` is the offset of the FIRST asterisk in the run.
        const leftOk = atGlobBase || body[i - 1] === '/';
        const bounded = leftOk && rightOk;

        if (!bounded) {
          degradedGlobstarCount++;
          // Record WHERE the run was, so a fixer can collapse exactly this run
          // and leave a working globstar elsewhere in the pattern alone.
          degradedGlobstarSpans.push([i, run]);
          tokens.push(new Star());
          atGlobBase = false;
          i += run;
          continue;
        }

        globstarCount++;
        if (i === 0) leadGlobstar = true;
        if (after === null) trailingGlobstar = true;
        tokens.push(new Globstar(after === '/' || escapedSlash, escapedSlash));
        atGlobBase = false;
        i += escapedSlash ? run + 2 : after === '/' ? run + 1 : run;
        continue;
      }

      tokens.push(new Star());
      atGlobBase = false;
      i += run;
      continue;
    }

    if (ch === '?') {
      isGlob = true;
      tokens.push(new AnyChar());
      atGlobBase = false;
      i++;
      continue;
    }

    if (ch === '[') {
      const close = findClassEnd(body, i);
      if (close !== -1) {
        let inner = body.slice(i + 1, close);
        let neg = false;
        if (inner.startsWith('!') || inner.startsWith('^')) {
          neg = true;
          inner = inner.slice(1);
        }
        const ranges = parseRanges(inner);
        if (ranges.length > 0) {
          isGlob = true;
          tokens.push(new CharClass(neg, ranges));
          // `[` is one of the characters `simple_length()` stops at, so a class
          // ends the literal prefix and the next run is not at its base.
          atGlobBase = false;
          i = close + 1;
          continue;
        }
      }
    }

    tokens.push(new Literal(ch));
    i++;
  }

  if (globstarCount > 0) {
    innerGlobstar = tokens.some((t, k) => {
      if (!(t instanceof Globstar)) return false;
      if (k === 0 || k === tokens.length - 1) return false;
      return true;
    });
  }

  // Rough upper bound on how many strings the body can match; used to decide
  // whether one rule subsumes another.
  let estimatedSize = 1;
  for (const t of tokens) estimatedSize *= t.size;
  if (!Number.isFinite(estimatedSize)) estimatedSize = Infinity;

  const globstarOnly = tokens.every(
    (t) => t instanceof Globstar || (t instanceof Literal && t.ch === '/')
  ) && globstarCount > 0;

  return {
    body,
    negated,
    dirOnly,
    anchored,
    leadGlobstarPrefix,
    slashAnchored,
    tokens,
    isGlob,
    leadGlobstar,
    trailingGlobstar,
    innerGlobstar,
    globstarCount,
    degradedGlobstarCount,
    // Translated into offsets of the ORIGINAL line, so a fixer can splice
    // exactly the runs git collapsed and leave every real globstar intact.
    degradedGlobstarSpans: degradedGlobstarSpans.map(([at, len]) => [at + frontOffset, len]),
    globstarOnly,
    estimatedSize,
  };
}

/**
 * Build the anchored RegExp for a tokenised pattern.
 *
 * Path strings handed to the matcher are relative to the ignore file's
 * directory and never carry a leading slash, so an unanchored pattern is
 * simply "the body, optionally prefixed by any number of directories".
 *
 * The tricky part is that a globstar *inside* the pattern (as opposed to one
 * opening it) can only ever expand to zero directories, never to arbitrary
 * leading ones. A trailing globstar likewise expands to one or more segments
 * below the directory the pattern named. Both cases are handled here so the
 * token loop below stays a straight transcription of the pattern.
 */
function buildRegex(tokens, anchored) {
  if (tokens.length === 0) return new RegExp('(?!)');

  // A lone globstar matches every path.
  if (tokens.length === 1 && tokens[0] instanceof Globstar) {
    return new RegExp('.*');
  }

  // An unanchored pattern may appear at any depth, so allow leading dirs. An
  // anchored one only earns that freedom when a globstar opens the pattern.
  const first = tokens[0];
  const leadingGlobstar = first instanceof Globstar;
  const prefix = !anchored || leadingGlobstar ? '(?:.*/)?' : '';

  // Render the tokens. A globstar followed by a slash is the one token that
  // cannot be a fixed piece of regex body: it stands for "zero directories, with
  // no separator at all" OR "anything, then a separator". Both alternatives are
  // needed, and `rest` may itself contain a globstar, so the alternation has to
  // wrap the WHOLE remainder rather than just the next few characters.
  //
  //     q**/b     ->  ^q(?:.*\/)?b$
  //         qb       the optional group matches nothing
  //         q/b      .* = ''
  //         q/a/b    .* = 'a'
  //     q**/b/c   ->  ^q(?:.*\/)?b\/c$
  //
  // Emitting only `(?:[^/]+/)*` for that token -- which is what this used to do --
  // lost `q/b` outright, and `git check-ignore` reports all of the above ignored.
  //
  // The natural spelling of that alternation is `(?:rest|.*\/rest)`, but it
  // re-renders the tail once per globstar, so the regex grows as 2^n: fourteen
  // globstars compiled to a 277 KB source, and twenty would have tried to build
  // a ~280 MB one. `(?:.*\/)?rest` says exactly the same thing -- zero
  // directories, or some directories each with its separator -- in linear size,
  // because `rest` is emitted once. Verified equivalent on 67 differential cases
  // plus every globstar depth up to fourteen.
  const render = (from) => {
    let out = '';
    let i = from;
    while (i < tokens.length) {
      const t = tokens[i];

      if (t instanceof Globstar) {
        // A run marked `absorbsSlash` has already eaten one of the two
        // separators of a doubled pair, so it cannot expand to anything at
        // all: whatever it matched would have to be inserted between two
        // adjacent separators, and no path has those. This is checked BEFORE
        // the trailing-run and run-followed-by-slash branches, because it
        // overrides both -- a run can be both absorbing and last.
        //
        // Measured against `git check-ignore`, where the run marks the shape
        // that absorbs and the plain run is the control:
        //
        //     a[STARSTAR]/[SLASH]b       ignores a/b, a/b/c      keeps a/x/b
        //     a[STARSTAR]/b              ignores a/b, a/x/b
        //     a[STARSTAR]/[SLASH]        ignores a (a directory)  keeps ab
        //     ab[STARSTAR]/[SLASH]       ignores ab (a directory) keeps abc
        //
        // Emitting the usual "(?:.*\/)?" alternation here would have matched
        // `a/x/b` as well, which git keeps.
        if (t.absorbsSlash) {
          if (i === tokens.length - 1) {
            // Nothing follows, so the run and the separator it ate collapse
            // away entirely and only the head is left: `a` matched exactly,
            // which combined with the dir-only flag means "the directory a",
            // the same thing plain `/a/` compiles to.
            i += 1;
            continue;
          }
          // The run and the single separator after it collapse to one.
          // Anything beyond that renders as an ordinary token sequence -- and
          // a run that is itself absorbing contributes nothing, which is what
          // folds a whole chain of runs into a single separator.
          out += SLASH_RE;
          i += tokens[i + 1] instanceof Globstar ? 1 : 2;
          continue;
        }
        if (i === tokens.length - 1) {
          // A trailing globstar is normally everything INSIDE the named
          // directory: one or more segments, never the directory itself.
          //
          // But that only holds when the run is its own path COMPONENT, i.e.
          // when a slash comes immediately before it. Measured with
          // `git check-ignore -v`, asking whether git ignores the path the
          // run would collapse to:
          //
          //     a/**        a      git KEEPS    component run: needs one+
          //     a/**/**     a      git KEEPS
          //     a*/**       a, ax  git KEEPS
          //     a\/b/**     a/b    git KEEPS
          //     **/a/**     a, x/a git KEEPS
          //
          //     a**         a      git IGNORES  glued run: may be empty
          //     ab**        ab     git IGNORES
          //     x/a**       x/a    git IGNORES
          //     a**/**      a      git IGNORES
          //     a**/**/**   a      git IGNORES
          //     a**/        a(dir) git IGNORES
          //
          // So `a**` ignores the bare name `a` -- the run is allowed to expand
          // to nothing -- while `a/**` does not, because there the run stands
          // for the contents of a directory that has to exist first. The test
          // is exactly whether the preceding token is a literal slash.
          //
          // Emitting an unconditional `.+` therefore made every glued trailing
          // run miss the one path it is supposed to cover: `a**` kept `a`, and
          // with it `x/a`, `ab`/`a-z` and `a**/**`'s own directory.
          const precededBySlash =
            i > 0 && tokens[i - 1] instanceof Literal && tokens[i - 1].ch === SLASH;
          out += precededBySlash ? '.+' : '.*';
          i += 1;
          continue;
        }
        if (t.followedBySlash) {
          // The WHOLE remainder moves inside the group, so `i` jumps past it.
          // Leaving the cursor where it was made this render the tail twice --
          // `q**/b` came out as `q(?:b|.*\/b)b`, which matches nothing at all.
          // Consuming the tail here is also what makes the zero-directory branch
          // work: it skips the slash entirely, so the rest has to go with it.
          //
          // THE ESCAPED SLASH IS NOT OPTIONAL. This is the whole difference
          // between the two spellings, and it was the source of a real bug.
          // wildmatch's globstar test accepts `\/` as the trailing slash --
          //
          //     (*p == '\0' || *p == '/' || (p[0] == '\\' && p[1] == '/'))
          //
          // -- but the branch that stands for ZERO directory levels is entered
          // only on a LITERAL slash. With `\/` the run falls through to the
          // generic star handling, so it still spans slashes yet the separator
          // is REQUIRED. Measured:
          //
          //     q then STARSTAR then slash then b     qb   KEEP
          //     q then STARSTAR then ESC slash then b  qb   IGNORE
          //
          // Emitting the optional group for both made `**\/b` ignore the bare
          // name `b`, which git keeps. Every disagreement in the escaped-slash
          // family came from this one branch.
          if (t.escapedSlash) {
            // The tokenizer consumed the two characters of the escape, so there
            // is no Literal('/') token to render: emit the separator here.
            //
            // `render(i + 1)` has already consumed the whole remainder, so the
            // cursor has to jump to the end rather than step on by one. Stepping
            // on re-renders the tail and produced `**\/b` as `.*\/bb`.
            out += `.*\\/${render(i + 1)}`;
            i = tokens.length;
            continue;
          }
          out += `(?:.*\\/)?${render(i + 1)}`;
          i = tokens.length;
          continue;
        }
        // A globstar glued to text spans arbitrary characters, slashes included.
        out += '.*';
        i += 1;
        continue;
      }

      out += tokenToRegex(t);
      i += 1;
    }
    return out;
  };

  return new RegExp(`^${prefix}${render(0)}$`);
}

/**
 * Compile one .gitignore line.
 *
 * @param {string} line raw line, without its trailing newline
 * @returns {object} compiled pattern
 */
function parsePattern(line) {
  const raw = String(line == null ? '' : line);
  const info = inspectRaw(raw);
  const stripped = stripTrailingSpaces(raw);

  const compiled = {
    source: raw,
    stripped,
    line: 0,
    text: raw,
    isComment: false,
    isEmpty: false,
    commentKind: null,
    negated: false,
    dirOnly: false,
    anchored: false,
    isGlob: false,
    body: '',
    tokens: [],
    regex: null,
    escapeAt: info.escapeAt,
    trailingWhitespace: info.trailingWhitespace,
    hasEscapedHash: stripped.startsWith('\\#'),
    matches: () => false,
  };

  if (stripped.trim() === '') {
    compiled.isComment = true;
    compiled.isEmpty = true;
    compiled.commentKind = 'blank';
    return compiled;
  }

  if (stripped[0] === '#') {
    compiled.isComment = true;
    compiled.commentKind = 'comment';
    return compiled;
  }

  const parsed = parseBody(stripped);

  // A REPEATED SLASH cannot occur in a path, so a rule that demands one matches
  // nothing at all. This is measured on the stripped line, BEFORE parseBody
  // removes the dir-only trailing slash -- otherwise the evidence is destroyed:
  // `a//` becomes the body `a/`, and `/**//` becomes `**/`, whose globstar then
  // swallows the leftover separator and leaves a lone Globstar token that
  // compiles to /.*/ -- a rule git ignores NOTHING reported as ignoring the
  // entire repository.
  //
  // But "a doubled slash is always dead" is WRONG, and the differential fuzzer
  // is what proved it. A GLOBBAR RUN CAN ABSORB the first of the two
  // separators, leaving an ordinary `/**` component run behind. Measured token
  // stream against `git check-ignore`, where `L"/"` is a literal slash and `G/`
  // is a globstar that already took a slash:
  //
  //     a**//      [L"a" G/]                 IGNORES a
  //     ab**//     [L"a" L"b" G/]            IGNORES ab
  //     x/a**//    [L"x" L"/" L"a" G/]      IGNORES x/a/b
  //     a**//b     [L"a" G/ L"/" L"b"]      IGNORES a/b
  //     a**//**    [L"a" G/ L"/" G]         IGNORES a/b
  //
  // Every live shape has the SAME shape: a run that is GLUED to what precedes
  // it (no literal slash in front of it), whose absorbed slash is the first of
  // the doubled pair, and with at most ONE literal segment left after it.
  //
  //     /**//      [G/]                      nothing   <- run not glued
  //     a/**//     [L"a" L"/" G/]            nothing   <- run not glued
  //     **/**//    [G/]                      nothing
  //     a/**//b    [L"a" L"/" G/ L"/" L"b"]  nothing
  //     /**///     [G/ L"/"]                 nothing
  //     a**///     [L"a" G/ L"/"]            nothing   <- TWO slashes left
  //     a**////    [L"a" G/ L"/" L"/"]       nothing
  //     **/a**//   [L"a" G/]                 nothing   <- anchored differently
  //     x//**//    [L"x" L"/" L"/" G/]      nothing   <- doubled slash first
  //     a**//bc    [L"a" G/ L"/" L"b" L"c"]  nothing   <- two segments left
  //     a**//b//   [L"a" G/ L"/" L"b" L"/"]  nothing
  //
  // Escapes are read through: `a\/b` is ONE literal slash and stays live,
  // while `a\//` is a literal slash followed by a real one and is dead. The
  // prefix group skips whole escape sequences so a trailing `\\` is consumed
  // as a unit. The text rule cannot see an escaped PAIR (`a\/\/b` is two
  // literal slashes with no adjacent characters in the source), so the token
  // stream is checked as well.
  //
  // `**//` and `//` leave no tokens at all and are already reported as empty.
  const doubledSlashText = /(?:\\.|[^\\])*?\/\//.test(stripped);
  const doubledSlashTokens = parsed.tokens.some(
    (t, k) =>
      t instanceof Literal &&
      t.ch === SLASH &&
      parsed.tokens[k + 1] instanceof Literal &&
      parsed.tokens[k + 1].ch === SLASH,
  );
  const hasDoubled = doubledSlashText || doubledSlashTokens;

  // A doubled separator can still be LIVE, and the way it stays live is narrow:
  // a globstar run GLUED to the text before it absorbs the first of the two
  // separators, so only the second one has to match a real one. Measured with
  // `git check-ignore`, listing what each pattern actually ignores:
  //
  //     a[STARSTAR]/[SLASH]        a (as a directory) and everything under it
  //     a[STARSTAR]/[SLASH]b       a/b and everything under it
  //     x/a[STARSTAR]/[SLASH]      x/a (as a directory) and everything under it
  //
  // The run cannot expand to anything in these forms: it has already eaten a
  // separator, and a path never carries two in a row. That is why the absorbed
  // run is rendered as NOTHING rather than as the usual "zero or more
  // directories" alternation -- `a[STARSTAR]/[SLASH]b` ignores `a/b` but keeps
  // `a/x/b`, which the alternation would have matched.
  //
  // Everything else is dead, and the discriminating cases are all measured:
  //
  //     a[STARSTAR]/b  a/x/b     kept  <- nothing absorbed, run may expand
  //     a/[STARSTAR]/[SLASH]      dead  <- run is a component, not glued
  //     /[STARSTAR]/[SLASH]       dead  <- the anchor slash is in front of it
  //     [STARSTAR]/a[STARSTAR]/[SLASH]  dead  <- a leading globstar prefix puts
  //                                             the run mid-pattern, and git
  //                                             then has no place to hide the
  //                                             extra separator
  //     a[STARSTAR]/[SLASH][SLASH]  dead  <- a separator is left over at the END
  //     a[STARSTAR]///[SLASH]       dead  <- likewise
  //
  // A leading `**/` prefix is the one case where a glued run still dies, and it
  // is the reason `**/a**//` is dead while `a**//` is not. The prefix marks the
  // run as sitting in the middle of the pattern, where the doubled separator
  // has nothing left to absorb into.
  //
  // Escapes are read through: `a\/b` is ONE literal slash and stays live,
  // while `a\//` is a literal slash followed by a real one and is dead. The
  // prefix group skips whole escape sequences so a trailing `\\` is consumed
  // as a unit. The text rule cannot see an escaped PAIR (`a\/\\/b` is two
  // literal slashes with no adjacent characters in the source), so the token
  // stream is checked as well.
  //
  // `**//` and `//` leave no tokens at all and are already reported as empty.
  const tokens = parsed.tokens;

  // Absorption is only ever consulted when there IS a doubled separator, so
  // the search is gated on that. Without the gate an ordinary pattern whose
  // first token is a slash-following run would be marked as absorbing and
  // collapse to the empty string, losing the whole prefix.
  //
  // The qualifying run is the one the doubled separator belongs to: a run
  // GLUED to text rather than sitting after a separator. A literal separator in
  // front makes it a path COMPONENT instead, and it has nothing to absorb with
  // -- that is what kills a doubled separator after a component run.

  // The absorber is the LAST run glued to text, and only a literal SEGMENT
  // after the doubled separator makes it absorb. Everything else undoes the
  // collapse, which is why "fold the whole run chain" was wrong:
  //
  //     a[STARSTAR]/[SLASH]b                       a/b                  collapsed
  //     a[STARSTAR]/[STARSTAR]/[SLASH]b            a/b                  collapsed
  //     a[STARSTAR]/[STARSTAR]/[STARSTAR]/[SLASH]b  a/b                collapsed
  //     a[STARSTAR]/[SLASH][STARSTAR]              a/b, a/x/b, a/x/y/b  expanded
  //     a[STARSTAR]/[SLASH]                        a/ a/b a/x/y         live, dir-only
  //     a[STARSTAR]/[STARSTAR]/[SLASH]             a/ a/b a/x/y         live, dir-only
  //
  // So a run sitting after the doubled separator takes the whole thing over and
  // everything expands again. The trailing form is NOT dead either: git keeps it
  // and it collapses to the head plus the dir-only separator -- the same thing
  // plain `/a/` compiles to, and the same verdict set over every depth. A
  // dedicated sweep of every path shape, file and directory, found it live in
  // all of them, where an earlier probe had dropped `a/b` from its own list and
  // concluded the opposite.
  //
  // When it DOES absorb, it is the last glued run in the pattern, and only that
  // one collapses: earlier runs in the chain keep their own expansion, which is
  // what `a[STARSTAR]/[STARSTAR]/[SLASH]b` collapsing to exactly `a/b` requires.
  const lastGluedRun = tokens.reduce(
    (acc, t, k) => (t instanceof Globstar && t.followedBySlash && !t.escapedSlash && k > 0 &&
      !(tokens[k - 1] instanceof Literal && tokens[k - 1].ch === SLASH) ? k : acc),
    -1,
  );
  const afterRun = lastGluedRun === -1 ? null : tokens[lastGluedRun + 1];
  // The doubled separator is the one this run took. What has to follow it is a
  // LITERAL segment; a run after it takes over, and the end of the pattern means
  // the trailing form.
  //
  // The absorber may NOT be a run that ate an ESCAPED slash, which is what
  // `!t.escapedSlash` above filters out. Absorption works by expanding the run to
  // nothing and letting a single separator stand for the pair, but `\/` is
  // already ONE literal character -- the backslash is gone before the run is
  // even tokenised -- so there is no second character left to swallow and the
  // run has nothing to collapse into. Measured, with the escaped bar in each
  // position of the pair:
  //
  //     a[STARSTAR] slash   slash   b     a/b      live
  //     a[STARSTAR] ESC     slash   b     nothing  dead
  //     a[STARSTAR] slash   ESC     b     nothing  dead
  //     a[STARSTAR] ESC     ESC     b     nothing  dead
  //     a[STARSTAR] ESC     slash            nothing  dead
  //
  // Before the filter the escaped-first case compiled to `^a\/b$` and ignored
  // `a/b`, a rule git applies to nothing at all.
  const absorbs =
    hasDoubled &&
    lastGluedRun !== -1 &&
    !parsed.leadGlobstarPrefix &&
    !(afterRun instanceof Globstar) &&
    afterRun instanceof Literal &&
    afterRun.ch === SLASH;

  if (absorbs) tokens[lastGluedRun].absorbsSlash = true;
  // The trailing form collapses to the head alone, which with the dir-only flag
  // means "the directory it names" -- exactly what plain `/a/` compiles to.
  const absorbsTrailing =
    hasDoubled &&
    !absorbs &&
    !parsed.leadGlobstarPrefix &&
    lastGluedRun !== -1 &&
    lastGluedRun === tokens.length - 1;

  if (absorbsTrailing) tokens[lastGluedRun].absorbsSlash = true;
  const doubledSlash = hasDoubled && !absorbs && !absorbsTrailing;

  Object.assign(compiled, {
    isComment: false,
    isEmpty: parsed.body === '' && parsed.tokens.length === 0,
    negated: parsed.negated,
    dirOnly: parsed.dirOnly,
    anchored: parsed.anchored,
    isGlob: parsed.isGlob,
    body: parsed.body,
    tokens: parsed.tokens,
    leadGlobstarPrefix: parsed.leadGlobstarPrefix,
    slashAnchored: parsed.slashAnchored,
    leadGlobstar: parsed.leadGlobstar,
    trailingGlobstar: parsed.trailingGlobstar,
    innerGlobstar: parsed.innerGlobstar,
    globstarCount: parsed.globstarCount,
    degradedGlobstarCount: parsed.degradedGlobstarCount,
    degradedGlobstarSpans: parsed.degradedGlobstarSpans,
    globstarOnly: parsed.globstarOnly,
    estimatedSize: parsed.estimatedSize,
    doubledSlash,
  });

  // A lone `!`, `/` or `!/` carries no matching power at all.
  if (parsed.tokens.length === 0) {
    compiled.isEmpty = true;
    return compiled;
  }

  // A rule that can only match a doubled slash can never match a path, and it
  // must be reported as such rather than compiled into something broader.
  if (doubledSlash) {
    compiled.isDead = true;
    compiled.regex = new RegExp('(?!)');
    return compiled;
  }

  compiled.regex = buildRegex(parsed.tokens, parsed.anchored);
  compiled.matches = (path, isDir) => {
    if (isDir === false && compiled.dirOnly) return false;
    return compiled.regex.test(path);
  };

  return compiled;
}

/**
 * Compile a whole .gitignore document, preserving line numbers.
 *
 * @param {string} text
 * @returns {{rules: object[], lines: string[]}}
 */
function parseFile(text) {
  const lines = String(text == null ? '' : text).split(/\r?\n/);
  const rules = lines.map((line, i) => {
    const rule = parsePattern(line);
    rule.line = i + 1;
    rule.text = line;
    return rule;
  });
  return { rules, lines };
}

module.exports = {
  parsePattern,
  parseFile,
  stripTrailingSpaces,
  inspectRaw,
  excludeSlash,
  _internal: {
    GLOBSTAR,
    CharClass,
    Globstar,
    Star,
    AnyChar,
    Literal,
    parseBody,
    buildRegex,
    findClassEnd,
    parseRanges,
  },
};