import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";

type AnyContext = ExtensionCommandContext | ExtensionContext;

function copyNative(text: string): string | undefined {
  const attempts: [string, string[]][] =
    process.platform === "darwin"
      ? [["pbcopy", []]]
      : process.platform === "win32"
        ? [["clip.exe", []]]
        : process.env.WAYLAND_DISPLAY
          ? [
              ["wl-copy", []],
              ["xclip", ["-selection", "clipboard"]],
              ["xsel", ["--clipboard", "--input"]],
            ]
          : [
              ["xclip", ["-selection", "clipboard"]],
              ["xsel", ["--clipboard", "--input"]],
              ["wl-copy", []],
            ];

  for (const [command, args] of attempts) {
    const result = spawnSync(command, args, {
      input: text,
      encoding: "utf8",
      stdio: ["pipe", "ignore", "ignore"],
    });

    if (!result.error && result.status === 0) {
      return command;
    }
  }

  return undefined;
}

function copyOsc52(text: string): boolean {
  const encoded = Buffer.from(text, "utf8").toString("base64");
  if (encoded.length > 100_000) {
    return false;
  }

  process.stdout.write(`\x1b]52;c;${encoded}\x07`);
  return true;
}

function copyToClipboard(text: string): void {
  if (copyNative(text)) return;
  if (copyOsc52(text)) return;
  throw new Error("Clipboard unavailable: no native command found and text is too large for terminal copy");
}

function getLastAssistantText(ctx: AnyContext): string | undefined {
  const sessionManager = ctx.sessionManager as any;
  const entries =
    typeof sessionManager.getBranch === "function"
      ? sessionManager.getBranch()
      : sessionManager.getEntries();

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    const message = entry?.type === "message" ? entry.message : undefined;
    if (message?.role !== "assistant" || !Array.isArray(message.content)) {
      continue;
    }

    const text = message.content
      .filter((c: any) => c?.type === "text" && typeof c.text === "string")
      .map((c: any) => c.text)
      .join("\n");

    if (text.trim()) {
      return text.trim();
    }
  }

  return undefined;
}

export default function copyMessageExtension(pi: ExtensionAPI) {
  async function run(_args: string, ctx: AnyContext): Promise<void> {
    if ("waitForIdle" in ctx) {
      await ctx.waitForIdle();
    }

    const text = getLastAssistantText(ctx);
    if (!text) {
      ctx.ui.notify("No assistant message to copy", "warning");
      return;
    }

    try {
      copyToClipboard(text);
      ctx.ui.notify("Copied last assistant message to clipboard", "info");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Copy failed: ${message}`, "error");
    }
  }

  pi.registerShortcut("ctrl+alt+s", {
    description: "Copy last assistant message to clipboard",
    handler: (ctx) => run("", ctx),
  });
}
