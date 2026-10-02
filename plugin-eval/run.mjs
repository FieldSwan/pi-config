#!/usr/bin/env node
// `claude plugin eval` for Pi: same case layout, grader files, flags, scoring, report and exit codes.
// Unsupported features fail loudly, not silently.
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parse as parseYaml } from "yaml";

import { toClaudeTranscript } from "./claude-compat.mjs";
import { grade, GRADER_TYPES } from "./graders.mjs";
import { renderHtml } from "./report.mjs";

// Claude tool grants to Pi tools; Pi loads a skill by `read`ing its SKILL.md, so `Skill` grants `read`.
const TOOLS = { Read: "read", Grep: "grep", Glob: "find", Skill: "read", Bash: "bash", Write: "write", Edit: "edit" };
const VARIADIC = new Set(["tag", "allow-tools"]);
const BOOLEAN = new Set(["keep-temp", "trust-plugin", "no-publish"]);
const SANDBOX = path.join(import.meta.dirname, "sandbox.mjs");

function parseArgs(argv)
{
    const flags = { tag: [], "allow-tools": [] };
    const positionals = [];
    for (let i = 0; i < argv.length; i += 1)
    {
        const arg = argv[i];
        if (!arg.startsWith("--")) { positionals.push(arg); continue; }
        const key = arg.slice(2);
        if (BOOLEAN.has(key)) flags[key] = true;
        else if (VARIADIC.has(key)) while (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) flags[key].push(argv[++i]);
        else if (argv[i + 1] === undefined) throw new Error(`Missing value for --${key}`);
        else flags[key] = argv[++i];
    }
    return { target: positionals[0] ?? ".", flags };
}

function splitFrontmatter(source, file)
{
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/u.exec(source);
    if (match === null) return { meta: {}, body: source.trim() };
    try { return { meta: parseYaml(match[1]) ?? {}, body: match[2].trim() }; }
    catch (error) { throw new Error(`${file}: ${error.message}`); }
}

async function findCaseDirs(dir)
{
    const entries = await readdir(dir, { withFileTypes: true });
    if (entries.some((e) => e.name === "prompt.md")) return [dir];
    const nested = await Promise.all(entries
        .filter((e) => e.isDirectory() && !["results", "node_modules", "mocks"].includes(e.name))
        .map((e) => findCaseDirs(path.join(dir, e.name))));
    return nested.flat();
}

async function loadCase(dir)
{
    if (existsSync(path.join(dir, "case.yaml"))) throw new Error(`${dir}: case.yaml is not supported by the Pi runner`);
    const { meta, body } = splitFrontmatter(await readFile(path.join(dir, "prompt.md"), "utf8"), dir);
    const graderDir = path.join(dir, "graders");
    const graderFiles = existsSync(graderDir) ? (await readdir(graderDir)).filter((f) => f.endsWith(".md")).sort() : [];
    const graders = await Promise.all(graderFiles.map(async (file) =>
    {
        const { meta: g, body: graderBody } = splitFrontmatter(await readFile(path.join(graderDir, file), "utf8"), file);
        if (!GRADER_TYPES.has(g.type)) throw new Error(`${dir}/graders/${file}: unknown grader type ${g.type}`);
        return { name: file.replace(/\.md$/u, ""), weight: 1, ...g, criteria: g.criteria ?? graderBody, markdown: graderBody };
    }));
    if (graders.length === 0) throw new Error(`${dir}: a case needs at least one grader`);
    return { id: meta.name ?? path.basename(dir), dir, prompt: body, graders, tags: meta.tags ?? [], ...meta };
}

/**
 * One isolated, non-interactive Pi session: no user extensions, skills, context files or prompt templates,
 * only what the arm loads. Resolves with the final messages, cost and turns, or rejects on timeout or turn cap.
 */
function runPi({ cwd, prompt, model, tools, skills, appendSystemPrompt, timeoutMs, maxTurns, eventsFile })
{
    const args = ["--mode", "json", "-p", "--no-session", "--no-approve", "--no-context-files", "--no-skills",
        "--no-prompt-templates", "--no-themes", "--no-extensions", "-e", SANDBOX,
        ...(tools.length === 0 ? ["--no-tools"] : ["--tools", tools.join(",")]),
        ...skills.flatMap((s) => ["--skill", s]),
        ...(model === undefined ? [] : ["--model", model]),
        ...(appendSystemPrompt === undefined ? [] : ["--append-system-prompt", appendSystemPrompt]),
        prompt];
    return new Promise((resolve, reject) =>
    {
        const child = spawn("pi", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
        const lines = [];
        let buffer = "";
        let stderr = "";
        let turns = 0;
        let cost = 0;
        const messages = [];
        let failure = null;
        const stop = (message) => { failure ??= message; child.kill("SIGTERM"); };
        const timer = setTimeout(() => stop(`timed out after ${timeoutMs / 1000}s`), timeoutMs);
        child.stderr.on("data", (d) => { stderr += d; });
        child.stdout.on("data", (chunk) =>
        {
            buffer += chunk;
            const parts = buffer.split("\n");
            buffer = parts.pop();
            for (const line of parts.filter(Boolean))
            {
                lines.push(line);
                const event = JSON.parse(line);
                // Summed as the run goes, so a killed run still counts toward --max-cost-usd.
                if (event.type === "message_end") messages.push(event.message);
                if (event.type === "message_end" && event.message?.role === "assistant") cost += event.message.usage?.cost?.total ?? 0;
                if (event.type === "turn_start" && ++turns > maxTurns) stop(`hit max_turns ${maxTurns}`);
            }
        });
        child.on("error", reject);
        child.on("close", async (code) =>
        {
            clearTimeout(timer);
            await writeFile(eventsFile, `${lines.join("\n")}\n`);
            const end = lines.map((l) => JSON.parse(l)).findLast((e) => e.type === "agent_end");
            if (failure === null && end !== undefined) resolve({ messages: end.messages, cost, turns });
            // A killed run is still graded on what it produced, as in Claude.
            else reject(Object.assign(new Error(failure ?? `pi exited ${code} without finishing: ${stderr.trim().split("\n").at(-1) ?? ""}`), { cost, turns, messages }));
        });
    });
}

// Graders that can only pass with the plugin; in a two-arm run they are reported, not scored, so Δ stays honest.
const isWithOnly = (g) => g.arm !== "both" && (g.arm === "with-only" || (g.type === "tool_used" && g.tool === "Skill"));

function scoredGraders(graders, twoArm)
{
    if (!twoArm) return graders.map(() => true);
    const scored = graders.map((g) => !isWithOnly(g));
    return scored.some(Boolean) ? scored : graders.map(() => true);
}

/** One run, shaped like an entry of Claude's `cases[].arms.<arm>[]`; `eventsPath` is Pi-only. */
async function runOnce(evalCase, arm, attempt, ctx)
{
    const directory = path.join(ctx.outputDir, evalCase.id, `run-${attempt}`, arm.id);
    const cwd = path.join(ctx.workspacesDir, evalCase.id, `run-${attempt}`, arm.id);
    await mkdir(directory, { recursive: true });
    await mkdir(cwd, { recursive: true });
    const started = Date.now();
    const eventsPath = path.join(directory, "events.jsonl");
    let result;
    let error = null;
    try
    {
        result = await runPi({
            cwd,
            prompt: evalCase.prompt,
            model: ctx.model ?? evalCase.model,
            tools: arm.tools,
            skills: arm.skills,
            appendSystemPrompt: evalCase.append_system_prompt,
            timeoutMs: (evalCase.timeout_seconds ?? 300) * 1000,
            maxTurns: evalCase.max_turns ?? 10,
            eventsFile: eventsPath,
        });
    }
    catch (caught)
    {
        error = caught.message;
        result = { messages: caught.messages ?? [], cost: caught.cost ?? 0, turns: caught.turns ?? 0 };
    }
    const scored = scoredGraders(evalCase.graders, ctx.twoArm);
    // The baseline leaves out graders it does not score, as Claude's does.
    const graderDefs = evalCase.graders.map((g, i) => ({ g, scored: scored[i] })).filter(({ scored: s }) => arm.id === "with" || s);
    let graders = [];
    let tracePath = null;
    if (result.messages.length > 0)
    {
        const transcript = toClaudeTranscript(result.messages, { ...ctx.compat, cwd });
        tracePath = path.join(directory, "transcript.jsonl");
        await writeFile(tracePath, `${transcript.map((l) => JSON.stringify(l)).join("\n")}\n`);
        const run = { transcript, cwd, caseDir: evalCase.dir };
        graders = await Promise.all(graderDefs.map(async ({ g, scored: s }) =>
        {
            const { passed, explanation, judgeVotes, evidence, judgeOutputs, judgeCostUsd } = await grade(g, run, ctx.judgeModel ?? evalCase.model);
            return { name: g.name, passed, weight: g.weight, explanation, withOnly: isWithOnly(g), scored: s, ...(judgeVotes === undefined ? {} : { judgeVotes }),
                evidence: evidence ?? null, ...(judgeOutputs === undefined ? {} : { judgeOutputs, judgeCostUsd }) };
        }));
    }
    const counted = graders.filter((r) => r.scored);
    const total = counted.reduce((s, r) => s + r.weight, 0);
    const score = total === 0 ? 0 : counted.reduce((s, r) => s + (r.passed ? r.weight : 0), 0) / total;
    if (!ctx.keepTemp) await rm(cwd, { recursive: true, force: true });
    const verdicts = graders.map((r) => `${r.passed ? "✓" : "✗"} ${r.name}${r.scored ? "" : " (unscored)"}`).join("  ");
    process.stdout.write(`  ${evalCase.id} [${arm.id}] run ${attempt} score ${score.toFixed(2)}  ${error === null ? verdicts : `error: ${error}`}\n`);
    return {
        score,
        passed: error === null && counted.every((r) => r.passed),
        turns: result.turns,
        costUsd: result.cost,
        judgeCostUsd: graders.reduce((s, r) => s + (r.judgeCostUsd ?? 0), 0),
        durationSeconds: Math.round((Date.now() - started) / 1000),
        startedAt: new Date(started).toISOString(),
        error,
        tracePath,
        skippedPaidGraders: false,
        graders: graders.map(({ judgeCostUsd, ...r }) => r),
        eventsPath,
    };
}

// Claude's `cases[].graders[]`: options under `config`, with defaults filled in, and the body as `graderMarkdown`.
function graderDefinition(g)
{
    const { name, type, weight, arm, markdown, criteria, ...options } = g;
    const judged = type === "llm" || type === "baseline";
    // Same key order as Claude: defaults filled in around the options the file set.
    const config = type === "regex" ? { target: "last_message", ...options, match: options.match ?? "contains" }
        : type === "llm" ? { criteria, focus: "last_message", ...options }
        : judged ? { criteria, ...options } : options;
    return { name, type, weight, ...(arm === undefined ? {} : { arm }), ...(judged && markdown ? { graderMarkdown: markdown } : {}), config };
}

const mean = (xs) => xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
const fmt = (x, sign = false) => x === null ? "-" : `${sign && x >= 0 ? "+" : ""}${x.toFixed(2)}`;
const runCost = (r) => r.costUsd + r.judgeCostUsd;

async function main()
{
    const { target, flags } = parseArgs(process.argv.slice(2));
    const pluginDir = path.resolve(target);
    const evalDir = path.join(pluginDir, flags["eval-dir"] ?? "evals");
    const skillsDir = path.join(pluginDir, "skills");
    const pluginName = JSON.parse(await readFile(path.join(pluginDir, ".claude-plugin", "plugin.json"), "utf8")).name;
    const ablation = flags.ablation ?? "with-without";
    if (!["none", "with-without"].includes(ablation)) throw new Error("--ablation must be none or with-without");
    const twoArm = ablation === "with-without";
    const threshold = Number(flags.threshold ?? 1);
    const startedAt = new Date();
    const costCap = flags["max-cost-usd"] === undefined ? Infinity : Number(flags["max-cost-usd"]);
    // Read by sandbox.mjs inside each Pi child, which inherits this environment.
    process.env.PI_EVAL_SKILLS_DIR = skillsDir;
    const ctx = {
        outputDir: path.resolve(flags["output-dir"] ?? path.join(evalDir, "results", `${startedAt.toISOString().replaceAll(/[:.]/gu, "-")}-pi`)),
        // Outside the repo, so Pi cannot discover the monorepo's AGENTS.md or skills from the workspace.
        workspacesDir: await mkdtemp(path.join(os.tmpdir(), "pi-plugin-eval-")),
        model: flags.model,
        judgeModel: flags["judge-model"] ?? flags.model,
        twoArm,
        keepTemp: flags["keep-temp"] === true,
        compat: { skillsDir, pluginName },
    };

    const cases = (await Promise.all((await findCaseDirs(evalDir)).map(loadCase)))
        .filter((c) => flags.tag.length === 0 || c.tags.some((t) => flags.tag.includes(t)))
        .filter((c) => flags.case === undefined || path.matchesGlob(c.id, flags.case));
    if (cases.length === 0) { process.stderr.write("No cases found\n"); process.exitCode = 1; return; }

    const results = [];
    let spent = 0;
    let partial = null;
    for (const evalCase of cases)
    {
        const tools = [...new Set([...(evalCase.allowed_tools ?? []), ...flags["allow-tools"]]
            .map((t) => TOOLS[t.replace(/\(.*\)$/u, "")]).filter(Boolean))];
        // Bash is unconfined; wrap it in bwrap like Claude's sandbox where user namespaces are allowed.
        if (tools.includes("bash")) process.stderr.write(`  warning: ${evalCase.id} grants Bash, which Pi runs without a sandbox\n`);
        const arms = [{ id: "with", skills: [skillsDir], tools }, ...(twoArm ? [{ id: "without", skills: [], tools }] : [])];
        const runs = { with: [], ...(twoArm ? { without: [] } : {}) };
        const runsPerCase = Number(flags.runs ?? evalCase.runs ?? 3);
        for (let attempt = 1; attempt <= runsPerCase && partial === null; attempt += 1)
        {
            for (const arm of arms)
            {
                // Checked before each run starts, as Claude does; a started run may overshoot the cap.
                if (spent >= costCap) { partial = `--max-cost-usd ${costCap} reached`; break; }
                const run = await runOnce(evalCase, arm, attempt, ctx);
                spent += runCost(run);
                runs[arm.id].push(run);
            }
        }
        const score = mean(runs.with.map((r) => r.score));
        const scoreWithout = twoArm ? mean(runs.without.map((r) => r.score)) : null;
        const passRate = (rs) => rs === undefined || rs.length === 0 ? null : rs.filter((r) => r.passed).length / rs.length;
        results.push({
            name: evalCase.id,
            dir: path.relative(pluginDir, evalCase.dir),
            source: "prose",
            promptMarkdown: evalCase.prompt,
            runsPerCase,
            timeoutSeconds: evalCase.timeout_seconds ?? 300,
            maxTurns: evalCase.max_turns ?? 10,
            graders: evalCase.graders.map(graderDefinition),
            arms: runs,
            aggregates: {
                score,
                passRate: passRate(runs.with),
                scoreWithout,
                passRateWithout: passRate(runs.without),
                delta: score !== null && scoreWithout !== null ? score - scoreWithout : null,
            },
            tags: evalCase.tags,
        });
        if (partial !== null) break;
    }
    if (ctx.keepTemp) process.stdout.write(`Workspaces kept: ${ctx.workspacesDir}\n`);
    else await rm(ctx.workspacesDir, { recursive: true, force: true });

    const allRuns = (c) => Object.values(c.arms).flat();
    const notes = (c) =>
    {
        const failing = c.arms.with.flatMap((r) => r.error ? [{ name: "run error", weight: Infinity, explanation: r.error }] : r.graders.filter((g) => !g.passed))
            .sort((a, b) => b.weight - a.weight)[0];
        return failing === undefined ? "" : `${failing.name}: ${String(failing.explanation).split("\n")[0]}`;
    };
    const header = twoArm ? ["CASE", "WITH", "W/OUT", "Δ", "RUNS", "COST", "NOTES"] : ["CASE", "SCORE", "RUNS", "COST", "NOTES"];
    const body = results.map((c) => [c.name, fmt(c.aggregates.score), ...(twoArm ? [fmt(c.aggregates.scoreWithout), fmt(c.aggregates.delta, true)] : []),
        allRuns(c).length, `$${allRuns(c).reduce((s, r) => s + runCost(r), 0).toFixed(2)}`, notes(c)]);
    const widths = header.map((h, i) => Math.max(...[h, ...body.map((b) => b[i])].map((v) => String(v).length)));
    for (const line of [header, ...body]) process.stdout.write(`${line.map((v, i) => String(v).padEnd(widths[i])).join("  ").trimEnd()}\n`);
    const deltas = results.map((c) => c.aggregates.delta).filter((d) => d !== null);
    process.stdout.write(`${results.length} case(s)${twoArm ? ` · mean Δ ${fmt(mean(deltas), true)}` : ""} · $${spent.toFixed(2)}\n`);

    // Claude's aggregate-result.json schema; `agent`, `piVersion`, `judgeCostUsd`, `partialReason`, `tags`,
    // `eventsPath`, `judgeOutputs` and grader `arm` are Pi-only additions.
    const flat = results.flatMap(allRuns);
    const aggregate = {
        schemaVersion: 1,
        agent: "pi",
        piVersion: await new Promise((resolve) => execFile("pi", ["--version"], (_, out) => resolve(String(out).trim()))),
        startedAt: startedAt.toISOString(),
        durationSeconds: Math.round((Date.now() - startedAt) / 1000),
        costUsd: flat.reduce((s, r) => s + r.costUsd, 0),
        judgeCostUsd: flat.reduce((s, r) => s + r.judgeCostUsd, 0),
        partial: partial !== null,
        partialReason: partial,
        suite: {
            root: pluginDir,
            ablation,
            modelOverride: ctx.model ?? null,
            judgeModel: ctx.judgeModel ?? null,
            threshold,
            concurrency: 1,
            plugins: [{ name: pluginName, path: pluginDir }],
        },
        cases: results,
        aggregates: {
            casesTotal: results.length,
            casesPassed: results.filter((c) => c.aggregates.score !== null && c.aggregates.score >= threshold).length,
            overallScore: mean(results.map((c) => c.aggregates.score).filter((x) => x !== null)),
            overallPassRate: mean(results.map((c) => c.aggregates.passRate).filter((x) => x !== null)),
            meanDelta: mean(deltas),
        },
    };
    await mkdir(ctx.outputDir, { recursive: true });
    await writeFile(path.join(ctx.outputDir, "aggregate-result.json"), `${JSON.stringify(aggregate, null, 2)}\n`);
    await writeFile(path.join(ctx.outputDir, "report.html"), renderHtml(aggregate, target));
    process.stdout.write(`Report: ${path.join(ctx.outputDir, "report.html")}\n`);
    if (partial !== null) { process.stderr.write(`Partial run: ${partial}\n`); process.exitCode = 2; }
    else if (aggregate.aggregates.casesPassed < results.length) process.exitCode = 1;
}

main().catch((error) =>
{
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
});
