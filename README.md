# hidden-spec-cli-01-run-20261122

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/LuYquan/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/LuYquan/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend: one patch tool for every AI edit format. It applies the edits AI models write — unified diffs (often with wrong line numbers), SEARCH/REPLACE blocks, V4A patches, and text-editor tool calls as JSON — to a tree of text files, and changes every file or none.

Models drift: line numbers are wrong, whitespace and indentation wander, files are CRLF or lack a final line break. mend finds the lines each edit names at the first of three matching tiers (exact, trailing whitespace, then leading and trailing whitespace), re-indents at the loosest tier, and keeps each file's own line breaks and final break. A patch that fails anywhere writes nothing; a patch that succeeds prints what changed (`A`/`D`/`M`/`R` per file, `ok: N files`).

## Run it

```sh
node main.ts fix.patch
node main.ts --format=v4a --check patch.txt
node main.ts --strict - < patch.diff
```

Node 22, standard library only. `node main.ts [options] [PATCH]`, with the working directory as the root of the tree. `PATCH` is a patch file, or `-` (or absent) to read it from standard input. `--format=NAME` reads one format (`unified`, `search-replace`, `v4a`, `json`, or `auto`, the default, which detects it). `--check` does everything but write. `--strict` matches lines exactly (tier 0 only).

`runner.ts` beside it runs a whole trial when `MAKEFUN_ENV_URL` is set: it runs `main.ts` on every check the env serves and posts the results. See `SPEC.md` in the kit for the full contract (not shipped here).

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
