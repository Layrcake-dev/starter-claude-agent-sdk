// Free setup check. Walks the dry-run path through the same guard the agent uses,
// against the hosted MCP server, with no model. Every paid call is a dry run.
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createGuard, parseToolText } from "./guard.js";

const apiKey = process.env.LAYRCAKE_API_KEY;
if (!apiKey) throw new Error("Set LAYRCAKE_API_KEY. Get a key at https://layrcake.dev/connect");
const budget = Number(process.env.BUDGET ?? 100);
const guard = createGuard({ budget, dryRun: true, runId: randomUUID() });
const client = new Client({ name: "starter-claude-agent-sdk-smoke", version: "1.0.0" });
await client.connect(
  new StreamableHTTPClientTransport(new URL("https://mcp.layrcake.dev/mcp"), {
    requestInit: { headers: { Authorization: `Bearer ${apiKey}` } },
  }),
);

const sample = { full_name: "Sample Person", company_domain: "example.com" };
const calls: [string, Record<string, unknown>][] = [
  ["get_me", {}],
  ["find_leads", { audience: "Heads of sales at London software companies with 20 to 200 staff", titles: ["Head of Sales"], locations: ["London, United Kingdom"], industries: ["Software Development"], company_headcount: { min: 20, max: 200 }, limit: 10 }],
  ["enrich", { person: sample, want: ["work_email"] }],
  ["verify_email", { email: "sample.person@example.com" }],
  ["create_campaign", { name: "Smoke test", leads: [{ email: "sample.person@example.com", first_name: "Sample" }], steps: [{ subject: "Hello", body: "Hi {{first_name}}" }] }],
];

try {
  for (const [tool, args] of calls) {
    const decision = await guard.prepare(tool, args);
    if (!decision.allow) throw new Error(`${tool}: ${decision.reason}`);
    const response = await client.callTool({ name: tool, arguments: decision.input });
    guard.record(tool, decision.input, response);
    const body = parseToolText(response);
    if (response.isError || !body) throw new Error(`${tool} failed: ${JSON.stringify(response.content).slice(0, 300)}`);
    const result = body.result as { plan?: { credits_estimate?: string; would_exceed?: string[] } } | undefined;
    const plan = result?.plan;
    console.log(plan ? `${tool}: would cost up to ${plan.credits_estimate} credits${plan.would_exceed?.length ? `, would trip: ${plan.would_exceed.join(", ")}` : ""}` : `${tool}: ok`);
  }
  console.log(`\nCharged: ${guard.spent} credits. Your key and the Layrcake MCP server work.`);
} finally {
  await client.close();
}
