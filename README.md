[![Competition](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![Rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/arrahman13/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![Reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/arrahman13/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

# mend

One patch tool for every AI edit format. AI models write edits as unified diffs (often with
wrong line numbers), SEARCH/REPLACE blocks, V4A patches and text-editor tool calls as JSON;
mend reads all four, finds the lines each edit names at the first of three matching tiers
(exact, trailing-whitespace-tolerant, indentation-tolerant), and writes every change or none,
printing what it changed or why it failed.

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

`PATCH` is a patch file, or standard input when absent or `-`. `--format` names one format
(`unified`, `search-replace`, `v4a`, `json`); the default `auto` detects it. `--check` does
everything but write. `--strict` matches lines exactly (tier 0 only). The full contract is
SPEC.md beside this file.

Node 22, standard library only. `runner.ts` is the trial runner the grader drives through
`main.ts`; `check.ts` runs the public practice set:

    node check.ts <practice.json>

## License

MIT — see `LICENSE`.
