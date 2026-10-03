# ignore-rules

A correct `.gitignore` pattern matcher and a linter for gitignore files, with
zero dependencies.

- **Correct.** It implements git's real precedence rules, including the one
  everybody gets wrong: *it is not possible to re-include a file if a parent
  directory of it is excluded.*
- **Inspectable.** `--explain` shows every rule considered, in order, and why
  each verdict came out the way it did. No black boxes.
- **Dependency-free.** Node's standard library only. Nothing to install, ever.

<!-- hero -->

[![CI](https://github.com/Xwalims/ignore-rules/actions/workflows/ci.yml/badge.svg)](https://github.com/Xwalims/ignore-rules/actions/workflows/ci.yml)
![node 20+](https://img.shields.io/badge/node-20+-brightgreen)
![MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![dependencies](https://img.shields.io/badge/dependencies-none-2f6f4f)

## Contents

- [Install](#install)
- [CLI](#cli)
  - [Linting](#linting)
  - [Explaining a pattern](#explaining-a-pattern)
  - [JSON output](#json-output)
  - [The precedence rules](#the-precedence-rules)

<!-- /hero -->

## Install

This package is **not published to npm** — neither `ignore-rules` nor the command
name `gitignore-lint` is registered, so `npm install --global gitignore-lint`
fails. Run it from a checkout:

```console
$ git clone https://github.com/Xwalims/ignore-rules.git
$ cd ignore-rules
$ node bin/gitignore-lint.js .gitignore
```

Or link it onto your `PATH`:

```console
$ npm link          # provides the `gitignore-lint` command
```

## CLI

```
Usage: gitignore-lint <file>... [options]

Options:
      --json                 emit machine-readable JSON
      --severity <level>     minimum severity to report: error, warning, info
      --explain <pattern>    resolve sample paths against a pattern and show
                             every rule considered, in order
      --no-color             disable ANSI colour
      --strict               exit 1 on any diagnostic, not only errors
  -h, --help                 show this help
  -v, --version              show the version

Exit codes:
  0  clean
  1  diagnostics found (or, with --strict, any diagnostic)
  2  usage error or unreadable file
```

### Linting

Given this `.gitignore`:

```
!orphan
**/node_modules
*.log
**
a**b
build   
node_modules
```

```
$ gitignore-lint broken.gitignore --no-color
broken.gitignore
  broken.gitignore:1  error    never-matches  negation with no preceding rule to undo, so it can never re-include anything
           fix: add the rule this line is meant to undo above it
  broken.gitignore:1  error    shadowed-rule  this rule is shadowed by "**" on line 4, which already matches everything it matches
           fix: remove this line or move it after line 4
  broken.gitignore:2  error    shadowed-rule  this rule is shadowed by "**" on line 4, which already matches everything it matches
           fix: remove this line or move it after line 4
  broken.gitignore:2  warning  redundant-globstar  leading globstar is redundant: "**/node_modules" and "node_modules" match the same paths
           fix: node_modules
  broken.gitignore:3  error    shadowed-rule  this rule is shadowed by "**" on line 4, which already matches everything it matches
           fix: remove this line or move it after line 4
  broken.gitignore:4  warning  globstar-not-needed  a bare "**" excludes every path in the tree, including .git internals
  broken.gitignore:5  warning  globstar-not-needed  "a**b" contains a globstar that is not between slashes, so git collapses it to a single "*"
           fix: a*b
  broken.gitignore:6  warning  trailing-whitespace  trailing 3 spaces are stripped by git and are almost certainly accidental
           fix: remove the trailing space (use "\ " to match a literal trailing space): build<spaces>

$ echo $?
1
```

Exit code `1` because there are error-severity diagnostics. Warnings on their
own exit `0`; pass `--strict` to fail on any diagnostic at all.

### Explaining a pattern

The `--explain` flag appends the pattern you give it to the file's rules,
resolves a set of sample paths against the result, and shows its work:

```
$ gitignore-lint plain.gitignore --no-color --explain 'build/'
pattern: build/

path                      verdict   decided by
------------------------------------------------------------------------------
README.md                 tracked   nothing
src/index.js              tracked   nothing
src/lib/deep.js           tracked   nothing
build/out.js              ignored   parent dir "build"
node_modules/pkg/index.js ignored   parent dir "node_modules"
a/b/c/d.txt               tracked   nothing

why
  README.md -> no rule matches it
  src/index.js -> no rule matches it
  src/lib/deep.js -> no rule matches it
  build/out.js -> parent directory "build" is excluded, so nothing inside it can be re-included
  node_modules/pkg/index.js -> parent directory "node_modules" is excluded, so nothing inside it can be re-included
  a/b/c/d.txt -> no rule matches it
```

### JSON output

`--json` emits exactly one JSON document on stdout, whichever flags are
combined with it:

```
$ gitignore-lint broken.gitignore --json
{
  "files": [
    {
      "file": "broken.gitignore",
      "diagnostics": [
        {
          "line": 1,
          "code": "never-matches",
          "severity": "error",
          "message": "negation with no preceding rule to undo, so it can never re-include anything",
          "fix": "add the rule this line is meant to undo above it"
        },
        {
          "line": 1,
          "code": "shadowed-rule",
          "severity": "error",
          "message": "this rule is shadowed by \"**\" on line 4, which already matches everything it matches",
          "fix": "remove this line or move it after line 4"
        },
        {
          "line": 2,
          "code": "shadowed-rule",
          "severity": "error",
          "message": "this rule is shadowed by \"**\" on line 4, which already matches everything it matches",
          "fix": "remove this line or move it after line 4"
        },
        {
          "line": 2,
          "code": "redundant-globstar",
          "severity": "warning",
          "message": "leading globstar is redundant: \"**/node_modules\" and \"node_modules\" match the same paths",
          "fix": "node_modules"
        },
        {
          "line": 3,
          "code": "shadowed-rule",
          "severity": "error",
          "message": "this rule is shadowed by \"**\" on line 4, which already matches everything it matches",
          "fix": "remove this line or move it after line 4"
        },
        {
          "line": 4,
          "code": "globstar-not-needed",
          "severity": "warning",
          "message": "a bare \"**\" excludes every path in the tree, including .git internals"
        },
        {
          "line": 5,
          "code": "globstar-not-needed",
          "severity": "warning",
          "message": "\"a**b\" contains a globstar that is not between slashes, so git collapses it to a single \"*\"",
          "fix": "a*b"
        },
        {
          "line": 6,
          "code": "trailing-whitespace",
          "severity": "warning",
          "message": "trailing 3 spaces are stripped by git and are almost certainly accidental",
          "fix": "remove the trailing space (use \"\\ \" to match a literal trailing space): build<spaces>"
        }
      ],
      "total": 8,
      "counts": {
        "error": 4,
        "warning": 4,
        "info": 0
      }
    }
  ],
  "ok": false,
  "exitCode": 1
}
```

With `--explain`, an `explanations` array is added, carrying `pattern`,
`results`, and for each result the full `considered` trace.

## Library

```js
const { parseFile, createMatcher } = require('ignore-rules');

const { rules } = parseFile('*.log\n!important.log\n');
const matcher = createMatcher(rules);

matcher.ignore('debug.log');      // true
matcher.ignore('important.log');  // false - the negation comes last
matcher.matches('build/out.js');  // false
```

A single pattern on its own:

```js
const { parsePattern } = require('ignore-rules');

const rule = parsePattern('src/**/*.test.js');
rule.anchored;                    // true - it contains a slash
rule.isGlob;                      // true
rule.matches('src/a/b/x.test.js'); // true
rule.matches('src/a.js');         // false
```

### The precedence rules

`explain()` returns the full reasoning, not just the answer:

```js
const m = createMatcher(parseFile('build/\n!build/keep.txt\n').rules);

m.ignore('build/keep.txt');            // true  <- surprising, and correct
m.explain('build/keep.txt').reason;    // 'parent directory "build" is excluded, so
                                      //  nothing inside it can be re-included'
```

Change `build/` to `build/*` and the negation works:

```js
const m = createMatcher(parseFile('build/*\n!build/keep.txt\n').rules);
m.ignore('build/keep.txt');   // false
m.ignore('build/other.txt');  // true
```

`build/*` does not match the directory `build` itself, only its contents, so git
still descends into it and the negation takes effect.

## Supported syntax

| Syntax | Example | Matches |
| --- | --- | --- |
| literal | `build` | `build`, `a/build`, but not `build/x` |
| `*` | `*.log` | any run of characters, **never** crossing `/` |
| `**` | `a/**/b` | `a/b`, `a/x/b`, `a/x/y/b` |
| `**` trailing | `a/**` | everything under `a`, not `a` itself |
| `?` | `?.txt` | exactly one character, never `/` |
| class | `[a-z]`, `[!abc]` | one character from / not in a set |
| anchor | `/build`, `a/b` | a `/` anywhere but the end anchors to the root |
| dir-only | `build/` | directories only |
| negation | `!build/keep.txt` | re-includes a previously ignored path |
| comment | `# note` | ignored; `\#note` is not |
| escape | `\ `, `\#`, `\!` | backslash escapes the next character |

Trailing spaces are stripped unless backslash-escaped, matching git.

Two rules that catch people out, and which this implementation follows:

- A pattern with **no slash** matches at any depth. `*.log` matches
  `deep/dir/x.log`, because it matches the *basename* at any depth. The star
  still never spans a separator; `a/*` does not match `a/b/c`.
- A globstar only counts when it is bounded by slashes or string ends. `a**b`
  is **not** a globstar: git collapses it to `a*b`, which cannot cross a slash.

## Diagnostics

Codes are stable and safe to match on in CI output.

| Code | Severity | Meaning |
| --- | --- | --- |
| `never-matches` | error | a negation with nothing before it to undo |
| `shadowed-rule` | error | a later rule already covers everything this one matches |
| `duplicate-rule` | warning | an identical rule appears earlier |
| `redundant-globstar` | warning | a leading globstar means the same as none |
| `trailing-whitespace` | warning | unescaped trailing whitespace |
| `globstar-not-needed` | warning | a globstar git collapses to a single star, or a bare `**` |
| `anchor-suspicious` | info | a slash anchors the rule to the root, which is often not intended |

Shadow detection is semantic rather than syntactic: it expands concrete sample
paths from the earlier rule and checks that the later one matches all of them,
so `*.log` followed by `**` is caught, but `**` followed by `*.log` is not.

## API

| Export | Description |
| --- | --- |
| `parsePattern(line)` | compile one line into a pattern |
| `parseFile(text)` | compile a whole file, preserving line numbers |
| `createMatcher(rules)` | build a matcher over an ordered rule list |
| `lint(text)` | return diagnostics for `.gitignore` text |
| `lintRules(rules)` | the same, over already-compiled rules |
| `normalizePath(p)` | strip `./`, collapse slashes, drop a trailing slash |
| `ancestorsOf(path)` | every parent directory, outermost first |
| `run(argv, io)` | the CLI entry point, returns an exit code |

A compiled pattern exposes `source`, `stripped`, `negated`, `dirOnly`,
`anchored`, `isGlob`, `isComment`, `isEmpty`, `line`, `text`, and
`matches(path, isDir)`.

## Development

```
node --test
```

106 tests across pattern compilation, precedence resolution, lint diagnostics
and end-to-end CLI runs.

## License

MIT
