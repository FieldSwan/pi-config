// Confines Pi's file tools to the run's workspace (and the plugin's skills, read-only), as Claude's
// eval sandbox does; without it the agent can follow the skill's path into the real repo.
import os from "node:os";
import path from "node:path";

const inside = (p, root) => { const rel = path.relative(root, p); return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel)); };

export default function (pi)
{
    const skillsDir = process.env.PI_EVAL_SKILLS_DIR;
    pi.on("tool_call", async (event) =>
    {
        const cwd = process.cwd();
        const input = event.input ?? {};
        const raw = String(input.path ?? ".").replace(/^~(?=$|\/)/u, os.homedir());
        const target = path.resolve(cwd, raw);
        const readable = inside(target, cwd) || (skillsDir !== undefined && inside(target, skillsDir));
        if (["read", "grep", "find", "ls"].includes(event.toolName))
        {
            const escapes = event.toolName === "find" && /(^\/|(^|\/)\.\.(\/|$))/u.test(String(input.pattern ?? ""));
            if (!readable || escapes) return { block: true, reason: `Access outside the workspace is not allowed: ${raw}` };
        }
        if (["write", "edit"].includes(event.toolName) && !inside(target, cwd))
        {
            return { block: true, reason: `Writes are confined to the workspace: ${raw}` };
        }
        return undefined;
    });
}
