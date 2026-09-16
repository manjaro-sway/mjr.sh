# Plan 003: Move the link purge out of `/add` into a scheduled Cron Trigger

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 302035d..HEAD -- src/handlers/add.ts src/index.ts src/allowList.ts wrangler.toml`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: MED
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `302035d`, 2026-09-16

## Why this matters

`/add` currently runs a destructive bulk `DELETE` on a 1-in-10 random chance,
inline in the user's request. Three concrete problems:

1. **An unauthenticated public endpoint triggers bulk deletion.** Anyone calling
   `/add` repeatedly is also repeatedly running the purge.
2. **Unpredictable latency.** One in ten users pays for a full table scan and
   delete before their link is created.
3. **It has already caused unintended data loss in this repo.** A routine smoke
   test against production triggered the purge and deleted 18 rows; they had to
   be restored from an export.

There is also a latent correctness bug in the comparison, described below.

After this plan, the purge runs once a day on a schedule, `/add` does no
deletion, and the timestamp comparison is correct.

## Current state

Files involved:

- `src/handlers/add.ts` — contains the inline purge (lines 29–43)
- `src/allowList.ts` — the exempt-domain list and `getCutoffDate()`
- `src/index.ts` — the Worker entrypoint; will gain a `scheduled` handler
- `wrangler.toml` — needs a `[triggers]` block

`src/handlers/add.ts:19-43` as it exists today:

```ts
export const add = async (request: Request, env: Env): Promise<Response> => {
	const { searchParams } = new URL(request.url);
	const input = queryValidator.safeParse(Object.fromEntries(searchParams));

	if (!input.success) {
		return Response.json(input.error, { status: 400 });
	}

	const db = getDB(env);

	const shouldCleanup = Math.floor(Math.random() * 10) === 0;

	// cleanup non-manjaro links older than 14 days
	if (shouldCleanup) {
		await db
			.deleteFrom("urls")
			.where((eb) =>
				eb("timestamp", "<", getCutoffDate()).and(
					"domain",
					"not in",
					allowList,
				),
			)
			.execute();
	}
```

`src/allowList.ts` in full as it exists today:

```ts
/**
 * List of domains that are _not_ purged after the cutOff date.
 */
const allowList = [
	"github.com",
	"gitlab.com",
	"google.com",
	"google.de",
	"heise.de",
	"manjaro.org",
	"manjaro.download",
	"manjaro-sway.download",
	"githubusercontent.com",
	"youtube.com",
];

const cutOffDays = 14;
export const getCutoffDate = () => {
	const cutOff = new Date(
		Date.now() - 1000 * 60 * 60 * 24 * cutOffDays,
	).toISOString();

	return cutOff;
};

export default allowList;
```

`src/index.ts` in full as it exists today:

```ts
import { add } from "./handlers/add";
import { edit } from "./handlers/edit";
import { redirect } from "./handlers/redirect";
import { globalStats, keyStats } from "./handlers/stats";
import { keyValidator } from "./utils";

const notFound = () => Response.json({ error: "Not found" }, { status: 404 });

export default {
	async fetch(request, env) {
		const { pathname } = new URL(request.url);
		const [first, second, ...rest] = pathname.split("/").filter(Boolean);

		if (rest.length > 0) return notFound();

		if (first === undefined) return notFound();
		if (first === "add" && second === undefined) return add(request, env);
		if (first === "stats" && second === undefined)
			return globalStats(request, env);

		const key = keyValidator.safeParse(first);
		if (!key.success) return Response.json(key.error, { status: 400 });

		switch (second) {
			case undefined:
				return redirect(env, key.data);
			case "edit":
				return edit(request, env, key.data);
			case "stats":
				return keyStats(request, env, key.data);
			default:
				return notFound();
		}
	},
} satisfies ExportedHandler<Env>;
```

### The timestamp format bug

`getCutoffDate()` returns an ISO-8601 string: `2026-09-02T09:08:06.813Z`.
The `timestamp` column is populated by SQLite's `current_timestamp`, whose format
is `2026-09-02 23:59:00` — **space separator, no milliseconds, no `Z`**.

The comparison `timestamp < cutoff` is therefore a lexicographic string compare
between two different formats. Because `"T"` (char 84) sorts after `" "` (char
32), rows from the same calendar day as the cutoff compare as *earlier* than the
cutoff and get purged a day sooner than intended. Verified in this environment.

The fix is to emit the cutoff in SQLite's own format.

Repo conventions to match:

- Tabs, double quotes, semicolons — Biome enforces; run `bun run check`.
- `Env` is an ambient global from `worker-configuration.d.ts`; never import it.
- Kysely query-builder style as seen above; `sql` template tag imported from
  `kysely` when raw SQL is needed.
- Handlers live in `src/handlers/` and export a single named function.

Verified facts about Cron Triggers (from Cloudflare docs, cited below):

- `[triggers]` with `crons = ["…"]` in `wrangler.toml`.
- Handler signature: `async scheduled(controller, env, ctx)`, coexisting with
  `fetch` in the same `export default {}`.
- Local testing requires `wrangler dev --test-scheduled`, then hitting
  `http://localhost:PORT/cdn-cgi/handler/scheduled`.
- Docs: https://developers.cloudflare.com/workers/configuration/cron-triggers/
  and https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/

## Commands you will need

| Purpose   | Command                | Expected on success            |
|-----------|------------------------|--------------------------------|
| Install   | `bun install`          | exit 0                         |
| Typecheck | `bun run typecheck`    | exit 0, no output              |
| Lint      | `bun run check`        | exit 0                         |
| Dry-run   | `bunx wrangler deploy --dry-run --outdir /tmp/mjr-dryrun` | exit 0 |

There is no test suite in this repo.

## Scope

**In scope** (the only files you should modify):

- `src/handlers/add.ts`
- `src/allowList.ts`
- `src/handlers/purge.ts` (create)
- `src/index.ts`
- `wrangler.toml`

**Out of scope** (do NOT touch, even though they look related):

- The contents of the `allowList` array — do not add or remove domains.
- `cutOffDays = 14` — keep the retention period exactly as-is.
- `src/handlers/redirect.ts`, `src/handlers/stats.ts`, `src/handlers/edit.ts`.
- Any schema/migration change. The purge works on existing columns.
- Do NOT run the purge against the production database at any point.

## Git workflow

- Branch: `advisor/003-move-purge-to-cron`
- One commit is fine.
- Commit message style: capitalized imperative sentence, no trailing period.
  Example from `git log`: `Convert from Pages Functions to a standalone Worker`.
- Do NOT push or open a PR.

## Steps

### Step 1: Fix the cutoff format in `src/allowList.ts`

Change `getCutoffDate()` to return SQLite's `YYYY-MM-DD HH:MM:SS` format instead
of ISO-8601, so the string comparison against the `timestamp` column compares
like with like.

The shape to produce — replacing only the body of `getCutoffDate`:

```ts
const cutOffDays = 14;
/**
 * SQLite's `current_timestamp` writes `YYYY-MM-DD HH:MM:SS`, so the cutoff has
 * to use the same shape for the string comparison in the purge to be correct.
 */
export const getCutoffDate = () => {
	const cutOff = new Date(Date.now() - 1000 * 60 * 60 * 24 * cutOffDays);

	return cutOff.toISOString().replace("T", " ").slice(0, 19);
};
```

Leave the `allowList` array and the doc comment above it untouched.

**Verify**: `bun run typecheck` → exit 0. Then run this one-liner and confirm the
format has no `T` and no `Z`:

```sh
bun -e 'import { getCutoffDate } from "./src/allowList"; console.log(getCutoffDate());'
```

Expected: a string like `2026-09-02 09:08:06` (19 characters, space separator).

### Step 2: Create `src/handlers/purge.ts`

Move the deletion logic into its own handler, exported as a named function that
returns the number of deleted rows so the scheduled handler can log it.

The shape to produce:

```ts
import allowList, { getCutoffDate } from "../allowList";
import { getDB } from "../utils";

export const purge = async (env: Env): Promise<number> => {
	const result = await getDB(env)
		.deleteFrom("urls")
		.where((eb) =>
			eb("timestamp", "<", getCutoffDate()).and("domain", "not in", allowList),
		)
		.execute();

	return Number(result[0]?.numDeletedRows ?? 0);
};
```

Note: Kysely's `.execute()` on a delete returns an array of
`DeleteResult` objects whose `numDeletedRows` is a `bigint`; `Number(...)` is
needed for a plain number return. If typecheck disagrees with this shape, adjust
the conversion minimally to satisfy the compiler and note it in your report.

**Verify**: `bun run typecheck` → exit 0, no output.

### Step 3: Remove the inline purge from `src/handlers/add.ts`

Delete these lines entirely (currently lines 29–43):

```ts
	const shouldCleanup = Math.floor(Math.random() * 10) === 0;

	// cleanup non-manjaro links older than 14 days
	if (shouldCleanup) {
		await db
			.deleteFrom("urls")
			.where((eb) =>
				eb("timestamp", "<", getCutoffDate()).and(
					"domain",
					"not in",
					allowList,
				),
			)
			.execute();
	}
```

Then remove the now-unused import at the top of the file:

```ts
import allowList, { getCutoffDate } from "../allowList";
```

Keep `const db = getDB(env);` — it is still used by the insert below.

**Verify**: `bun run typecheck` → exit 0 (this catches a missed unused import,
because `noUnusedLocals` is enabled in `tsconfig.json`). Then:

```sh
grep -n "allowList\|getCutoffDate\|shouldCleanup\|deleteFrom" src/handlers/add.ts
```

Expected: **no matches**.

### Step 4: Add the `scheduled` handler to `src/index.ts`

Add a `scheduled` method to the existing `export default {}` object, alongside
`fetch`. Import `purge` from `./handlers/purge`.

The shape to produce — the object gains a second method after `fetch`:

```ts
	async scheduled(_controller, env, _ctx) {
		const deleted = await purge(env);
		console.info(`purged ${deleted} expired links`);
	},
```

Leave the `fetch` handler and the `satisfies ExportedHandler<Env>` assertion
exactly as they are. The underscore prefixes avoid `noUnusedParameters` errors —
`tsconfig.json` has that flag enabled.

**Verify**: `bun run typecheck` → exit 0, no output. Then `bun run check` → exit 0.

### Step 5: Declare the cron schedule in `wrangler.toml`

Add this block at the end of the file:

```toml
[triggers]
crons = ["0 3 * * *"]
```

That runs the purge daily at 03:00 UTC.

**Verify**: `bunx wrangler deploy --dry-run --outdir /tmp/mjr-dryrun` → exit 0.

### Step 6: Smoke test the scheduled purge locally

Set up local state (safe: `--local` only touches `.wrangler/state`, never
production):

```sh
cp -n .dev.vars.example .dev.vars || true
bun run build
bunx wrangler d1 execute mjr-sh --local --file=./schema.sql -y
bunx wrangler d1 migrations apply mjr-sh --local
```

Seed one purgeable row (old, non-allowlist) and one protected row (old, but on
the allowlist), plus one fresh row:

```sh
bunx wrangler d1 execute mjr-sh --local -y --command "
INSERT INTO urls (key, value, secret, count, timestamp, domain) VALUES
 ('OLD1','https://spam.example.com/a','x',0,'2020-01-01 00:00:00','spam.example.com'),
 ('OLD2','https://github.com/a','y',0,'2020-01-01 00:00:00','github.com'),
 ('NEW1','https://fresh.example.com/a','z',0,datetime('now'),'fresh.example.com');"

bunx wrangler d1 execute mjr-sh --local --command "select key from urls order by key" --json
```

Expected before purge: `OLD1`, `OLD2`, `NEW1` all present.

Start dev with scheduled testing enabled and fire the trigger:

```sh
bunx wrangler dev --port 8799 --test-scheduled > /tmp/mjr-003.log 2>&1 &
for i in $(seq 1 30); do curl -sf -o /dev/null http://127.0.0.1:8799/stats && break; sleep 1; done
curl -s "http://127.0.0.1:8799/cdn-cgi/handler/scheduled"
pkill -f "wrangler dev"
```

Check the result:

```sh
bunx wrangler d1 execute mjr-sh --local --command "select key from urls order by key" --json
```

**Verify**: after the trigger, `OLD1` is gone; `OLD2` (allowlisted) and `NEW1`
(recent) both remain. If `/cdn-cgi/handler/scheduled` returns 404, try
`/__scheduled` — the endpoint path has changed between wrangler versions; report
which one worked.

Also confirm `/add` no longer deletes:

```sh
bunx wrangler dev --port 8799 > /tmp/mjr-003b.log 2>&1 &
for i in $(seq 1 30); do curl -sf -o /dev/null http://127.0.0.1:8799/stats && break; sleep 1; done
for i in $(seq 1 30); do curl -s -o /dev/null "http://127.0.0.1:8799/add?url=https://example$i.com"; done
pkill -f "wrangler dev"
bunx wrangler d1 execute mjr-sh --local --command "select count(*) n from urls where key='OLD2'" --json
```

**Verify**: `OLD2` still present (count 1) after 30 `/add` calls. Before this
change, 30 calls had a ~96% chance of triggering at least one purge.

## Test plan

No new automated tests. This repo has no test runner, no test files, and no
`test` script; introducing a test framework is out of scope. Steps 1 and 6 are
the verification.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun run typecheck` exits 0
- [ ] `bun run check` exits 0
- [ ] `grep -n "Math.random" src/handlers/add.ts` returns **only** the `keyLength` line (the `shouldCleanup` line is gone)
- [ ] `grep -rn "deleteFrom" src/` matches **only** `src/handlers/purge.ts`
- [ ] `grep -n "crons" wrangler.toml` returns a match
- [ ] `grep -n "scheduled" src/index.ts` returns a match
- [ ] Step 1 verify prints a timestamp with a space separator and no `Z`
- [ ] Step 6: after the scheduled trigger, `OLD1` is deleted while `OLD2` and `NEW1` remain
- [ ] Step 6: 30 `/add` calls delete nothing
- [ ] `git status --porcelain` shows changes only to the in-scope files

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts in "Current state" do not match the live files.
- Kysely's delete result does not expose `numDeletedRows` and you cannot get a
  row count without changing the query — return `0` and say so in your report
  rather than restructuring the query.
- Neither `/cdn-cgi/handler/scheduled` nor `/__scheduled` triggers the handler —
  report what you tried; do not add an HTTP route that calls `purge` as a
  workaround. A publicly reachable purge endpoint would reintroduce the exact
  vulnerability this plan removes.
- The purge deletes `OLD2` (an allowlisted domain) — the allowlist condition is
  broken; STOP immediately.
- You are tempted to run any command with `--remote`. Never do this. The
  production database must not be touched by this plan.

## Maintenance notes

- The purge now has exactly one caller (`scheduled` in `src/index.ts`). If a
  manual trigger is ever wanted, it must be authenticated — never a bare public route.
- `getCutoffDate()` returning SQLite-format strings is now load-bearing for the
  purge comparison. If anything else starts consuming it, check the format
  assumption.
- The `domain` column is populated by naive last-two-label extraction in
  `add.ts`, which is wrong for multi-part TLDs (`evil.com.co.uk` → `co.uk`).
  That affects which rows the allowlist protects. It is addressed separately in
  plan 006 — do not fix it here.
- A reviewer should confirm that no code path reachable from an unauthenticated
  HTTP request can call `purge`.
- Cron schedule `0 3 * * *` is arbitrary; any daily time works. Cron triggers on
  the Workers free plan are supported.
