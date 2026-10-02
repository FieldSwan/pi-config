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
    const args = ["-p", "--no-session", "--no-tools", "--no-skills", "--no-extensions", "--no-context-files", "--no-prompt-templates"];
    if (model !== undefined) args.push("--model", model);
    // `pi -p` reads piped stdin, so it must be closed or the judge waits forever.
    return new Promise((resolve, reject) => execFile("pi", [...args, prompt], { maxBuffer: 1 << 24, timeout: 300_000, cwd: os.tmpdir() },
        (error, stdout) => error ? reject(error) : resolve(stdout.trim())).stdin.end());
}

// Passes on at least two of three votes, like Claude's judge.
async function judge(model, prompt, excerpt)
{
    const votes = await Promise.all([0, 1, 2].map(() => judgeVote(model, prompt)));
    const isPass = (v) => /^\W*PASS/iu.test(v);
    const passed = votes.filter(isPass).length >= 2;
    return { passed, explanation: votes.find((v) => isPass(v) === passed) ?? votes[0], votes, excerpt };
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
            return { passed, explanation: `${count} match(es) for /${grader.pattern}/ (${mode})` };
        }
        case "tool_used": {
            const count = toolCalls(run.transcript).filter(matcher(grader)).length;
            const min = grader.min ?? 1;
            const max = grader.max ?? Infinity;
            return { passed: count >= min && count <= max, explanation: `${grader.tool} called ${count} time(s), wanted ${min}..${max}` };
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
