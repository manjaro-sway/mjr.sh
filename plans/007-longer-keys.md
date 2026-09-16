# Plan 007: Widen generated short keys so the keyspace cannot be swept

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 302035d..HEAD -- src/handlers/add.ts src/utils.ts src/index.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: MED
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `302035d`, 2026-09-16

## Why this matters

Generated keys are far shorter than intended, and the short end of the range is
sweepable.

The code intends keys of length 4–7. It actually produces 3–6, because SQLite's
`substr(X, 0, n)` returns `n - 1` characters — `substr` is 1-indexed, so
starting at `0` yields one fewer character than the naive reading suggests.
Verified directly against SQLite: `substr(hex(randomblob(3)), 0, 4)` → `'741'`,
three characters.

Production data confirms it: of 128 links, **29 have 3-character keys**, 32 have
4, 35 have 5, 32 have 6.

A 3-hex-character keyspace is 4,096 values, of which 29 are occupied — a 0.71%
hit rate. At 50 requests/second a full sweep of the 3-character space completes
in about **82 seconds**; the 3- and 4-character spaces together in about 23
minutes. This was measured, not estimated: 60 random 3-character probes against
a local instance produced 1 hit, matching the predicted rate.

Consequence: the full set of shortened links is cheaply harvestable, which both
exposes links people assumed were unlisted and hands a spammer a ready-made list
of live redirects.

After this plan, newly generated keys are 6–8 characters, making the smallest
keyspace 16.7 million values instead of 4,096.

## Current state

Files involved:

- `src/handlers/add.ts` — generates the key (lines 49–50 and the insert)
- `src/utils.ts` — `keyValidator` constrains accepted key lengths on lookup
- `src/index.ts` — routes through `keyValidator`

`src/handlers/add.ts:49-68` as it exists today:

```ts
	// int between 4 and 7
	const keyLength = Math.floor(Math.random() * 4) + 4;
	const domain = new URL(input.data.url).hostname
		.split(".")
		.reverse()
		.splice(0, 2)
		.reverse()
		.join(".");

	try {
		const result = await db
			.insertInto("urls")
			.values({
				key: sql`substr(hex(randomblob(3)), 0, ${keyLength})`,
				value: input.data.url,
				secret: hash,
				domain,
			})
			.returning(["key", "timestamp", "value"])
			.executeTakeFirstOrThrow();
```

Note `randomblob(3)` produces 3 bytes → 6 hex characters, so the current code
can never produce more than 6 characters regardless of `keyLength`.

`src/utils.ts:5` as it exists today:

```ts
export const keyValidator = z.string().min(3).max(6);
```

`src/index.ts:21-22` — where that validator gates lookups:

```ts
		const key = keyValidator.safeParse(first);
		if (!key.success) return Response.json(key.error, { status: 400 });
```

**Critical constraint**: 128 existing production links have keys of length 3–6.
`keyValidator` must keep accepting those, or every existing short link breaks.
This plan widens *generation* only; it does not narrow *acceptance*.

Repo conventions to match:

- Tabs, double quotes, semicolons — Biome enforces; run `bun run check`.
- Raw SQL via the `sql` template tag imported from `kysely`.
- `Env` is ambient; never imported.

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
- `src/utils.ts`

**Out of scope** (do NOT touch, even though they look related):

- Existing rows — do **not** rewrite existing keys. Every existing short link
  must keep working; changing keys would break published URLs including the ones
  in this repo's own README.
- `keyValidator`'s **lower** bound — it must stay at `3` for existing links.
- `schema.sql` / `migrations/` — the `key` column is `CHAR(4)`, which SQLite
  does not enforce as a length limit (SQLite ignores the length in a type name);
  existing 6-character keys prove this. No migration needed.
- `src/handlers/redirect.ts`, `src/handlers/stats.ts`, `src/handlers/edit.ts`.

## Git workflow

- Branch: `advisor/007-longer-keys`
- One commit is fine.
- Commit message style: capitalized imperative sentence, no trailing period.
- Do NOT push or open a PR.

## Steps

### Step 1: Widen the generated key in `src/handlers/add.ts`

Two changes, both on the generation side:

1. `randomblob(3)` → `randomblob(8)`, so there are enough hex characters
   available (16) to slice a longer key from.
2. The length calculation must account for `substr(X, 0, n)` returning `n - 1`
   characters.

Target: keys of 6, 7, or 8 characters. Because `substr(X, 0, n)` yields `n - 1`,
the `n` values needed are 7, 8, 9.

The shape to produce, replacing the `keyLength` line and the `key:` value:

```ts
	// `substr(X, 0, n)` returns n-1 chars, so 7..9 yields keys of 6..8
	const keyLength = Math.floor(Math.random() * 3) + 7;
```

and in the insert:

```ts
				key: sql`substr(hex(randomblob(8)), 0, ${keyLength})`,
```

Replace the existing `// int between 4 and 7` comment — it describes behavior
that was never true.

**Verify**: `bun run typecheck` → exit 0. Then confirm the arithmetic against
real SQLite before touching the Worker:

```sh
python3 -c "
import sqlite3
c = sqlite3.connect(':memory:')
for n in (7, 8, 9):
    r = c.execute('select substr(hex(randomblob(8)), 0, ?)', (n,)).fetchone()[0]
    print(n, repr(r), len(r))
"
```

Expected: lengths `6`, `7`, `8` respectively.

### Step 2: Raise the upper bound of `keyValidator` in `src/utils.ts`

Lookups must accept the new longer keys. Change only the maximum:

```ts
export const keyValidator = z.string().min(3).max(8);
```

The minimum stays `3` — 29 existing production links have 3-character keys and
must keep resolving.

**Verify**: `bun run typecheck` → exit 0. Then `bun run check` → exit 0.

### Step 3: Smoke test generation and backward compatibility

Set up local state (safe: `--local` only, never `--remote`):

```sh
cp -n .dev.vars.example .dev.vars || true
bun run build
bunx wrangler d1 execute mjr-sh --local --file=./schema.sql -y
bunx wrangler d1 migrations apply mjr-sh --local
```

Seed a legacy 3-character key to prove old links still work:

```sh
bunx wrangler d1 execute mjr-sh --local -y --command "
INSERT INTO urls (key, value, secret, count, timestamp, domain)
VALUES ('ABC','https://legacy.example.com/x','s',0,datetime('now'),'legacy.example.com');"
```

Start the server and test:

```sh
bunx wrangler dev --port 8799 > /tmp/mjr-007.log 2>&1 &
for i in $(seq 1 30); do curl -sf -o /dev/null http://127.0.0.1:8799/stats && break; sleep 1; done
B=http://127.0.0.1:8799

echo "legacy 3-char key still resolves (expect 307):"
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' "$B/ABC"

echo "generate 20 new links:"
for i in $(seq 1 20); do curl -s -o /dev/null "$B/add?url=https://example$i.com"; done
pkill -f "wrangler dev"

bunx wrangler d1 execute mjr-sh --local --command "
select length(key) l, count(*) n from urls where key != 'ABC' group by 1 order by 1" --json
```

**Verify**:

- The legacy key returns `307 https://legacy.example.com/x`.
- The length histogram shows **only** lengths 6, 7, and 8 — no 3, 4, or 5.

Finally, confirm a newly generated key round-trips through the router:

```sh
bunx wrangler dev --port 8799 > /tmp/mjr-007b.log 2>&1 &
for i in $(seq 1 30); do curl -sf -o /dev/null http://127.0.0.1:8799/stats && break; sleep 1; done
ADD=$(curl -s "http://127.0.0.1:8799/add?url=https://roundtrip.example.com")
KEY=$(echo "$ADD" | python3 -c 'import json,sys;print(json.load(sys.stdin)["key"])')
echo "generated key: $KEY (length ${#KEY})"
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' "http://127.0.0.1:8799/$KEY"
pkill -f "wrangler dev"
```

**Verify**: prints a key of length 6–8 and `307 https://roundtrip.example.com/`.
This proves `keyValidator`'s new upper bound accepts what generation produces —
if step 2 were missed, this would return `400`.

## Test plan

No new automated tests. This repo has no test runner, no test files, and no
`test` script; introducing one is out of scope. Steps 1 and 3 are the
verification. Do not add a test file or test dependency.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun run typecheck` exits 0
- [ ] `bun run check` exits 0
- [ ] `grep -n "randomblob(8)" src/handlers/add.ts` returns a match
- [ ] `grep -n "randomblob(3)" src/handlers/add.ts` returns **no matches**
- [ ] `grep -n "min(3).max(8)" src/utils.ts` returns a match
- [ ] Step 1's SQLite check prints lengths 6, 7, 8
- [ ] Step 3: the legacy `ABC` key returns `307`
- [ ] Step 3: the length histogram of new keys contains only 6, 7, 8
- [ ] Step 3: a freshly generated key round-trips to `307`
- [ ] `git status --porcelain` shows changes only to `src/handlers/add.ts` and `src/utils.ts`

## STOP conditions

Stop and report back (do not improvise) if:

- The legacy 3-character key stops resolving — you have narrowed `keyValidator`'s
  minimum, which breaks 29 live links.
- The length histogram still shows keys shorter than 6 — the `substr` off-by-one
  is not fixed.
- Insert failures appear with a primary-key constraint error. With a 16.7M+
  keyspace and 128 rows, collisions are effectively impossible; a constraint
  error means something else is wrong. Do **not** add retry logic — report it.
- You conclude a database migration is needed to store longer keys — it is not;
  SQLite does not enforce `CHAR(4)` as a length limit, and 6-character keys
  already exist in production.
- You are tempted to rewrite existing keys to the new length. Never do this.

## Maintenance notes

- Existing short keys (3–6 chars) remain valid forever; `keyValidator`'s minimum
  of `3` is load-bearing for them. Anyone tempted to "tidy" that bound should
  first check the live key-length distribution.
- The sweep resistance comes from generation length, not from rate limiting, but
  the two compound: plan 002's limiter makes even the larger space slower to
  probe. Neither replaces the other.
- `hex(randomblob(8))` gives 16 hex characters, so there is headroom to raise
  key length further without another `randomblob` change.
- Keys remain uppercase hex (0-9, A-F) — 16 symbols per position. If a larger
  alphabet is ever wanted, that is a bigger change affecting `keyValidator`'s
  pattern and is out of scope here.
- A reviewer should confirm no existing key was modified: `select count(*) from
  urls where length(key) < 6` should still return 61 on production data.
