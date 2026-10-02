# plugin-eval

Runs `claude plugin eval` suites through Pi: same `evals/<case>/prompt.md` and `graders/*.md` files,
flags, scoring, `aggregate-result.json`, `report.html` and exit codes. Nothing is installed in the
plugin's repo.

```bash
cd ~/.pi/plugin-eval && pnpm install    # once; the only dependency is yaml
cd <repo>/.agents                       # the plugin root: .claude-plugin/plugin.json, skills/, evals/
node ~/.pi/plugin-eval/run.mjs . --tag <skill> --model github-copilot/claude-sonnet-5 --judge-model github-copilot/claude-haiku-4.5
node ~/.pi/plugin-eval/run.mjs . --case <case> --runs 1 --ablation none   # iterate on one case
node ~/.pi/plugin-eval/check.mjs        # offline check of the Pi-to-Claude mapping
```

`aggregate-result.json` uses Claude's schema (v1), so tools that read Claude's results read these too. It drops
`claudeVersion` and adds `agent`, `piVersion`, top-level `judgeCostUsd`, `partialReason`, case `tags`, run
`eventsPath`, grader `judgeOutputs` (each judge vote's reply) and grader-definition `arm`. `report.html` renders
either agent's file; judge replies sit in a collapsed "Judge output" section.

Flags: `--case`, `--tag`, `--runs`, `--ablation`, `--model`, `--judge-model`, `--threshold`, `--max-cost-usd`,
`--allow-tools`, `--output-dir`, `--keep-temp`. Results default to `<plugin>/evals/results/`; each run keeps
Pi's raw `events.jsonl` and the Claude-shaped `transcript.jsonl` the graders saw.

Each run is one `pi --mode json -p` with user extensions, skills, context files and prompt templates off;
the with-arm adds `--skill <plugin>/skills`, both arms add `-e sandbox.mjs`. `max_turns` and
`timeout_seconds` stop the run, which is recorded as an error and graded on what it produced, as in Claude.

Graders see the run as a Claude Code transcript (`read` → `Read {file_path}`, reading
`skills/<name>/SKILL.md` → `Skill`), so suites need no Pi-specific changes. `sandbox.mjs` confines file
tools to the workspace; Bash is not sandboxed. No `case.yaml` or MCP mocks. Judge
cost is recorded per run (`judgeCostUsd`) and counts toward `--max-cost-usd`.
