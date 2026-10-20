import { createHash } from "node:crypto";
import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import { getApproval } from "layrcake";

/** The Layrcake tools this agent may call. Everything else on the server is refused. */
export const TOOLS = ["get_me", "find_leads", "enrich", "verify_email", "create_campaign", "launch_campaign"] as const;
/** Tools that buy sending capacity or reach people. Hidden from the model, and refused by the guard too. */
export const HIDDEN = ["setup_sending", "reply_to_thread", "add_leads"] as const;
const PAID = new Set(["find_leads", "enrich", "verify_email"]);
const DRY_RUNNABLE = new Set(["find_leads", "enrich", "verify_email", "create_campaign", "launch_campaign"]);
/** verify_email answers we send to. Everything else is dropped. */
const SENDABLE = new Set(["valid", "catch_all_valid"]);
const MICRO = 1_000_000;

export interface GuardOptions {
  /** Credit ceiling for the whole run. */
  budget: number;
  /** Send dry_run: true on every call that takes it. Nothing is charged. */
  dryRun: boolean;
  /** Stable per run. Idempotency keys derive from it, so a repeated call is never charged twice. */
  runId: string;
}

export type Decision = { allow: true; input: Record<string, unknown> } | { allow: false; reason: string };

/** Credits arrive as decimal strings ("1.250000"). Count them in whole micro-credits, never floats. */
export function toMicro(credits: unknown): number {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(String(credits ?? "0"));
  return match ? Number(match[1]) * MICRO + Number((match[2] ?? "").padEnd(6, "0")) : 0;
}

/** Reads the JSON a Layrcake MCP tool returns. It arrives as one text block. */
export function parseToolText(response: unknown): Record<string, unknown> | null {
  if (response && typeof response === "object" && "layrcake" in response) return response as Record<string, unknown>;
  const content = (response as { content?: unknown } | null)?.content ?? response;
  const blocks = Array.isArray(content) ? content : [content];
  const text = blocks.map((b) => (typeof b === "string" ? b : ((b as { text?: string } | null)?.text ?? ""))).join("");
  try {
    const body: unknown = JSON.parse(text);
    return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function createGuard({ budget, dryRun, runId }: GuardOptions) {
  const state = { spentMicro: 0, approvalUrl: null as string | null, verified: new Set<string>() };
  const remaining = () => budget * MICRO - state.spentMicro;

  /** Runs before every Layrcake call. Returns the arguments to send, or why the call is refused. */
  function prepare(tool: string, args: Record<string, unknown>): Decision {
    if (!(TOOLS as readonly string[]).includes(tool)) return { allow: false, reason: `This agent does not use ${tool}.` };
    if (state.approvalUrl) return { allow: false, reason: "The campaign is waiting for a person to approve it. Stop and report the approval link." };
    if (tool === "launch_campaign" && (args.confirmation_token || args.supersedes)) {
      return { allow: false, reason: "Only a person approves, at the approval link. Never send confirmation_token." };
    }
    const input: Record<string, unknown> = { ...args };
    if (tool === "create_campaign" && !dryRun) {
      const leads = Array.isArray(input.leads) ? (input.leads as { email?: string }[]) : [];
      const unverified = leads.map((l) => String(l.email ?? "")).filter((e) => !state.verified.has(e.toLowerCase()));
      if (unverified.length) return { allow: false, reason: `Verify these first, or drop them: ${unverified.join(", ")}` };
    }
    if (tool === "enrich") input.want = ["work_email"]; // mobile lookups cost more and this agent only emails
    if (PAID.has(tool)) {
      if (remaining() < MICRO / 100) return { allow: false, reason: `The run budget of ${budget} credits is spent. Stop and report.` };
      const ceiling = Math.min(remaining() / MICRO, 2000, Number(input.budget_credits) || Infinity);
      input.budget_credits = Math.floor(ceiling * 100) / 100;
    }
    if (dryRun && DRY_RUNNABLE.has(tool)) input.dry_run = true;
    if (tool !== "get_me" && !input.idempotency_key) {
      // Same call, same key: a repeated call returns the first result instead of charging again.
      const digest = createHash("sha256").update(JSON.stringify({ args, dryRun })).digest("hex").slice(0, 24);
      input.idempotency_key = `${runId}-${tool}-${digest}`;
    }
    return { allow: true, input };
  }

  /** Runs after every Layrcake call: counts credits, remembers verified emails, catches the approval link. */
  function record(tool: string, args: Record<string, unknown>, response: unknown): void {
    const body = parseToolText(response);
    if (!body) {
      // Fail closed: if a paid answer cannot be read, assume it cost its whole ceiling.
      if (PAID.has(tool)) state.spentMicro += args.budget_credits ? toMicro(args.budget_credits) : remaining();
      return;
    }
    state.spentMicro += toMicro((body.layrcake as { credits_charged?: unknown } | undefined)?.credits_charged);
    const result = (body.result ?? body) as Record<string, unknown>;
    if (tool === "verify_email" && SENDABLE.has(String(result.status))) state.verified.add(String(args.email).toLowerCase());
    if (tool === "launch_campaign") state.approvalUrl = getApproval(result)?.approvalUrl ?? state.approvalUrl;
  }

  const hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {
    PreToolUse: [
      {
        matcher: "^mcp__layrcake__",
        hooks: [
          async (hook) => {
            if (hook.hook_event_name !== "PreToolUse") return {};
            const decision = prepare(hook.tool_name.replace("mcp__layrcake__", ""), hook.tool_input as Record<string, unknown>);
            return {
              hookSpecificOutput: decision.allow
                ? { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: decision.input }
                : { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: decision.reason },
            };
          },
        ],
      },
    ],
    PostToolUse: [
      {
        matcher: "^mcp__layrcake__",
        hooks: [
          async (hook) => {
            if (hook.hook_event_name !== "PostToolUse") return {};
            record(hook.tool_name.replace("mcp__layrcake__", ""), hook.tool_input as Record<string, unknown>, hook.tool_response);
            return {};
          },
        ],
      },
    ],
  };

  return {
    hooks,
    prepare,
    record,
    get spent() {
      return state.spentMicro / MICRO;
    },
    get approvalUrl() {
      return state.approvalUrl;
    },
  };
}
