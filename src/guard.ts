import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import { AGENT_TOOL_NAMES, createAgentRun, PAID_TOOLS } from "layrcake/agent-tools";

/** The Layrcake tools this agent may call. Everything else on the server is refused. */
export const TOOLS = ["get_me", ...AGENT_TOOL_NAMES] as const;
/** Tools that buy sending capacity or reach people. Hidden from the model, and refused by the guard too. */
export const HIDDEN = ["setup_sending", "reply_to_thread", "add_leads"] as const;
const PAID = new Set<string>(PAID_TOOLS);
const DRY_RUNNABLE = new Set<string>(AGENT_TOOL_NAMES);

export { toMicro } from "layrcake/agent-tools";

export interface GuardOptions {
  /** Credit ceiling for the whole run. */
  budget: number;
  /** Send dry_run: true on every call that takes it. Nothing is charged. */
  dryRun: boolean;
  /** Stable per run. Idempotency keys derive from it, so a repeated call is never charged twice. */
  runId: string;
}

export type Decision = { allow: true; input: Record<string, unknown> } | { allow: false; reason: string };

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

/**
 * Hooks that hold the MCP tools to the same rules as the Layrcake agent tools. The run
 * state (budget, verified emails, approval stop, idempotency keys) is layrcake/agent-tools'
 * createAgentRun. This file adds only what MCP needs: an allowlist, the arguments the
 * MCP tools take, and reading their text responses.
 */
export function createGuard({ budget, dryRun, runId }: GuardOptions) {
  const run = createAgentRun({ budget, dryRun, runId });

  /** Runs before every Layrcake call. Returns the arguments to send, or why the call is refused. */
  async function prepare(tool: string, args: Record<string, unknown>): Promise<Decision> {
    if (!(TOOLS as readonly string[]).includes(tool)) return { allow: false, reason: `This agent does not use ${tool}.` };
    if (tool === "launch_campaign" && (args.confirmation_token || args.supersedes)) {
      return { allow: false, reason: "Only a person approves, at the approval link. Never send confirmation_token." };
    }
    const refusal = run.refusal(PAID.has(tool));
    if (refusal) return { allow: false, reason: refusal.message };
    const input: Record<string, unknown> = { ...args };
    if (tool === "create_campaign" && !dryRun) {
      const leads = Array.isArray(input.leads) ? (input.leads as { email?: string }[]) : [];
      const unverified = run.unverified(leads.map((l) => String(l.email ?? "")));
      if (unverified.length) return { allow: false, reason: `Verify these first, or drop them: ${unverified.join(", ")}` };
    }
    if (tool === "enrich") input.want = ["work_email"]; // mobile lookups cost more and this agent only emails
    if (PAID.has(tool)) input.budget_credits = run.ceiling(Number(input.budget_credits) || undefined);
    if (dryRun && DRY_RUNNABLE.has(tool)) input.dry_run = true;
    // Same call, same key: a repeated call returns the first result instead of charging again.
    if (tool !== "get_me" && !input.idempotency_key) input.idempotency_key = await run.idempotencyKey(tool, args);
    return { allow: true, input };
  }

  /** Runs after every Layrcake call: counts credits, remembers verified emails, catches the approval link. */
  function record(tool: string, args: Record<string, unknown>, response: unknown): void {
    const body = parseToolText(response);
    if (!body) {
      // Fail closed: if a paid answer cannot be read, assume it cost its whole ceiling.
      if (PAID.has(tool)) run.charge(args.budget_credits ?? run.left);
      return;
    }
    run.charge((body.layrcake as { credits_charged?: unknown } | undefined)?.credits_charged);
    const result = (body.result ?? body) as Record<string, unknown>;
    if (tool === "find_leads" && Array.isArray(result.leads)) run.recordFound(result.leads.length);
    if (tool === "verify_email" && typeof result.status === "string") run.recordVerification(String(args.email), result.status);
    if (tool === "launch_campaign") run.recordLaunch(result);
  }

  const hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {
    PreToolUse: [
      {
        matcher: "^mcp__layrcake__",
        hooks: [
          async (hook) => {
            if (hook.hook_event_name !== "PreToolUse") return {};
            const decision = await prepare(hook.tool_name.replace("mcp__layrcake__", ""), hook.tool_input as Record<string, unknown>);
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
    /** What the run did so far: found, kept, catchAll, spent, approvalUrl. */
    summary: () => run.summary(),
    get spent() {
      return run.spent;
    },
    get approvalUrl() {
      return run.approvalUrl;
    },
  };
}
