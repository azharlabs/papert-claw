# Papert Claw

Org-level AI assistant — single deployment, multiple users, each with isolated workspace, memory, and tool auth. Multi-channel support (Slack now, WhatsApp planned).

## Architecture

- Single Node.js process: Hono HTTP server + Slack Bolt + agent runner
- Papert Code SDK (`@papert-code/sdk-typescript`) as agent runtime
- Kysely query builder with SQLite (default), Postgres planned
- Agent runs use configurable `PAPERT_PERMISSION_MODE` (default: `yolo` for non-interactive reliability)
- `canUseTool` currently runs in allow-all mode and logs decisions for diagnostics

## Tech Stack

TypeScript, Node.js 24, pnpm monorepo, Hono, Kysely, Biome, pino, zod, tsdown, tsx

## Node Version Management

- `.node-version` specifies Node 24
- Local dev (macOS): **nvm** — auto-switches via `.node-version`
- EC2 server: **fnm** — auto-switches via `.node-version` (still on Node 22, pending upgrade)
- Shell does NOT auto-load nvm/fnm, so it defaults to `/opt/homebrew/bin/node`. Currently this is also Node 24, so no prefix needed. If versions diverge again, prefix commands with: `. /Users/rnijhara/.nvm/nvm.sh && nvm use > /dev/null 2>&1 &&`

## Project Structure

```
papert-claw/
  .env                  → config (repo root, gitignored)
  .env.example          → documented env vars
  data/                 → runtime data (gitignored)
    papert-claw.db           → SQLite database
    workspaces/{uid}/   → per-user workspace dirs
  .planning/            → internal dev docs (gitignored)
    PRODUCT.md          → full product document
    STATE.md            → current state + next steps
    STEEL_THREAD.md     → steel thread implementation plan (done)
  packages/
    server/src/
      index.ts          → entry point, wires everything
      config.ts         → zod + dotenv config validation
      logger.ts         → pino logger factory
      http.ts           → Hono app with /health
      queue.ts          → per-channel in-memory message queue
      slack/bot.ts      → Slack Bolt adapter (Socket Mode, DMs)
      agent/
        runner.ts       → runAgent() — Papert SDK query() with permission mode + canUseTool
        prompt.ts       → buildSystemContext() for platform rules + isolation
        workspace.ts    → ensureWorkspace() creates user dirs
        sessions.ts     → session ID persistence for resume
      db/
        index.ts        → createDatabase() with SQLite + WAL
        schema.ts       → DB type interface (users table)
        migrate.ts      → static migration imports (bundler-safe)
        migrations/     → Kysely migrations
        repositories/   → query functions (users.ts)
    shared/src/         → shared types (placeholder)
```

## Conventions

- Biome for linting and formatting (tabs, 120 line width)
- Strict TypeScript (`strict: true`)
- Conventional commits: `feat:`, `fix:`, `chore:`
- pino for structured JSON logging — never log message content
- zod + dotenv for config validation (`import "dotenv/config"`, .env at repo root)
- Kysely migrations run at app startup (static imports, not FileMigrationProvider)
- No unnecessary inline comments — prefer docstrings explaining decisions
- Vitest for testing (not yet set up)
- Run `pnpm dev` from repo root — tsx watches `packages/server/src/index.ts`

## Key Design Decisions

- Platform formatting via system prompt only, no post-processing
- Prompt includes platform/org context injected into the user request payload
- Per-user workspace at `data/workspaces/{user_id}/` with session.json
- `PAPERT_PERMISSION_MODE` defaults to `yolo` to avoid non-interactive confirmation failures
- `canUseTool` is kept for logging/host policy hooks and currently allows all
- In-memory per-channel message queue (sequential processing, one agent run at a time per channel)
- LLM access: Anthropic API, Bedrock (`CLAUDE_CODE_USE_BEDROCK`), Vertex, or custom `ANTHROPIC_BASE_URL`
- Static migration imports instead of FileMigrationProvider (for tsdown bundler compatibility)
- `CURRENT_TIMESTAMP` in migrations for cross-dialect compatibility (SQLite + Postgres)

## Dev Workflow

Internal planning docs live in `.planning/` (gitignored):

- **PRODUCT.md** — high-level product document. The "what and why". Evolves slowly.
- **STATE.md** — current project state, what's done, next steps, current version. Updated at end of each work session. Quick context resume for new sessions.
- **Task files** — one per feature/story (e.g., `STEEL_THREAD.md`, `WHATSAPP_ADAPTER.md`). Implementation plans with phases. Become historical reference once done.
- **TODO.md** — tracked todos and backlog items. Lives in `.planning/TODO.md`.

Completed task files stay in `.planning/` — useful context when revisiting related areas.

**Planning approach:** Don't use plan mode. Instead, write design/plan docs directly as task files in `.planning/` (e.g., `.planning/FILE_SUPPORT.md`). Discuss and refine in conversation, then write the doc when ready.

## Reference

Full product document: `.planning/PRODUCT.md`
Current state: `.planning/STATE.md`
