# Plan 009: Apply the blocklist and Safe Browsing checks to `/edit`

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 0985651..HEAD -- src/handlers/edit.ts src/handlers/add.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (004 and 005 already landed on `main`)
- **Category**: security
- **Planned at**: commit `0985651`, 2026-09-16

## Why this matters

`/add` now rejects URLs that are blocklisted or flagged by Google Safe Browsing.
`/edit` does not. Anyone holding a link's edit secret — which is handed to
whoever created it — can create a link pointing at something harmless, let it
pass both checks, then edit it to a malicious destination. The redirect then
serves that destination forever.

This is the same class of bypass that plan 001 closed for URL schemes: creation
was validated, editing was not. After this plan both endpoints enforce the same
three gates (scheme, blocklist, reputation).

## Current state

Files involved:

- `src/handlers/edit.ts` — the `/edit` endpoint; currently has no reputation checks
- `src/handlers/add.ts` — the `/add` endpoint; contains the exemplar to copy
- `src/blocklist.ts` — exports `isBlocked(hostname, env)` (no change needed)
- `src/safeBrowsing.ts` — exports `checkUrl(url, env)` (no change needed)

`src/handlers/edit.ts` in full as it exists today:

```ts
import { sql } from "kysely";
import z from "zod";
import { createHash, getDB, urlValidator } from "../utils";

const queryValidator = z.object({
	url: urlValidator,
	secret: z.uuid(),
});

export const edit = async (
	request: Request,
	env: Env,
	key: string,
): Promise<Response> => {
	const query = queryValidator.safeParse(
		Object.fromEntries(new URL(request.url).searchParams),
	);

	if (!query.success) {
		return Response.json(query.error, { status: 400 });
	}

	const { url: value, secret } = query.data;

	const { hash } = await createHash({
		plaintextSecret: secret,
		salt: env.SALT,
	});

	const result = await getDB(env)
		.updateTable("urls")
		.where("key", "=", key)
		.where("secret", "=", hash)
		.set({ value, timestamp: sql`CURRENT_TIMESTAMP` })
		.returning(["key", "timestamp", "value"])
		.executeTakeFirst();

	if (!result) {
		return Response.json({ error: "Not found" }, { status: 404 });
	}

	const url = new URL(request.url);
	url.pathname = result.key;
	url.search = "";

	return Response.json({ url, ...result, secret });
};
```

**This is the exemplar to copy.** `src/handlers/add.ts:11-32` as it exists today
— note the order (local blocklist first, network call second) and the exact
error messages:

```ts
export const add = async (request: Request, env: Env): Promise<Response> => {
	const { searchParams } = new URL(request.url);
	const input = queryValidator.safeParse(Object.fromEntries(searchParams));

	if (!input.success) {
		return Response.json(input.error, { status: 400 });
	}

	const hostname = new URL(input.data.url).hostname;
	if (await isBlocked(hostname, env)) {
		return Response.json(
			{ error: "URL rejected: domain is blocklisted" },
			{ status: 400 },
		);
	}

	if (await checkUrl(input.data.url, env)) {
		return Response.json(
			{ error: "URL rejected by Safe Browsing" },
			{ status: 400 },
		);
	}
```

Repo conventions to match:

- Tabs, double quotes, semicolons — Biome enforces; run `bun run check`.
- `Env` is an ambient global from `worker-configuration.d.ts`; never imported.
- Both `isBlocked` and `checkUrl` **fail open**: they return `false` when the KV
  store is empty, the API key is missing, or the network call fails. Do not
  change that behavior; it is deliberate so an outage cannot break the service.
- Error responses use `Response.json({ error: "…" }, { status: N })`.

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

**In scope** (the only file you should modify):

- `src/handlers/edit.ts`

**Out of scope** (do NOT touch, even though they look related):

- `src/blocklist.ts` and `src/safeBrowsing.ts` — reuse them unchanged. Do not
  alter their signatures or their fail-open behavior.
- `src/handlers/add.ts` — it already has these checks; copy from it, don't edit it.
- `src/handlers/redirect.ts` — do not add checks at redirect time. That would put
  a KV read and a third-party API call in the hot path of every redirect.
- The `secret` validation or the hash comparison — unchanged.
- The JSON response shape on success — clients depend on it.

## Git workflow

- Branch: `advisor/009-edit-reputation-checks`
- One commit.
- Commit message style: capitalized imperative subject, no trailing period, no
  attribution footer. Example from `git log`: `Reject malicious URLs at
  submission using Google Safe Browsing`.
- Do NOT push or open a PR.

## Steps

### Step 1: Add both checks to `src/handlers/edit.ts`

Insert the checks after the query validation succeeds and **before** the
`createHash` call and the database update — a rejected URL must never reach the
database.

Keep the same order as `add.ts`: blocklist (local, instant) first, Safe Browsing
(network, 2s timeout) second, so a blocklisted domain never costs a round-trip.

Add the imports:

```ts
import { isBlocked } from "../blocklist";
import { checkUrl } from "../safeBrowsing";
```

Then, immediately after the `if (!query.success)` block and the
`const { url: value, secret } = query.data;` line:

```ts
	const hostname = new URL(value).hostname;
	if (await isBlocked(hostname, env)) {
		return Response.json(
			{ error: "URL rejected: domain is blocklisted" },
			{ status: 400 },
		);
	}

	if (await checkUrl(value, env)) {
		return Response.json(
			{ error: "URL rejected by Safe Browsing" },
			{ status: 400 },
		);
	}
```

Use the exact same error strings as `add.ts` — a caller should not be able to
tell which endpoint rejected them by the message wording.

**Verify**: `bun run typecheck` → exit 0, no output. Then `bun run check` → exit 0.

### Step 2: Smoke test against a local Worker

Set up local state. **`--local` only — never `--remote`.** The production
database holds real links.

```sh
cp -n .dev.vars.example .dev.vars || true
bun run build
bunx wrangler d1 execute mjr-sh --local --file=./schema.sql -y
bunx wrangler d1 migrations apply mjr-sh --local
```

`schema.sql` DROPs and recreates the table, so the `domain` column may be
missing afterwards if migrations report "No migrations to apply". Check and fix:

```sh
bunx wrangler d1 execute mjr-sh --local --command "select name from pragma_table_info('urls')" --json
# If 'domain' is absent:
bunx wrangler d1 execute mjr-sh --local -y --command "ALTER TABLE urls ADD COLUMN domain TEXT;"
```

Symptom of skipping this: `/add` returns 400 with `table urls has no column
named domain`.

Start the server with scheduled testing enabled (needed to populate the
blocklist KV):

```sh
bunx wrangler dev --port 8809 --test-scheduled > /tmp/mjr-009.log 2>&1 &
for i in $(seq 1 30); do curl -sf -o /dev/null http://127.0.0.1:8809/stats && break; sleep 1; done
```

Populate the blocklist, then run the test:

```sh
B=http://127.0.0.1:8809
curl -s "$B/cdn-cgi/handler/scheduled"    # fetches the blocklists into local KV

ADD=$(curl -s "$B/add?url=https://manjaro.org")
KEY=$(echo "$ADD" | python3 -c 'import json,sys;print(json.load(sys.stdin)["key"])')
SEC=$(echo "$ADD" | python3 -c 'import json,sys;print(json.load(sys.stdin)["secret"])')
echo "created $KEY"

echo -n "edit -> bit.ly (expect 400 blocklisted): "
curl -s -w ' [%{http_code}]\n' "$B/$KEY/edit?secret=$SEC&url=https%3A%2F%2Fbit.ly%2Fabc"

echo -n "edit -> foo.bit.ly (expect 400 blocklisted): "
curl -s -w ' [%{http_code}]\n' "$B/$KEY/edit?secret=$SEC&url=https%3A%2F%2Ffoo.bit.ly%2Fabc"

echo -n "edit -> legit https (expect 200): "
curl -s -o /dev/null -w '%{http_code}\n' "$B/$KEY/edit?secret=$SEC&url=https%3A%2F%2Fheise.de"

echo -n "redirect reflects the legit edit: "
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' "$B/$KEY"

echo -n "edit -> javascript: (expect 400, plan 001 still works): "
curl -s -o /dev/null -w '%{http_code}\n' "$B/$KEY/edit?secret=$SEC&url=javascript%3Aalert(1)"

echo -n "edit with wrong secret (expect 404): "
curl -s -o /dev/null -w '%{http_code}\n' "$B/$KEY/edit?secret=00000000-0000-4000-8000-000000000000&url=https%3A%2F%2Fexample.com"
```

Stop only your own server: `lsof -ti tcp:8809 | xargs -r kill`.

**Verify**: the two `bit.ly` edits return `400` with
`{"error":"URL rejected: domain is blocklisted"}`; the legit edit returns `200`;
the redirect shows `307 https://heise.de/`; the `javascript:` edit returns `400`;
the wrong-secret edit returns `404`.

The `foo.bit.ly` case matters: it proves the parent-domain walk in `isBlocked`
applies on this path too.

### Step 3: Confirm the rejected edit did not reach the database

Still using the local database from step 2:

```sh
bunx wrangler d1 execute mjr-sh --local --command "select key, value from urls where value like '%bit.ly%'" --json
```

**Verify**: returns an empty result set. If a `bit.ly` row exists, the check was
placed after the database write rather than before it — that is a bug.

## Test plan

No new automated tests. This repo has no test runner, no test files, and no
`test` script; introducing one is out of scope. Steps 2 and 3 are the
verification. Do not add a test file or test dependency.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun run typecheck` exits 0
- [ ] `bun run check` exits 0
- [ ] `grep -n "isBlocked\|checkUrl" src/handlers/edit.ts` returns matches for both
- [ ] The checks appear **before** the `createHash` call in `src/handlers/edit.ts`
      (verify by reading the file; the order is the whole point)
- [ ] Step 2: both `bit.ly` edits return `400` with the blocklisted message
- [ ] Step 2: the legit edit returns `200` and the redirect follows it
- [ ] Step 2: `javascript:` still returns `400` and a wrong secret still returns `404`
- [ ] Step 3: no `bit.ly` row exists in the database
- [ ] `bunx wrangler deploy --dry-run --outdir /tmp/mjr-dryrun` exits 0
- [ ] `git status --porcelain` shows changes only to `src/handlers/edit.ts`

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts in "Current state" do not match the live files.
- A legitimate URL (`heise.de`) is rejected — that would mean the blocklist is
  matching something it should not, and shipping it would break real edits.
- The `bit.ly` edit returns `200` even after the scheduled trigger populated KV —
  report whether `blocklist:shorteners` exists via
  `bunx wrangler kv key get --binding BLOCKLIST --local "blocklist:shorteners"`.
- You conclude `src/blocklist.ts` or `src/safeBrowsing.ts` needs changing — they
  do not; they are already used unchanged by `add.ts`.
- You are tempted to make either check fail *closed* — do not. Fail-open is a
  deliberate availability decision documented in plan 004.

## Maintenance notes

- `/add` and `/edit` now enforce the same three gates. Any future gate belongs on
  both, or better, in a shared helper — if a fourth check is ever added, extract
  the trio into one function rather than copying a third time.
- Reputation is checked at write time only, never at redirect time. A URL that
  becomes malicious *after* being stored is not caught. The daily cron is the
  natural place to re-screen stored URLs; that is plan 010.
- Both checks fail open, so during a Safe Browsing outage or an empty KV the
  edit path silently accepts everything. That is intended.
- A reviewer should confirm the checks sit before `createHash` and the database
  update, not after — a check that runs after the write is decorative.
