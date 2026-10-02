// Offline check of the Pi-to-Claude mapping and the judge-free graders: node evals/pi/check.mjs
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { lastMessage, toClaudeTranscript, toolCalls } from "./claude-compat.mjs";
import { grade } from "./graders.mjs";

const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-eval-check-"));
await writeFile(path.join(cwd, "out.md"), "done");
const call = (id, name, args) => ({ type: "toolCall", id, name, arguments: args });
const messages = [
    { role: "user", content: [{ type: "text", text: "review this" }] },
    { role: "assistant", content: [call("1", "read", { path: "/plugin/skills/lint-agents-md/SKILL.md" }), call("2", "read", { path: "a.md", offset: 3 })] },
    { role: "toolResult", toolCallId: "1", content: [{ type: "text", text: "skill" }], isError: false },
    { role: "assistant", content: [call("3", "edit", { path: "a.md", edits: [{ oldText: "x", newText: "y" }, { oldText: "p", newText: "q" }] }), call("4", "bash", { command: "npm test", timeout: 5 })] },
    { role: "assistant", content: [{ type: "thinking", thinking: "hm" }, { type: "text", text: "Cut it to a 20-line file." }] },
];
const transcript = toClaudeTranscript(messages, { cwd, skillsDir: "/plugin/skills", pluginName: "fieldai-monorepo" });
const run = { transcript, cwd, caseDir: cwd };

assert.deepEqual(toolCalls(transcript), [
    { tool: "Skill", input: { skill: "fieldai-monorepo:lint-agents-md" } },
    { tool: "Read", input: { file_path: path.join(cwd, "a.md"), offset: 3 } },
    { tool: "Edit", input: { file_path: path.join(cwd, "a.md"), old_string: "x", new_string: "y" } },
    { tool: "Edit", input: { file_path: path.join(cwd, "a.md"), old_string: "p", new_string: "q" } },
    { tool: "Bash", input: { command: "npm test", timeout: 5000 } },
]);
assert.equal(lastMessage(transcript), "Cut it to a 20-line file.");

const passes = async (grader) => (await grade(grader, run)).passed;
// The repo's own skill-fired grader, unchanged.
assert.ok(await passes({ type: "tool_used", tool: "Skill", input_match: '"skill"\\s*:\\s*"(?:[\\w-]+:)?lint-agents-md"' }));
assert.ok(await passes({ type: "tool_used", tool: "Edit", min: 2, max: 2 }));
assert.ok(!await passes({ type: "tool_used", tool: "Write" }));
assert.ok(await passes({ type: "regex", pattern: "\\d+[- ]line", flags: "i" }));
assert.ok(await passes({ type: "regex", pattern: "TODO", match: "not_contains" }));
assert.ok(await passes({ type: "regex", pattern: '\\"name\\":\\"Skill\\"', target: "trace" }));
assert.ok(await passes({ type: "regex", pattern: "^done$", target: { source: "file", path: "out.md" } }));
assert.ok(await passes({ type: "tool_order", before: "Skill", after: { tool: "Bash", input_match: "npm test" } }));
assert.ok(!await passes({ type: "tool_order", before: "Bash", after: "Skill" }));
assert.ok(await passes({ type: "file_exists", path: "*.md" }));
assert.ok(await passes({ type: "file_exists", path: "*.txt", exists: false }));
console.log("ok");
