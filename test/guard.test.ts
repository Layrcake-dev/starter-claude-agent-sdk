import { describe, expect, it } from "vitest";
import { createGuard, parseToolText, toMicro } from "../src/guard.js";

// The hosted MCP server returns the API's JSON envelope as one text block.
const mcpResponse = (body: unknown) => ({ content: [{ type: "text", text: JSON.stringify(body, null, 2) }] });
const charged = (credits: string, result: unknown) =>
  mcpResponse({ result, layrcake: { request_id: "req_1", credits_charged: credits, credits_available: "250" } });

const newGuard = (overrides: { budget?: number; dryRun?: boolean } = {}) =>
  createGuard({ budget: 100, dryRun: false, runId: "run-test", ...overrides });

describe("guard", () => {
  it("adds the remaining budget and an idempotency key to paid calls", async () => {
    const decision = await newGuard().prepare("find_leads", { audience: "CFOs", titles: ["CFO"] });
    expect(decision).toMatchObject({ allow: true, input: { budget_credits: 100, audience: "CFOs" } });
    if (decision.allow) expect(decision.input.idempotency_key).toMatch(/^run-test-find_leads-[0-9a-f]{24}$/);
  });

  it("gives the same call the same idempotency key", async () => {
    const guard = newGuard();
    const first = await guard.prepare("verify_email", { email: "ada@acme.com" });
    const second = await guard.prepare("verify_email", { email: "ada@acme.com" });
    expect(first.allow && second.allow && first.input.idempotency_key === second.input.idempotency_key).toBe(true);
  });

  it("counts credits from Layrcake responses and lowers the next ceiling", async () => {
    const guard = newGuard();
    guard.record("enrich", {}, charged("5.000000", { contact: { work_email: "ada@acme.com" } }));
    guard.record("verify_email", { email: "ada@acme.com" }, charged("1.250000", { status: "valid" }));
    expect(guard.spent).toBe(6.25);
    expect(await guard.prepare("verify_email", { email: "bob@acme.com" })).toMatchObject({ input: { budget_credits: 93.75 } });
  });

  it("keeps a lower budget_credits the model asked for", async () => {
    expect(await newGuard().prepare("find_leads", { audience: "CFOs", titles: ["CFO"], budget_credits: 12 })).toMatchObject({ input: { budget_credits: 12 } });
  });

  it("refuses paid calls once the budget is spent", async () => {
    const guard = newGuard({ budget: 5 });
    guard.record("enrich", {}, charged("5", {}));
    expect(await guard.prepare("enrich", { person: { full_name: "Ada" } })).toMatchObject({ allow: false, reason: expect.stringMatching(/budget of 5 credits is spent/) });
  });

  it("asks enrich for a work email only", async () => {
    const decision = await newGuard().prepare("enrich", { person: { full_name: "Ada Lovelace" }, want: ["mobile_phone", "work_email"] });
    expect(decision).toMatchObject({ allow: true, input: { want: ["work_email"] } });
  });

  it("sends dry_run on every call that takes it", async () => {
    const decision = await newGuard({ dryRun: true }).prepare("create_campaign", { name: "x", leads: [{ email: "a@b.co" }], steps: [] });
    expect(decision).toMatchObject({ allow: true, input: { dry_run: true } });
  });

  it("only creates campaigns for emails that verified as sendable", async () => {
    const guard = newGuard();
    guard.record("verify_email", { email: "Ada@Acme.com" }, charged("1.25", { status: "valid" }));
    guard.record("verify_email", { email: "bob@acme.com" }, charged("1.25", { status: "invalid" }));
    const leads = [{ email: "ada@acme.com" }, { email: "bob@acme.com" }];
    expect(await guard.prepare("create_campaign", { name: "x", leads, steps: [] })).toEqual({
      allow: false,
      reason: "Verify these first, or drop them: bob@acme.com",
    });
    expect(await guard.prepare("create_campaign", { name: "x", leads: leads.slice(0, 1), steps: [] })).toMatchObject({ allow: true });
  });

  it("stops at the approval link and never approves", async () => {
    const guard = newGuard();
    expect(await guard.prepare("launch_campaign", { campaign_id: "c1", confirmation_token: "tok" })).toMatchObject({ allow: false });
    guard.record(
      "launch_campaign",
      { campaign_id: "c1" },
      mcpResponse({ result: { status: "needs_confirmation", campaign_id: "c1", confirmation_token: "tok", approval_url: "https://app.layrcake.dev/approvals/a1" } }),
    );
    expect(guard.approvalUrl).toBe("https://app.layrcake.dev/approvals/a1");
    expect(await guard.prepare("get_me", {})).toMatchObject({ allow: false, reason: expect.stringMatching(/waiting for approval/) });
  });

  it("refuses tools this agent does not use", async () => {
    expect(await newGuard().prepare("setup_sending", { emails_per_week: 500 })).toMatchObject({ allow: false });
  });

  it("reads every shape a tool result can arrive in", () => {
    const body = { result: { status: "valid" }, layrcake: { credits_charged: "1.25" } };
    for (const shape of [JSON.stringify(body), [{ type: "text", text: JSON.stringify(body) }], mcpResponse(body), body]) {
      expect(parseToolText(shape)).toEqual(body);
    }
  });

  it("assumes the whole ceiling was spent when a paid answer cannot be read", () => {
    const guard = newGuard();
    guard.record("enrich", { budget_credits: 40 }, { content: [{ type: "text", text: "not json" }] });
    expect(guard.spent).toBe(40);
  });

  it("reports what the run did", () => {
    const guard = newGuard();
    guard.record("find_leads", {}, charged("3", { leads: [{}, {}], total_found: 2 }));
    guard.record("verify_email", { email: "ada@acme.com" }, charged("1.25", { status: "catch_all_valid" }));
    expect(guard.summary()).toEqual({ found: 2, kept: 1, catchAll: 1, spent: 4.25, approvalUrl: null, launchError: null });
  });

  it("reads decimal credit strings exactly", () => {
    expect(toMicro("1.250000")).toBe(1_250_000);
    expect(toMicro("0.25")).toBe(250_000);
    expect(toMicro("3")).toBe(3_000_000);
  });
});
