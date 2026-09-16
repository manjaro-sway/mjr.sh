# Plan 001: Apply the same URL scheme validation to `/edit` as to `/add`

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 302035d..HEAD -- src/handlers/add.ts src/handlers/edit.ts src/utils.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `302035d`, 2026-09-16

## Why this matters

`/add` rejects anything that is not an HTTPS URL. `/edit` does not — it uses a
bare `z.url()`, which Zod v4 accepts for `javascript:`, `data:`, `file:`, and
`vbscript:` URLs. The redirect handler then serves whatever is stored via
`Response.redirect(value, 307)`, which happily emits a `javascript:` or `data:`
`Location` header.

This was verified against a running Worker: a link was created with
`https://example.com`, edited to `javascript:alert(1)`, and `GET /<key>` then
returned `307` with `Location: javascript:alert(1)`. The same worked for
`data:text/html,…` and for plain `http://`.

The practical consequence is that every link is a scheme-downgrade vector after
creation, and the creation-time HTTPS guarantee is worthless. After this plan,
both endpoints enforce exactly one validation rule, defined in one place.

## Current state

Files involved:

- `src/handlers/add.ts` — the `/add` endpoint; defines the strict validator (lines 6–17)
- `src/handlers/edit.ts` — the `/edit` endpoint; uses the weak validator (lines 5–8)
- `src/utils.ts` — shared helpers (`keyValidator`, `getDB`, `createHash`); this is where the shared validator belongs

`src/handlers/add.ts:6-17` as it exists today:

```ts
const queryValidator = z.object({
	url: z
		.url()
		.refine(
			(url) => new URL(url).protocol === "https:",
			"Only HTTPS URLs are allowed",
		)
		.refine(
			(url) => new URL(url).hostname.length > 3,
			"Length of hostname must be greater than 3",
		),
});
```

`src/handlers/edit.ts:5-8` as it exists today:

```ts
const queryValidator = z.object({
	url: z.url(),
	secret: z.uuid(),
});
```

`src/utils.ts:1-5` as it exists today — note the existing exported validator,
which is the pattern to follow:

```ts
import { type Generated, Kysely } from "kysely";
import { D1Dialect } from "kysely-d1";
import z from "zod";

export const keyValidator = z.string().min(3).max(6);
```

Repo conventions to match:

- Tabs for indentation, double quotes, semicolons. Biome enforces this; run
  `bun run check` and let it format rather than hand-formatting.
- Zod is imported as `import z from "zod";` (default import, not `import * as z`).
- Zod v4 API: it is `z.url()` and `z.uuid()`, **not** `z.string().url()` or
  `z.string().uuid()`. Do not "fix" these to the v3 spelling — v4 removed them.
- Shared values live in `src/utils.ts` and are imported as `../utils` from
  `src/handlers/*`.
- `Env` is an ambient global type generated into `worker-configuration.d.ts` by
  `wrangler types`. It is **not** imported. Do not add an `import type { Env }`.

## Commands you will need

| Purpose   | Command                | Expected on success            |
|-----------|------------------------|--------------------------------|
| Install   | `bun install`          | exit 0                         |
| Typecheck | `bun run typecheck`    | exit 0, no output              |
| Lint      | `bun run check`        | exit 0, "No fixes applied" or fixes applied |
| Dry-run   | `bunx wrangler deploy --dry-run --outdir /tmp/mjr-dryrun` | exit 0, lists bindings |

There is no test suite in this repo. Verification is by typecheck, lint, and the
manual smoke test in step 4.

## Scope

**In scope** (the only files you should modify):

- `src/utils.ts`
- `src/handlers/add.ts`
- `src/handlers/edit.ts`

**Out of scope** (do NOT touch, even though they look related):

- `src/handlers/redirect.ts` — hardening the redirect against bad schemes is a
  separate concern; this plan fixes the write path so bad values never get
  stored. Changing both at once makes the diff hard to review.
- `src/index.ts` — routing is correct; no change needed.
- The `hostname.length > 3` rule — keep it exactly as-is. It is weak, but
  changing validation semantics beyond the scheme fix is out of scope.
- Any change to the JSON response shape of either endpoint.

## Git workflow

- Branch: `advisor/001-shared-url-validator`
- One commit for the whole plan is fine; it is a single logical change.
- Commit message style — the repo uses plain imperative subjects, some with a
  `chore:` prefix. Example from `git log`: `Convert from Pages Functions to a
  standalone Worker`. Match that: a capitalized imperative sentence, no trailing
  period.
- Do NOT push or open a PR.

## Steps

### Step 1: Add the shared validator to `src/utils.ts`

Add an exported `urlValidator` next to the existing `keyValidator`, carrying the
exact refinements that `add.ts` has today. Place it immediately after
`keyValidator` so the two exported validators sit together.

The shape to produce:

```ts
export const urlValidator = z
	.url()
	.refine(
		(url) => new URL(url).protocol === "https:",
		"Only HTTPS URLs are allowed",
	)
	.refine(
		(url) => new URL(url).hostname.length > 3,
		"Length of hostname must be greater than 3",
	);
```

Do not change `keyValidator`, `getDB`, `createHash`, or the `Table`/`Database`
types.

**Verify**: `bun run typecheck` → exit 0, no output.

### Step 2: Use the shared validator in `src/handlers/add.ts`

Replace the inline `url:` schema in `queryValidator` with `urlValidator`
imported from `../utils`. The resulting declaration should be:

```ts
const queryValidator = z.object({
	url: urlValidator,
});
```

Update the existing import line so it also imports `urlValidator`. The current
import is:

```ts
import { createHash, getDB } from "../utils";
```

`z` is still needed for `z.object`, so keep the `zod` import.

**Verify**: `bun run typecheck` → exit 0, no output.

### Step 3: Use the shared validator in `src/handlers/edit.ts`

Replace `url: z.url()` with `url: urlValidator` in that file's `queryValidator`,
importing `urlValidator` from `../utils`. Leave `secret: z.uuid()` exactly as-is.

The resulting declaration should be:

```ts
const queryValidator = z.object({
	url: urlValidator,
	secret: z.uuid(),
});
```

**Verify**: `bun run typecheck` → exit 0, no output. Then `bun run check` → exit 0.

### Step 4: Smoke test both endpoints against a local Worker

This repo has no automated tests, so prove the change by exercising the running
Worker. Run these commands in order.

Set up local state (safe: `--local` only touches `.wrangler/state`, never the
production database):

```sh
cp -n .dev.vars.example .dev.vars || true
bun run build
bunx wrangler d1 execute mjr-sh --local --file=./schema.sql -y
bunx wrangler d1 migrations apply mjr-sh --local
```

Start the dev server in the background and wait for it:

```sh
bunx wrangler dev --port 8799 > /tmp/mjr-001.log 2>&1 &
for i in $(seq 1 30); do curl -sf -o /dev/null http://127.0.0.1:8799/stats && break; sleep 1; done
```

Now run the actual test:

```sh
B=http://127.0.0.1:8799
ADD=$(curl -s "$B/add?url=https://example.com")
KEY=$(echo "$ADD" | python3 -c 'import json,sys;print(json.load(sys.stdin)["key"])')
SEC=$(echo "$ADD" | python3 -c 'import json,sys;print(json.load(sys.stdin)["secret"])')

echo "edit to javascript: (expect 400)"
curl -s -o /dev/null -w '%{http_code}\n' "$B/$KEY/edit?secret=$SEC&url=javascript%3Aalert(1)"

echo "edit to data: (expect 400)"
curl -s -o /dev/null -w '%{http_code}\n' "$B/$KEY/edit?secret=$SEC&url=data%3Atext%2Fhtml%2C%3Ch1%3Ehi%3C%2Fh1%3E"

echo "edit to http: (expect 400)"
curl -s -o /dev/null -w '%{http_code}\n' "$B/$KEY/edit?secret=$SEC&url=http%3A%2F%2Finsecure.example.com"

echo "edit to valid https (expect 200)"
curl -s -o /dev/null -w '%{http_code}\n' "$B/$KEY/edit?secret=$SEC&url=https%3A%2F%2Fexample.de"

echo "redirect still works (expect 307 https://example.de/)"
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' "$B/$KEY"
```

Stop the dev server when done: `pkill -f "wrangler dev"`.

**Verify**: the three bad-scheme edits each print `400`; the valid HTTPS edit
prints `200`; the redirect prints `307 https://example.de/`.

Before this change the three bad edits returned `200` and the redirect served
the bad scheme — that difference is the proof the fix works.

## Test plan

No new automated tests. This repo has no test runner, no test files, and no
test script in `package.json`; adding a test framework is a separate concern and
is explicitly out of scope for this plan.

The step 4 smoke test is the verification. Do **not** add a test file, a test
dependency, or a `test` script.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun run typecheck` exits 0
- [ ] `bun run check` exits 0
- [ ] `grep -n "z.url()" src/handlers/` returns **no matches** (both handlers now use the shared validator)
- [ ] `grep -n "urlValidator" src/utils.ts src/handlers/add.ts src/handlers/edit.ts` returns a match in all three files
- [ ] The step 4 smoke test produces `400`, `400`, `400`, `200`, `307 https://example.de/`
- [ ] `git status --porcelain` shows changes only to `src/utils.ts`, `src/handlers/add.ts`, `src/handlers/edit.ts` (plus `plans/README.md` if you were asked to update it)

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts in "Current state" do not match the live files.
- `bun run typecheck` reports an error mentioning `Env` — that means the
  generated `worker-configuration.d.ts` is missing or stale. Run `bun run types`
  once; if the error persists, STOP.
- The smoke test's `/add` call returns a non-200, meaning local D1 was not set up
  correctly. Re-run the setup block once; if it still fails, STOP.
- You conclude the fix requires changing `src/handlers/redirect.ts` — it does
  not, and that file is out of scope.
- Zod rejects `z.url()` or `z.uuid()` as unknown — that would mean the installed
  Zod is v3, not v4, and this plan's assumption is wrong. STOP.

## Maintenance notes

- `urlValidator` is now the single definition of "a URL this service will
  store". Any future rule (blocklist checks, length caps, punycode handling)
  belongs there, not in a handler.
- Plan 004 (Safe Browsing) and plan 005 (blocklist) both extend URL validation.
  They are written to build on this shared validator, so this plan must land
  first.
- A reviewer should check that `edit.ts` still validates `secret` with
  `z.uuid()` — dropping it would let arbitrary strings reach the hash comparison.
- Deliberately not addressed here: existing rows in the production database may
  already contain non-HTTPS values stored before this fix. Auditing and cleaning
  those is not covered by any plan — see "Known gaps" in `plans/README.md`.
