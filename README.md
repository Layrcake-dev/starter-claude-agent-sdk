# Layrcake starter for the Claude Agent SDK

A Claude agent that turns a one-sentence brief into about 10 people with verified work emails and a draft campaign, then stops at the approval link.

It uses the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) in TypeScript and the hosted [Layrcake](https://layrcake.dev) MCP server. Nothing is sent. A person approves the campaign in the Layrcake console before any email goes out.

## What it does

1. `find_leads` finds people who match your brief.
2. `enrich` gets each person's work email.
3. `verify_email` checks every address. Only `valid` and `catch_all_valid` addresses are kept.
4. `create_campaign` saves a short draft sequence for the kept people. Drafts never send.
5. `launch_campaign` returns a preview and an approval link. The agent stops there.

## Why MCP for this kit

The Claude Agent SDK is built around MCP. Pointing it at `https://mcp.layrcake.dev/mcp` gives Claude every Layrcake tool with the schemas and descriptions Layrcake maintains. There are no tool definitions to write or keep in sync.

The Agent SDK's hooks let the starter enforce the rules in code, not just in the prompt. `src/guard.ts` runs before and after every Layrcake call. Its run state (budget, verified emails, the approval stop and idempotency keys) is `createAgentRun` from `layrcake/agent-tools`, the same code the Layrcake AI SDK and Mastra tools use:

- It sets `budget_credits` on each paid call to what is left of `BUDGET`, and refuses calls once the budget is spent.
- It adds `dry_run: true` to every call when you pass `--dry-run`.
- It adds an idempotency key derived from the call, so a repeated call returns the first result instead of charging again.
- It refuses `create_campaign` for any address that did not pass `verify_email` in this run.
- It refuses `confirmation_token` on `launch_campaign`, and refuses every call after the approval link appears.
- It allows only the six tools this agent needs. `setup_sending`, `reply_to_thread` and `add_leads` are also hidden from the model.

Built-in tools are off (`tools: []`), so the agent has no shell and no file access. Local Claude Code settings are ignored.

If you prefer plain function calls, the official SDKs work too: [layrcake-js](https://github.com/Layrcake-dev/layrcake-js) and [layrcake-python](https://github.com/Layrcake-dev/layrcake-python). This kit already uses `layrcake/agent-tools` from the `layrcake` package for its run state.

## Prerequisites

- Node.js 22.12 or later.
- A Layrcake API key. Create one at [layrcake.dev/connect](https://layrcake.dev/connect). New accounts start with 300 free credits.
- An Anthropic API key from [platform.claude.com](https://platform.claude.com).
- Sending mailboxes in your Layrcake workspace, for the launch preview. Without them, `launch_campaign` explains what is missing and the agent reports it.

## Setup

```sh
npm install
cp .env.example .env   # then add LAYRCAKE_API_KEY and ANTHROPIC_API_KEY
npm run smoke          # free check of your Layrcake key, no model call
```

`npm run smoke` walks the dry-run path through the same guard the agent uses, against the live MCP server. It charges nothing and calls no model. It prints something like this:

```text
get_me: ok
find_leads: would cost up to 3 credits
enrich: would cost up to 5 credits
verify_email: would cost up to 1.25 credits
create_campaign: would cost up to 0 credits

Charged: 0 credits. Your key and the Layrcake MCP server work.
```

If `create_campaign` says it `would trip: sending_capacity`, connect mailboxes in the [Layrcake console](https://app.layrcake.dev) before a live run.

## Run

Start with a dry run. Every Layrcake call returns a plan with its cost instead of data, so it is free. It still uses your Anthropic key.

```sh
npm start -- --dry-run
```

Then run it for real with your own brief:

```sh
npm start -- "Find 10 heads of sales at software companies in London with 20 to 200 staff and draft a short campaign about cutting time spent on lead research."
```

With no brief, it uses the one above.

## What you will see

Each Layrcake call prints as it happens, then Claude's report, then two lines from the guard:

```text
Live run. Budget: 25 credits.
Brief: Find 3 heads of sales at software companies in London with 20 to 200 staff, verify their work emails, and draft a short campaign about cutting time spent on lead research.

-> find_leads
-> enrich
-> enrich
-> enrich
-> enrich
-> enrich
-> enrich
-> verify_email
-> verify_email
-> verify_email
-> create_campaign
-> launch_campaign

(Claude's report: 10 people found, 3 enriched, 3 emails kept with 1 catch-all, and a warning that one lookup may have returned a different person)

Layrcake credits spent: 21.75 of 25.
Nothing has been sent. A person approves or declines here: <approval link>
```

This is our test run on 20 October 2026, with `BUDGET=25`, the three-person brief above and `anthropic/claude-sonnet-5.5` through OpenRouter. It took 45 seconds. Only three of the six `enrich` calls were charged. Your run will differ.

## How approval works

`launch_campaign` never sends on its own. Its first answer is a preview, a `confirmation_token` and an `approval_url`. The agent prints the link and stops.

A signed-in person in your workspace opens the link, reads the preview and approves or declines. Layrcake can also email an approver in your workspace. After approval, Layrcake starts the campaign itself when the approval says `execution: server`. Otherwise you repeat the call with the token. The agent in this kit never does either. It cannot approve, and the guard refuses any call that carries a token.

## Cost

Our test runs of the default brief cost 45.5 to 53 Layrcake credits. A credit is $0.01. Finding people costs 0.25 credits each, an email costs 5 credits when found, a verification costs 1.25, and lookups that find nothing are free. Drafting the campaign is free. See [pricing](https://docs.layrcake.dev/pricing.html).

`BUDGET` in `.env` is the ceiling for the whole run (default 100). The Anthropic model usage is billed separately by Anthropic. Set `MODEL` to change the model. The default is `claude-sonnet-5-5`.

## Using OpenRouter

The kit runs unchanged through [OpenRouter](https://openrouter.ai). Put these in `.env` instead of a direct model key:

```text
ANTHROPIC_BASE_URL=https://openrouter.ai/api
ANTHROPIC_AUTH_TOKEN=<your OpenRouter key>
ANTHROPIC_API_KEY=<your OpenRouter key>
MODEL=anthropic/claude-sonnet-5.5
```

We ran this kit this way on 20 October 2026.

## Project layout

```text
src/agent.ts         the agent: options, MCP server, output
src/guard.ts         hooks that enforce budget, dry run, verification and approval
src/instructions.ts  the system prompt
src/smoke.ts         free setup check, no model call
test/guard.test.ts   guard tests with mocked Layrcake responses
```

## Development

```sh
npm run lint
npm run typecheck
npm test
```

The tests use mocked Layrcake responses. They need no keys and make no network calls.

## Links

- Layrcake docs: [docs.layrcake.dev](https://docs.layrcake.dev)
- Rules for agents: [layrcake.dev/agents.md](https://layrcake.dev/agents.md)
- TypeScript SDK: [github.com/Layrcake-dev/layrcake-js](https://github.com/Layrcake-dev/layrcake-js)
- Python SDK: [github.com/Layrcake-dev/layrcake-python](https://github.com/Layrcake-dev/layrcake-python)
- MCP server: `https://mcp.layrcake.dev/mcp`
- Claude Agent SDK: [code.claude.com/docs/en/agent-sdk/overview](https://code.claude.com/docs/en/agent-sdk/overview)

## License

MIT. See [LICENSE](LICENSE).
