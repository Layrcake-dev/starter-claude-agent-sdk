import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { createGuard, HIDDEN, TOOLS } from "./guard.js";
import { DEFAULT_BRIEF, instructions } from "./instructions.js";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { "dry-run": { type: "boolean", default: false } } });
const dryRun = values["dry-run"];
const brief = positionals.join(" ") || DEFAULT_BRIEF;
const budget = Number(process.env.BUDGET ?? 100);
const apiKey = process.env.LAYRCAKE_API_KEY;
if (!apiKey) throw new Error("Set LAYRCAKE_API_KEY. Get a key at https://layrcake.dev/connect");
if (!process.env.ANTHROPIC_API_KEY) throw new Error("Set ANTHROPIC_API_KEY. Get one at https://platform.claude.com");
if (!(budget > 0)) throw new Error("BUDGET must be a positive number of credits.");

const guard = createGuard({ budget, dryRun, runId: randomUUID() });
console.log(`${dryRun ? "Dry run, nothing is charged" : "Live run"}. Budget: ${budget} credits.\nBrief: ${brief}\n`);

for await (const message of query({
  prompt: brief,
  options: {
    model: process.env.MODEL ?? "claude-sonnet-5-5",
    systemPrompt: instructions({ budget, dryRun }),
    mcpServers: {
      layrcake: { type: "http", url: "https://mcp.layrcake.dev/mcp", headers: { Authorization: `Bearer ${apiKey}` } },
    },
    allowedTools: TOOLS.map((name) => `mcp__layrcake__${name}`),
    disallowedTools: HIDDEN.map((name) => `mcp__layrcake__${name}`),
    hooks: guard.hooks, // budget, dry run, verify before send, stop at the approval link
    tools: [], // no built-in tools: no shell, no file access
    settingSources: [], // ignore local Claude Code settings
    strictMcpConfig: true,
    persistSession: false,
    maxTurns: 40,
  },
})) {
  if (message.type === "system" && message.subtype === "init") {
    const server = message.mcp_servers.find((s) => s.name === "layrcake");
    if (server?.status === "failed" || server?.status === "needs-auth") throw new Error(`Layrcake MCP server: ${server.status}. Check LAYRCAKE_API_KEY.`);
  } else if (message.type === "assistant") {
    for (const block of message.message.content) {
      if (block.type === "tool_use") console.log(`-> ${block.name.replace("mcp__layrcake__", "")}`);
    }
  } else if (message.type === "result") {
    console.log(message.subtype === "success" ? `\n${message.result}` : `\nThe agent stopped early: ${message.subtype}`);
  }
}

console.log(`\nLayrcake credits spent: ${guard.spent} of ${budget}.`);
if (guard.approvalUrl) console.log(`Nothing has been sent. A person approves or declines here: ${guard.approvalUrl}`);
