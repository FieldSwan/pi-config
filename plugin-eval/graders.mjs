// The six `claude plugin eval` grader types, evaluated over a Claude-shaped transcript.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { lastMessage, toolCalls } from "./claude-compat.mjs";

export const GRADER_TYPES = new Set(["regex", "tool_used", "tool_order", "file_exists", "llm", "baseline"]);

async function listFiles(dir, prefix = "")
{
    if (!existsSync(dir)) return [];
    const entries = await readdir(dir, { withFileTypes: true });
    const nested = await Promise.all(entries.map((e) => e.isDirectory()
        ? listFiles(path.join(dir, e.name), `${prefix}${e.name}/`)
        : [`${prefix}${e.name}`]));
    return nested.flat();
}

// A judge reads the first and last 12 messages of a trace, as Claude's does.
const trimTrace = (lines) => (lines.length > 24 ? [...lines.slice(0, 12), ...lines.slice(-12)] : lines).join("\n");

async function subject(selector, run, forJudge)
{
    if (selector === undefined || selector === "last_message") return lastMessage(run.transcript);
    if (selector === "trace")
    {
        const lines = run.transcript.map((l) => JSON.stringify(l));
        return forJudge ? trimTrace(lines) : lines.join("\n");
    }
    // The workspace starts empty, so every file in it was created during the run.
    if (selector === "files") return (await listFiles(run.cwd)).join("\n");
    if (selector?.source === "file") return readFile(path.join(run.cwd, selector.path), "utf8").catch(() => "");
    throw new Error(`Grader target ${JSON.stringify(selector)} is not supported by the Pi runner (no MCP mocks)`);
}

function matcher(spec)
{
    const { tool, input_match: inputMatch } = typeof spec === "string" ? { tool: spec } : spec;
    const re = inputMatch === undefined ? null : new RegExp(inputMatch, "u");
    return (call) => call.tool === tool && (re === null || re.test(JSON.stringify(call.input)));
}

function judgeVote(model, prompt)
{
    const args = ["--mode", "json", "-p", "--no-session", "--no-tools", "--no-skills", "--no-extensions", "--no-context-files", "--no-prompt-templates"];
    if (model !== undefined) args.push("--model", model);
    // `pi -p` reads piped stdin, so it must be closed or the judge waits forever.
    return new Promise((resolve, reject) => execFile("pi", [...args, prompt], { maxBuffer: 1 << 26, timeout: 300_000, cwd: os.tmpdir() }, (error, stdout) =>
    {
        if (error) return reject(error);
        const end = stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l)).findLast((e) => e.type === "agent_end");
        if (end === undefined) return reject(new Error("judge did not finish"));
        const replies = end.messages.filter((m) => m.role === "assistant");
        resolve({
            text: (replies.at(-1)?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n").trim(),
            cost: replies.reduce((s, m) => s + (m.usage?.cost?.total ?? 0), 0),
        });
    }).stdin.end());
}

// Passes on at least two of three votes, like Claude's judge.
async function judge(model, prompt, excerpt)
{
    const votes = await Promise.all([0, 1, 2].map(() => judgeVote(model, prompt)));
    const judgeVotes = votes.map((v) => /^\W*PASS/iu.test(v.text));
    return {
        passed: judgeVotes.filter(Boolean).length >= 2,
        explanation: `judge votes: ${judgeVotes.map((v) => v ? "PASS" : "FAIL").join(" ")}`,
        judgeVotes,
        evidence: excerpt,
        judgeOutputs: votes.map((v) => v.text),
        judgeCostUsd: votes.reduce((s, v) => s + v.cost, 0),
    };
}

const VERDICT = "Answer PASS or FAIL on the first line, then one sentence explaining why.";

/** Grade one run. `run` is `{ transcript, cwd, caseDir }`. */
export async function grade(grader, run, judgeModel)
{
    switch (grader.type)
    {
        case "regex": {
            const text = await subject(grader.target, run, false);
            const count = [...text.matchAll(new RegExp(grader.pattern, `${(grader.flags ?? "").replace("g", "")}g`))].length;
            const mode = grader.match ?? "contains";
            const passed = mode === "not_contains" ? count === 0 : mode.startsWith("count:") ? count === Number(mode.slice(6)) : count > 0;
            const where = typeof grader.target === "object" ? grader.target.path : grader.target ?? "last_message";
            const explanation = mode === "not_contains" ? (passed ? `pattern absent from ${where}` : `pattern found ${count}x in ${where}`)
                : mode.startsWith("count:") ? `pattern matched ${count}x in ${where} (expected ${mode.slice(6)})`
                : passed ? `matched ${grader.pattern}` : `pattern not found in ${where}`;
            return { passed, explanation };
        }
        case "tool_used": {
            const count = toolCalls(run.transcript).filter(matcher(grader)).length;
            const min = grader.min ?? 1;
            const max = grader.max ?? Infinity;
            return { passed: count >= min && count <= max, explanation: `${grader.tool} called ${count}x (expected ${min}..${max === Infinity ? "∞" : max})` };
        }
        case "tool_order": {
            const calls = toolCalls(run.transcript);
            const before = calls.findIndex(matcher(grader.before));
            const after = calls.findIndex(matcher(grader.after));
            return { passed: before >= 0 && after >= 0 && before < after, explanation: `first before at call ${before + 1}, first after at call ${after + 1} (0 = never)` };
        }
        case "file_exists": {
            const hits = (await listFiles(run.cwd)).filter((f) => path.matchesGlob(f, grader.path));
            const want = grader.exists ?? true;
            return { passed: want === hits.length > 0, explanation: `${hits.length} created file(s) match ${grader.path}${hits.length ? `: ${hits.slice(0, 5).join(", ")}` : ""}` };
        }
        case "llm": {
            const excerpt = await subject(grader.focus, run, true);
            return judge(judgeModel, `You are grading an AI coding assistant's output against a rubric.\n\nRubric:\n${grader.criteria}\n\n`
                + `Output to grade:\n<output>\n${excerpt}\n</output>\n\n${VERDICT}`, excerpt);
        }
        case "baseline": {
            const reference = (await readFile(path.join(run.caseDir, grader.baseline_file), "utf8")).split("\n").filter(Boolean);
            const excerpt = trimTrace(run.transcript.map((l) => JSON.stringify(l)));
            return judge(judgeModel, `You are comparing an AI coding assistant's session against a reference session.\n\nCriteria:\n${grader.criteria}\n\n`
                + `Reference session:\n<reference>\n${trimTrace(reference)}\n</reference>\n\nSession to grade:\n<session>\n${excerpt}\n</session>\n\n`
                + `PASS if the session to grade satisfies the criteria at least as well as the reference, else FAIL. ${VERDICT}`, excerpt);
        }
        default: throw new Error(`Unknown grader type: ${grader.type}`);
    }
}
