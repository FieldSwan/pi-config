// Rewrites a Pi session as a Claude Code transcript, so cases written for `claude plugin eval`
// grade Pi runs unchanged: same tool names, same input fields, same trace shape.
import path from "node:path";

const textOf = (content) => typeof content === "string"
    ? content
    : (content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");

const defined = (input) => Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));

/** Map one Pi tool call to the Claude Code tool call(s) that would have done the same thing. */
export function toClaudeToolUses(name, args = {}, { cwd, skillsDir, pluginName })
{
    const abs = (p) => p === undefined ? undefined : path.resolve(cwd, p);
    switch (name)
    {
        case "read": {
            // Claude invokes a skill through the Skill tool; Pi does it by reading SKILL.md.
            const rel = path.relative(skillsDir, abs(args.path));
            const skill = /^([^/]+)\/SKILL\.md$/u.exec(rel);
            if (skill !== null) return [{ name: "Skill", input: { skill: `${pluginName}:${skill[1]}` } }];
            return [{ name: "Read", input: defined({ file_path: abs(args.path), offset: args.offset, limit: args.limit }) }];
        }
        case "write": return [{ name: "Write", input: { file_path: abs(args.path), content: args.content } }];
        case "edit": return (args.edits ?? []).map((e) => ({ name: "Edit", input: { file_path: abs(args.path), old_string: e.oldText, new_string: e.newText } }));
        case "bash": return [{ name: "Bash", input: defined({ command: args.command, timeout: args.timeout === undefined ? undefined : args.timeout * 1000 }) }];
        case "grep": return [{ name: "Grep", input: defined({ pattern: args.pattern, path: abs(args.path), glob: args.glob, "-i": args.ignoreCase, "-C": args.context, head_limit: args.limit }) }];
        case "find": return [{ name: "Glob", input: defined({ pattern: args.pattern, path: abs(args.path) }) }];
        default: return [{ name, input: args }];
    }
}

/** Pi session messages as Claude Code stream-json transcript lines. */
export function toClaudeTranscript(messages, context)
{
    const lines = [];
    for (const m of messages)
    {
        if (m.role === "user") lines.push({ type: "user", message: { role: "user", content: [{ type: "text", text: textOf(m.content) }] } });
        else if (m.role === "assistant")
        {
            const content = m.content.flatMap((c) =>
            {
                if (c.type === "text") return [{ type: "text", text: c.text }];
                if (c.type === "thinking") return [{ type: "thinking", thinking: c.thinking }];
                if (c.type !== "toolCall") return [];
                return toClaudeToolUses(c.name, c.arguments, context).map((use, i) => ({ type: "tool_use", id: i === 0 ? c.id : `${c.id}_${i}`, ...use }));
            });
            lines.push({ type: "assistant", message: { role: "assistant", model: m.model, content } });
        }
        else if (m.role === "toolResult")
        {
            lines.push({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: m.toolCallId, content: textOf(m.content), is_error: m.isError === true }] } });
        }
    }
    return lines;
}

/** Every tool call in a Claude-shaped transcript, in order. */
export const toolCalls = (transcript) => transcript
    .filter((l) => l.type === "assistant")
    .flatMap((l) => l.message.content.filter((c) => c.type === "tool_use").map((c) => ({ tool: c.name, input: c.input })));

/** Claude's final response text. */
export function lastMessage(transcript)
{
    const last = transcript.findLast((l) => l.type === "assistant" && l.message.content.some((c) => c.type === "text"));
    return last === undefined ? "" : textOf(last.message.content);
}
