# Plan 006: Extract registrable domains correctly instead of taking the last two labels

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 302035d..HEAD -- src/handlers/add.ts src/utils.ts package.json`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: MED
- **Depends on**: plans/003-move-purge-to-cron.md
- **Category**: security
- **Planned at**: commit `302035d`, 2026-09-16

## Why this matters

`/add` derives a `domain` value by taking the last two labels of the hostname.
That is wrong for any multi-part public suffix. Verified behavior today:

| Submitted URL | Stored `domain` | Should be |
|---|---|---|
| `https://evil.com.co.uk/x` | `co.uk` | `evil.com.co.uk` |
| `https://evil.co.uk/x` | `co.uk` | `evil.co.uk` |
| `https://phish.github.io/x` | `github.io` | `phish.github.io` |
| `https://github.com.attacker.net/x` | `attacker.net` | correct by luck |

Two concrete consequences:

1. **Every `*.co.uk` link shares one `domain` bucket**, as does every GitHub
   Pages site. The purge allowlist and any future domain-keyed logic treat them
   as one entity.
2. If `co.uk` or `github.io` were ever added to the purge allowlist, every
   domain under that suffix would silently become permanent.

After this plan, `domain` holds the actual registrable domain (eTLD+1).

## Current state

Files involved:

- `src/handlers/add.ts` — contains the extraction (lines 51–56)
- `src/utils.ts` — where the shared helper will live
- `package.json` — gains one dependency

`src/handlers/add.ts:49-56` as it exists today:

```ts
	// int between 4 and 7
	const keyLength = Math.floor(Math.random() * 4) + 4;
	const domain = new URL(input.data.url).hostname
		.split(".")
		.reverse()
		.splice(0, 2)
		.reverse()
		.join(".");
```

That `domain` value is then used in the insert at `src/handlers/add.ts:59-68`:

```ts
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

And by the purge, which after plan 003 lives in `src/handlers/purge.ts`:

```ts
		.where((eb) =>
			eb("timestamp", "<", getCutoffDate()).and("domain", "not in", allowList),
		)
```

`src/utils.ts:1-5` as it exists today — the export pattern to follow:

```ts
import { type Generated, Kysely } from "kysely";
import { D1Dialect } from "kysely-d1";
import z from "zod";

export const keyValidator = z.string().min(3).max(6);
```

Repo conventions to match:

- Tabs, double quotes, semicolons — Biome enforces; run `bun run check`.
- Dependencies are installed with `bun add`; `bunfig.toml` enforces a 3-day
  minimum release age on new packages (supply-chain guard). A package published
  in the last three days will be refused — that is intended, not a bug.
- `Env` is ambient; never imported.
- Shared helpers live in `src/utils.ts`.

### Live data context

The production database currently holds 18 distinct `domain` values, all of them
simple two-label domains (`github.com`, `manjaro.org`, `heise.de`, …) plus
`github.io` and three `.io` domains. Recomputing them is not required by this
plan — see maintenance notes.

## Commands you will need

| Purpose   | Command                | Expected on success            |
|-----------|------------------------|--------------------------------|
| Install   | `bun install`          | exit 0                         |
| Add dep   | `bun add <pkg>`        | exit 0                         |
| Typecheck | `bun run typecheck`    | exit 0, no output              |
| Lint      | `bun run check`        | exit 0                         |
| Dry-run   | `bunx wrangler deploy --dry-run --outdir /tmp/mjr-dryrun` | exit 0 |

There is no test suite in this repo.

## Scope

**In scope** (the only files you should modify):

- `package.json` / `bun.lock` (via `bun add`)
- `src/utils.ts`
- `src/handlers/add.ts`

**Out of scope** (do NOT touch, even though they look related):

- `src/allowList.ts` — the allowlist entries are all simple eTLD+1 domains
  already and remain correct. Do not edit the array.
- Existing rows in the database — no backfill in this plan. See maintenance notes.
- `migrations/` and `schema.sql` — the `domain` column type is unchanged.
- `src/handlers/purge.ts` — it consumes `domain` but needs no change.

## Git workflow

- Branch: `advisor/006-public-suffix-domain`
- One commit is fine.
- Commit message style: capitalized imperative sentence, no trailing period.
- Do NOT push or open a PR.

## Steps

### Step 1: Add a Public Suffix List library

The correct eTLD+1 computation requires the Public Suffix List; it cannot be
derived from the hostname string alone. Install `tldts`, which bundles the list
and works in a Workers runtime (no Node built-ins required):

```sh
bun add tldts
```

**Verify**: `grep -n "tldts" package.json` → returns a match under
`dependencies`. Then `bun run typecheck` → exit 0.

If `bun add` refuses the package because of `bunfig.toml`'s
`minimumReleaseAge` guard, STOP and report — do not disable or edit that guard.

### Step 2: Add a `registrableDomain` helper to `src/utils.ts`

Add an exported function next to `keyValidator`:

```ts
import { getDomain } from "tldts";

/**
 * The registrable domain (eTLD+1) per the Public Suffix List. Taking the last
 * two labels is wrong for multi-part suffixes: `evil.co.uk` would collapse to
 * `co.uk`, putting every unrelated `.co.uk` host in one bucket.
 */
export const registrableDomain = (hostname: string): string =>
	getDomain(hostname) ?? hostname.toLowerCase();
```

The fallback to the raw lowercased hostname matters: `getDomain` returns `null`
for inputs with no known public suffix (including bare IP addresses), and
storing `null` would break the purge's `not in` comparison.

**Verify**: `bun run typecheck` → exit 0. Then check the behavior directly:

```sh
bun -e '
import { registrableDomain } from "./src/utils";
for (const h of ["evil.com.co.uk","evil.co.uk","phish.github.io","a.b.manjaro.org","github.com.attacker.net","manjaro.org"]) {
  console.log(h.padEnd(26), "->", registrableDomain(h));
}'
```

Expected output:

```
evil.com.co.uk             -> evil.com.co.uk
evil.co.uk                 -> evil.co.uk
phish.github.io            -> phish.github.io
a.b.manjaro.org            -> manjaro.org
github.com.attacker.net    -> attacker.net
manjaro.org                -> manjaro.org
```

Note `phish.github.io` → `phish.github.io`: `github.io` is itself a public
suffix, so each Pages site is its own registrable domain. That is correct and is
precisely the bug being fixed.

If the output differs, STOP — the library is not behaving as this plan assumes.

### Step 3: Use the helper in `src/handlers/add.ts`

Replace the five-line extraction with a call to the helper:

```ts
	const domain = registrableDomain(new URL(input.data.url).hostname);
```

Add `registrableDomain` to the existing import from `../utils`. The current
import line is:

```ts
import { createHash, getDB } from "../utils";
```

Leave the `keyLength` line and the insert untouched.

**Verify**: `bun run typecheck` → exit 0. Then:

```sh
grep -n "reverse()" src/handlers/add.ts
```

Expected: **no matches**. Then `bun run check` → exit 0.

### Step 4: Smoke test that stored domains are correct

Set up local state (safe: `--local` only, never `--remote`):

```sh
cp -n .dev.vars.example .dev.vars || true
bun run build
bunx wrangler d1 execute mjr-sh --local --file=./schema.sql -y
bunx wrangler d1 migrations apply mjr-sh --local
bunx wrangler dev --port 8799 > /tmp/mjr-006.log 2>&1 &
for i in $(seq 1 30); do curl -sf -o /dev/null http://127.0.0.1:8799/stats && break; sleep 1; done
```

Submit URLs that exercise the bug:

```sh
B=http://127.0.0.1:8799
curl -s -o /dev/null "$B/add?url=https://deep.sub.manjaro.org/a"
curl -s -o /dev/null "$B/add?url=https://phish.github.io/a"
curl -s -o /dev/null "$B/add?url=https://shop.example.co.uk/a"
pkill -f "wrangler dev"

bunx wrangler d1 execute mjr-sh --local --command "select value, domain from urls order by rowid" --json
```

**Verify**: the stored `domain` values are `manjaro.org`, `phish.github.io`, and
`example.co.uk` respectively. Before this change the third would have been
`co.uk` and the second `github.io`.

### Step 5: Confirm the purge allowlist still matches

The allowlist contains simple domains like `manjaro.org` and `github.com`. With
correct extraction, a link to `https://deep.sub.manjaro.org/a` still yields
`manjaro.org` and therefore stays exempt from the purge.

Using the local database from step 4:

```sh
bunx wrangler d1 execute mjr-sh --local --command "select count(*) n from urls where domain = 'manjaro.org'" --json
```

**Verify**: returns `1` — the deep subdomain URL was correctly bucketed to
`manjaro.org`, so allowlist behavior is preserved.

## Test plan

No new automated tests. This repo has no test runner, no test files, and no
`test` script; introducing one is out of scope. Steps 2, 4, and 5 are the
verification. Do not add a test file or test dependency.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun run typecheck` exits 0
- [ ] `bun run check` exits 0
- [ ] `grep -n "tldts" package.json` returns a match under dependencies
- [ ] `grep -n "registrableDomain" src/utils.ts src/handlers/add.ts` returns matches in both
- [ ] `grep -n "reverse()" src/handlers/add.ts` returns **no matches**
- [ ] Step 2's script prints exactly the six expected mappings
- [ ] Step 4 stores `manjaro.org`, `phish.github.io`, `example.co.uk`
- [ ] Step 5 returns `1`
- [ ] `bunx wrangler deploy --dry-run --outdir /tmp/mjr-dryrun` exits 0
- [ ] `git status --porcelain` shows changes only to the in-scope files (plus `bun.lock`)

## STOP conditions

Stop and report back (do not improvise) if:

- `bun add tldts` is refused by the `minimumReleaseAge` guard in `bunfig.toml`.
  Do not edit or bypass that guard — it is an intentional supply-chain control.
- `tldts` fails to bundle for the Workers runtime (`wrangler deploy --dry-run`
  errors about Node built-ins). Report the exact error. Do **not** hand-roll a
  public suffix list — an incomplete hardcoded list is worse than the current bug.
- Step 2's output differs from the expected mappings.
- The bundle size increase causes `wrangler deploy --dry-run` to fail a size
  limit — report the reported size.
- You conclude existing rows must be backfilled to make this work — they must
  not; that is deliberately deferred.

## Maintenance notes

- **No backfill is performed.** The 18 existing `domain` values were checked and
  are all already correct (simple two-label domains), so recomputation would be
  a no-op. If a backfill is ever wanted, it must recompute from the stored
  `value` column, and it should run as a one-off script, not in a request path.
- `registrableDomain` falls back to the raw hostname when `getDomain` returns
  `null` (unknown suffix, IP literal). That keeps the column non-null. A
  reviewer should confirm the fallback is present.
- This changes what goes into the `domain` column going forward, so rows created
  before and after this change may bucket differently for the same input. That
  is the intended correction.
- Plan 005's blocklist checks the full hostname and walks parent domains
  independently of this column — the two mechanisms are separate on purpose.
- If `tldts` ever becomes unmaintained, the alternative is `psl` or fetching the
  Public Suffix List into KV on the existing cron. Do not inline a partial list.
