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
  constructor(followedBySlash) {
    this.followedBySlash = Boolean(followedBySlash);
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
  const member = (ch) => (ch === '/' ? '\\/' : escapeRe(ch));

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
  }

  // A remaining leading slash is the explicit anchor form.
  const slashAnchored = body.startsWith('/');
  if (slashAnchored) body = body.slice(1);

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
  let isGlob = false;

  for (let i = 0; i < n; ) {
    const ch = body[i];

    // Escape: the next character is literal.
    if (ch === '\\' && i + 1 < n) {
      tokens.push(new Literal(body[i + 1]));
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
        // A globstar only counts when it is bounded by slashes or string ends;
        // otherwise git collapses the run into a single `*`.
        const before = i === 0 ? null : body[i - 1];
        const after = i + run >= n ? null : body[i + run];
        const bounded =
          (before === '/' || before === null) && (after === '/' || after === null);

        if (!bounded) {
          degradedGlobstarCount++;
          tokens.push(new Star());
          i += run;
          continue;
        }

        globstarCount++;
        if (i === 0) leadGlobstar = true;
        if (after === null) trailingGlobstar = true;
        tokens.push(new Globstar(after === '/'));
        i += after === '/' ? run + 1 : run;
        continue;
      }

      tokens.push(new Star());
      i += run;
      continue;
    }

    if (ch === '?') {
      isGlob = true;
      tokens.push(new AnyChar());
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

  let body = '';
  let hasTrailingGlobstar = false;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];

    if (t instanceof Globstar) {
      if (i === tokens.length - 1) {
        hasTrailingGlobstar = true;
        continue;
      }

      if (t.followedBySlash) {
        // `a` + globstar + `/b` matches a/b, a/x/b and a/x/y/b. The
        // separating slash is consumed along with the globstar, so zero
        // directories must also be allowed.
        body += '(?:[^/]+/)*';
        continue;
      }

      // A globstar glued to text spans arbitrary characters, slashes included.
      body += '.*';
      continue;
    }

    body += tokenToRegex(t);
  }

  // An unanchored pattern may appear at any depth, so allow leading dirs. An
  // anchored one only earns that freedom when a globstar opens the pattern.
  const first = tokens[0];
  const leadingGlobstar = first instanceof Globstar;
  const prefix = !anchored || leadingGlobstar ? '(?:.*/)?' : '';

  if (hasTrailingGlobstar) {
    // A trailing globstar matches everything *inside* the named directory, at
    // one or more segments of depth, and never the directory itself. The slash
    // already sitting at the end of `body` is that separator, so `body` is
    // emitted without a second one.
    return new RegExp(`^${prefix}${body}.+$`);
  }

  return new RegExp(`^${prefix}${body}$`);
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
    globstarOnly: parsed.globstarOnly,
    estimatedSize: parsed.estimatedSize,
  });

  // A lone `!`, `/` or `!/` carries no matching power at all.
  if (parsed.tokens.length === 0) {
    compiled.isEmpty = true;
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