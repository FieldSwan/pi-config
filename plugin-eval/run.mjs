#!/usr/bin/env node
// `claude plugin eval` for Pi: same case layout, grader files, flags, scoring, report and exit codes.
// Unsupported features fail loudly, not silently.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parse as parseYaml } from "yaml";

import { lastMessage, toClaudeTranscript } from "./claude-compat.mjs";
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
        return { name: file.replace(/\.md$/u, ""), weight: 1, ...g, criteria: g.criteria ?? graderBody };
    }));
    if (graders.length === 0) throw new Error(`${dir}: a case needs at least one grader`);
    return { id: meta.name ?? path.basename(dir), dir, prompt: body, graders, tags: meta.tags ?? [], ...meta };
}

/**
 * One isolated, non-interactive Pi session: no user extensions, skills, context files or prompt templates,
 * only what the arm loads. Resolves with the final messages and cost, or rejects on timeout or turn cap.
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
            if (failure === null && end !== undefined) resolve({ messages: end.messages, cost });
            else reject(Object.assign(new Error(failure ?? `pi exited ${code} without finishing: ${stderr.trim().split("\n").at(-1) ?? ""}`), { cost }));
        });
    });
}

// Graders that can only pass with the plugin would inflate Δ, so two-arm runs report but do not score them.
function scoredGraders(graders, twoArm)
{
    if (!twoArm) return graders.map(() => true);
    const scored = graders.map((g) => g.arm === "both" || (g.arm !== "with-only" && !(g.type === "tool_used" && g.tool === "Skill")));
    return scored.some(Boolean) ? scored : graders.map(() => true);
}

// A run that errored scores 0, as in Claude.
async function runOnce(evalCase, arm, attempt, ctx)
{
    const directory = path.join(ctx.outputDir, evalCase.id, `run-${attempt}`, arm.id);
    const cwd = path.join(ctx.workspacesDir, evalCase.id, `run-${attempt}`, arm.id);
    await mkdir(directory, { recursive: true });
    await mkdir(cwd, { recursive: true });
    const base = { arm: arm.id, attempt, directory, graders: [], reply: "", costUsd: 0 };
    let messages;
    let cost;
    try
    {
        ({ messages, cost } = await runPi({
            cwd,
            prompt: evalCase.prompt,
            model: ctx.model ?? evalCase.model,
            tools: arm.tools,
            skills: arm.skills,
            appendSystemPrompt: evalCase.append_system_prompt,
            timeoutMs: (evalCase.timeout_seconds ?? 300) * 1000,
            maxTurns: evalCase.max_turns ?? 10,
            eventsFile: path.join(directory, "events.jsonl"),
        }));
    }
    catch (error)
    {
        process.stdout.write(`  ${evalCase.id} [${arm.id}] run ${attempt} error: ${error.message}\n`);
        return { ...base, score: 0, error: error.message, costUsd: error.cost ?? 0 };
    }
    const transcript = toClaudeTranscript(messages, { ...ctx.compat, cwd });
    await writeFile(path.join(directory, "transcript.jsonl"), `${transcript.map((l) => JSON.stringify(l)).join("\n")}\n`);
    const scored = scoredGraders(evalCase.graders, ctx.twoArm);
    const run = { transcript, cwd, caseDir: evalCase.dir };
    const graders = await Promise.all(evalCase.graders.map(async (g, i) =>
        ({ name: g.name, type: g.type, weight: g.weight, scored: scored[i], ...await grade(g, run, ctx.judgeModel ?? evalCase.model) })));
    const counted = graders.filter((r) => r.scored);
    const score = counted.reduce((s, r) => s + (r.passed ? r.weight : 0), 0) / counted.reduce((s, r) => s + r.weight, 0);
    if (!ctx.keepTemp) await rm(cwd, { recursive: true, force: true });
    process.stdout.write(`  ${evalCase.id} [${arm.id}] run ${attempt} score ${score.toFixed(2)}  ${graders.map((r) => `${r.passed ? "✓" : "✗"} ${r.name}${r.scored ? "" : " (unscored)"}`).join("  ")}\n`);
    return { ...base, score, graders, reply: lastMessage(transcript), costUsd: cost };
}

const mean = (xs) => xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
const fmt = (x, sign = false) => x === null ? "-" : `${sign && x >= 0 ? "+" : ""}${x.toFixed(2)}`;

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
    const costCap = flags["max-cost-usd"] === undefined ? Infinity : Number(flags["max-cost-usd"]);
    // Read by sandbox.mjs inside each Pi child, which inherits this environment.
    process.env.PI_EVAL_SKILLS_DIR = skillsDir;
    const ctx = {
        outputDir: path.resolve(flags["output-dir"] ?? path.join(evalDir, "results", `${new Date().toISOString().replaceAll(/[:.]/gu, "-")}-pi`)),
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

    const rows = [];
    let spent = 0;
    let partial = null;
    for (const evalCase of cases)
    {
        const tools = [...new Set([...(evalCase.allowed_tools ?? []), ...flags["allow-tools"]]
            .map((t) => TOOLS[t.replace(/\(.*\)$/u, "")]).filter(Boolean))];
        // Bash is unconfined; wrap it in bwrap like Claude's sandbox where user namespaces are allowed.
        if (tools.includes("bash")) process.stderr.write(`  warning: ${evalCase.id} grants Bash, which Pi runs without a sandbox\n`);
        const arms = [{ id: "with", skills: [skillsDir], tools }, ...(twoArm ? [{ id: "without", skills: [], tools }] : [])];
        const runs = [];
        for (let attempt = 1; attempt <= Number(flags.runs ?? evalCase.runs ?? 3); attempt += 1)
        {
            for (const arm of arms)
            {
                // Checked before each run starts, as Claude does; a started run may overshoot the cap.
                if (spent >= costCap) { partial = `--max-cost-usd ${costCap} reached`; break; }
                const run = await runOnce(evalCase, arm, attempt, ctx);
                spent += run.costUsd;
                runs.push(run);
            }
            if (partial !== null) break;
        }
        const arm = (id) => runs.filter((r) => r.arm === id);
        const withScore = mean(arm("with").map((r) => r.score));
        const withoutScore = twoArm ? mean(arm("without").map((r) => r.score)) : null;
        const failing = arm("with").flatMap((r) => r.error ? [{ name: "run error", weight: Infinity, explanation: r.error }] : r.graders.filter((g) => !g.passed))
            .sort((a, b) => b.weight - a.weight)[0];
        rows.push({
            case: evalCase.id,
            with: withScore,
            without: withoutScore,
            delta: withScore !== null && withoutScore !== null ? withScore - withoutScore : null,
            passed: withScore !== null && withScore >= threshold,
            costUsd: runs.reduce((s, r) => s + r.costUsd, 0),
            notes: failing === undefined ? "" : `${failing.name}: ${String(failing.explanation).split("\n")[0]}`,
            runs,
        });
        if (partial !== null) break;
    }
    if (ctx.keepTemp) process.stdout.write(`Workspaces kept: ${ctx.workspacesDir}\n`);
    else await rm(ctx.workspacesDir, { recursive: true, force: true });

    const header = twoArm ? ["CASE", "WITH", "W/OUT", "Δ", "RUNS", "COST", "NOTES"] : ["CASE", "SCORE", "RUNS", "COST", "NOTES"];
    const body = rows.map((r) => twoArm
        ? [r.case, fmt(r.with), fmt(r.without), fmt(r.delta, true), r.runs.length, `$${r.costUsd.toFixed(2)}`, r.notes]
        : [r.case, fmt(r.with), r.runs.length, `$${r.costUsd.toFixed(2)}`, r.notes]);
    const widths = header.map((h, i) => Math.max(...[h, ...body.map((b) => b[i])].map((v) => String(v).length)));
    for (const line of [header, ...body]) process.stdout.write(`${line.map((v, i) => String(v).padEnd(widths[i])).join("  ").trimEnd()}\n`);
    const deltas = rows.map((r) => r.delta).filter((d) => d !== null);
    process.stdout.write(`${rows.length} case(s)${twoArm ? ` · mean Δ ${fmt(mean(deltas), true)}` : ""} · $${spent.toFixed(2)} (agent runs only)\n`);

    const aggregate = { partial: partial !== null, partialReason: partial, threshold, ablation, cases: rows };
    await mkdir(ctx.outputDir, { recursive: true });
    await writeFile(path.join(ctx.outputDir, "aggregate-result.json"), `${JSON.stringify(aggregate, null, 2)}\n`);
    await writeFile(path.join(ctx.outputDir, "report.html"), renderHtml(aggregate));
    process.stdout.write(`Report: ${path.join(ctx.outputDir, "report.html")}\n`);
    if (partial !== null) { process.stderr.write(`Partial run: ${partial}\n`); process.exitCode = 2; }
    else if (rows.some((r) => !r.passed)) process.exitCode = 1;
}

main().catch((error) =>
{
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
});
