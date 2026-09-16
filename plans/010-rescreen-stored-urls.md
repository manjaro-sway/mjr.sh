# Plan 010: Re-screen stored URLs against the blocklist on the daily cron

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 0985651..HEAD -- src/blocklist.ts src/index.ts src/handlers/purge.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: MED
- **Depends on**: none (003 and 005 already landed on `main`)
- **Category**: security
- **Planned at**: commit `0985651`, 2026-09-16

## Why this matters

The blocklist and Safe Browsing checks run at write time only. Two consequences:

1. **Links created before those checks existed were never screened.** The
   database holds ~131 links, all predating the blocklist.
2. **A domain can turn malicious after a link is stored.** The blocklist
   refreshes daily; a link created yesterday pointing at a domain added to the
   feed today is never re-examined.

The daily cron already fetches a fresh blocklist. Screening stored URLs against
it in the same run costs one extra pass over a small table and closes both gaps.

After this plan, the cron reports how many stored links now point at blocklisted
domains — and, because deleting user data automatically is a bigger decision
than this plan should make on its own, it **reports without deleting** by
default. See "Maintenance notes" for why.

## Current state

Files involved:

- `src/blocklist.ts` — exports `refreshBlocklists(env)` and `isBlocked(hostname, env)`
- `src/index.ts` — the `scheduled` handler that runs the daily job
- `src/handlers/purge.ts` — the existing retention purge (the pattern to follow)

`src/index.ts` — the `scheduled` handler as it exists today:

```ts
	async scheduled(_controller, env, _ctx) {
		const deleted = await purge(env);
		console.info(`purged ${deleted} expired links`);

		const entries = await refreshBlocklists(env);
		console.info(`refreshed ${entries} blocklist entries`);
	},
```

`src/handlers/purge.ts` in full — this is the structural exemplar for a new
maintenance handler (named export, takes `env`, returns a count):

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

`src/blocklist.ts` — the function you will call, unchanged:

```ts
export const isBlocked = async (
	hostname: string,
	env: Env,
): Promise<boolean> => {
```

Note it takes a **hostname**, not a URL, and it fails open (returns `false`) on
any error or empty KV.

Repo conventions to match:

- Tabs, double quotes, semicolons — Biome enforces; run `bun run check`.
- `Env` is an ambient global from `worker-configuration.d.ts`; never imported.
- Maintenance handlers live in `src/handlers/` and export one named function
  taking `env` and returning a count.
- Kysely query-builder style as shown above.
- Logging uses `console.info` for normal progress, `console.warn` for problems.

## Commands you will need

| Purpose   | Command                | Expected on success            |
|-----------|------------------------|--------------------------------|
| Install   | `bun install`          | exit 0                         |
| Typecheck | `bun run typecheck`    | exit 0, no output              |
| Lint      | `bun run check`        | exit 0                         |
| Build     | `bun run build`        | exit 0                         |
| Dry-run   | `bunx wrangler deploy --dry-run --outdir /tmp/mjr-dryrun` | exit 0 |

There is no test suite in this repo.

## Scope

**In scope**:

- `src/handlers/rescreen.ts` (create)
- `src/index.ts` (extend the existing `scheduled` handler only)

**Out of scope** (do NOT touch, even though they look related):

- `src/blocklist.ts` — call `isBlocked` unchanged; do not alter its signature or
  fail-open behavior.
- `src/handlers/purge.ts` — the retention purge is separate. Do not merge the two.
- `src/handlers/add.ts`, `src/handlers/edit.ts`, `src/handlers/redirect.ts` —
  write-time and read-time paths are unaffected.
- **Do NOT delete any rows.** This plan reports only. Deleting stored user links
  automatically is a product decision the maintainer has not made; see
  maintenance notes.
- Do not add a Safe Browsing call here — that would mean one API request per
  stored link per day, which burns the 10k/day free quota for no proportionate
  benefit at this scale.

## Git workflow

- Branch: `advisor/010-rescreen-stored-urls`
- One commit.
- Commit message style: capitalized imperative subject, no trailing period, no
  attribution footer.
- Do NOT push or open a PR.

## Steps

### Step 1: Create `src/handlers/rescreen.ts`

Write a handler that reads every stored link, checks its hostname against the
blocklist, and returns the keys of those that match. It must not modify the
database.

The shape to produce:

```ts
import { isBlocked } from "../blocklist";
import { getDB } from "../utils";

/**
 * Write-time checks cannot catch a domain that turns malicious after the link
 * was stored, so the daily job re-examines what is already in the table.
 * Reports only: deleting a user's link is a decision for a human.
 */
export const rescreen = async (env: Env): Promise<string[]> => {
	const rows = await getDB(env)
		.selectFrom("urls")
		.select(["key", "value"])
		.execute();

	const flagged: string[] = [];

	for (const row of rows) {
		let hostname: string;
		try {
			hostname = new URL(row.value).hostname;
		} catch {
			console.warn(`rescreen: unparseable url stored under ${row.key}`);
			continue;
		}

		if (await isBlocked(hostname, env)) flagged.push(row.key);
	}

	return flagged;
};
```

Two details that matter:

- The `try`/`catch` around `new URL(...)` — rows predating the HTTPS-only
  validator may hold values that do not parse, and an exception here would abort
  the whole cron run including the purge.
- The loop is sequential rather than `Promise.all`. `isBlocked` reads and parses
  a 183k-entry KV blob per call; firing ~131 of those concurrently would spike
  memory. Sequential is correct at this table size.

**Verify**: `bun run typecheck` → exit 0, no output.

### Step 2: Call it from the scheduled handler in `src/index.ts`

Extend the existing handler. Run the re-screen **after** `refreshBlocklists` so
it screens against the freshly fetched list, not yesterday's.

The handler should end up as:

```ts
	async scheduled(_controller, env, _ctx) {
		const deleted = await purge(env);
		console.info(`purged ${deleted} expired links`);

		const entries = await refreshBlocklists(env);
		console.info(`refreshed ${entries} blocklist entries`);

		const flagged = await rescreen(env);
		if (flagged.length > 0) {
			console.warn(
				`rescreen: ${flagged.length} stored links now blocklisted: ${flagged.join(", ")}`,
			);
		} else {
			console.info("rescreen: no stored links are blocklisted");
		}
	},
```

Add the import: `import { rescreen } from "./handlers/rescreen";`

Do not change the `purge` or `refreshBlocklists` calls.

**Verify**: `bun run typecheck` → exit 0. Then `bun run check` → exit 0.

### Step 3: Smoke test against a local Worker

Set up local state. **`--local` only — never `--remote`.**

```sh
cp -n .dev.vars.example .dev.vars || true
bun run build
bunx wrangler d1 execute mjr-sh --local --file=./schema.sql -y
bunx wrangler d1 migrations apply mjr-sh --local
bunx wrangler d1 execute mjr-sh --local --command "select name from pragma_table_info('urls')" --json
# If 'domain' is absent from that output:
bunx wrangler d1 execute mjr-sh --local -y --command "ALTER TABLE urls ADD COLUMN domain TEXT;"
```

Seed three rows directly — bypassing `/add`, which is exactly the point, since
these represent links stored before the blocklist existed:

```sh
bunx wrangler d1 execute mjr-sh --local -y --command "
INSERT INTO urls (key, value, secret, count, timestamp, domain) VALUES
 ('RSBAD1','https://bit.ly/legacy','s1',0,datetime('now'),'bit.ly'),
 ('RSOK1','https://manjaro.org/news','s2',0,datetime('now'),'manjaro.org'),
 ('RSJUNK','not-a-url','s3',0,datetime('now'),'');"
```

Start the server and run the cron:

```sh
bunx wrangler dev --port 8810 --test-scheduled > /tmp/mjr-010.log 2>&1 &
for i in $(seq 1 30); do curl -sf -o /dev/null http://127.0.0.1:8810/stats && break; sleep 1; done
curl -s "http://127.0.0.1:8810/cdn-cgi/handler/scheduled"
sleep 3
grep -n "rescreen" /tmp/mjr-010.log
```

Stop only your own server: `lsof -ti tcp:8810 | xargs -r kill`.

**Verify**: the log contains a line naming `RSBAD1` as blocklisted. It must
**not** name `RSOK1`. The unparseable `RSJUNK` row must produce the
`unparseable url` warning rather than crashing the run — confirm the
`refreshed N blocklist entries` line still appears, proving the cron completed.

### Step 4: Confirm nothing was deleted

```sh
bunx wrangler d1 execute mjr-sh --local --command "select key from urls where key like 'RS%' order by key" --json
```

**Verify**: all three of `RSBAD1`, `RSJUNK`, `RSOK1` are still present. This plan
reports; it must not delete.

## Test plan

No new automated tests. This repo has no test runner, no test files, and no
`test` script; introducing one is out of scope. Steps 3 and 4 are the
verification. Do not add a test file or test dependency.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun run typecheck` exits 0
- [ ] `bun run check` exits 0
- [ ] `src/handlers/rescreen.ts` exists and exports `rescreen`
- [ ] `grep -rn "deleteFrom" src/` matches **only** `src/handlers/purge.ts`
      (proving the re-screen deletes nothing)
- [ ] `grep -n "rescreen" src/index.ts` returns a match
- [ ] Step 3: the log names `RSBAD1` and does not name `RSOK1`
- [ ] Step 3: the unparseable row logs a warning and the cron still completes
- [ ] Step 4: all three seeded rows still exist
- [ ] `bunx wrangler deploy --dry-run --outdir /tmp/mjr-dryrun` exits 0
- [ ] `git status --porcelain` shows changes only to `src/handlers/rescreen.ts`
      and `src/index.ts`

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts in "Current state" do not match the live files.
- `RSOK1` (`manjaro.org`) is reported as blocklisted — a false positive on a core
  domain means the matching logic is wrong; shipping it would produce misleading
  alerts every day.
- The unparseable row aborts the cron run — the `try`/`catch` is missing or
  misplaced, and a single bad row would then also block the retention purge.
- You conclude flagged links should be deleted automatically. They should not,
  not in this plan. Report the idea instead.
- The re-screen takes so long the cron times out. At ~131 rows this should be
  seconds; if it is not, report the observed duration rather than adding
  concurrency.

## Maintenance notes

- **Reporting, not deleting, is deliberate.** Automatically removing a user's
  link because a third-party feed added its domain is a policy decision with
  false-positive risk. The log line gives the maintainer the keys to review; if
  automatic deletion is ever wanted, it should come with an allowlist override
  and a retention window, not as a silent behavior change here.
- Output goes to Worker logs; `[observability] enabled = true` is already set in
  `wrangler.toml`, so the lines are visible in the Cloudflare dashboard.
- The loop is sequential and loads the blocklist per row. That is fine at ~131
  rows. Past a few thousand, hoist the `Set` construction out of `isBlocked` and
  pass it in — a change to `src/blocklist.ts` that is out of scope here.
- If plan 009 landed, `/edit` is also screened at write time, so new flagged
  entries should become rare — the re-screen then mostly catches domains that
  turned bad after storage.
- A reviewer should confirm no `deleteFrom` appears in the new file.
