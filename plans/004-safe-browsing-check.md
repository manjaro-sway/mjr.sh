# Plan 004: Reject malicious URLs at submission using Google Safe Browsing v5

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 302035d..HEAD -- src/handlers/add.ts src/utils.ts wrangler.toml`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/001-shared-url-validator.md
- **Category**: security
- **Planned at**: commit `302035d`, 2026-09-16

## Why this matters

`/add` accepts any HTTPS URL. A shortener that will shorten anything is a
laundering service: the destination is invisible until click time, and every
malicious link created inherits `mjr.sh`'s reputation. There is currently no
reputation check of any kind.

Google Safe Browsing is the highest-signal free source available, and the v5
`urls:search` endpoint accepts a plain URL — no client-side canonicalization,
hashing, or prefix matching required.

After this plan, `/add` rejects URLs that Safe Browsing flags as malware,
social engineering, or unwanted software, with a `400` response — and, critically,
**still works normally when the API key is absent or the API is unreachable**.

## Current state

Files involved:

- `src/handlers/add.ts` — the `/add` endpoint; the check goes here
- `src/safeBrowsing.ts` (create) — the API client
- `wrangler.toml` — no change needed unless noted; the API key is a **secret**, not a var

`src/handlers/add.ts:1-30` as it exists today (note: plan 001 changes lines 6–17
to use a shared `urlValidator`; if 001 has landed, the import block will differ —
that is expected, work with what is actually in the file):

```ts
import { sql } from "kysely";
import z from "zod";
import allowList, { getCutoffDate } from "../allowList";
import { createHash, getDB } from "../utils";

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

export const add = async (request: Request, env: Env): Promise<Response> => {
	const { searchParams } = new URL(request.url);
	const input = queryValidator.safeParse(Object.fromEntries(searchParams));

	if (!input.success) {
		return Response.json(input.error, { status: 400 });
	}

	const db = getDB(env);
```

The error-response convention in this file, which your new rejection must match
(`src/handlers/add.ts:104-106`):

```ts
	} catch (error) {
		return Response.json({ error: (error as Error).message }, { status: 400 });
	}
```

Repo conventions to match:

- Tabs, double quotes, semicolons — Biome enforces; run `bun run check`.
- `Env` is an ambient global generated into `worker-configuration.d.ts` by
  `wrangler types`. Never `import type { Env }`. Secrets appear on `Env` only
  after they exist in `.dev.vars` (local) — see step 1.
- Zod v4: `z.url()`, `z.uuid()` — **not** `z.string().url()`.
- Existing secret handling pattern: `SALT` is read as `env.SALT` and declared in
  `.dev.vars.example` as `SALT="change-me"`. Follow exactly that pattern for the
  new key.
- **Never commit a real API key.** `.dev.vars` is gitignored; `.dev.vars.example`
  holds placeholders only.

### Verified facts about the Safe Browsing v5 API

These were checked against the live v5 API with a real key on 2026-09-16. They
correct an earlier assumption — read them carefully, they are counter-intuitive:

- Endpoint: `GET https://safebrowsing.googleapis.com/v5/urls:search`
- Required query parameters: `key` (API key), `urls` (the URL to check).
- **v5 `urls:search` responds with protobuf ONLY.** `Content-Type` is
  `application/x-protobuf`. There is no JSON output:
  - `?alt=json` → HTTP 400 `{"error":{"code":400,"message":"Unsupported Output
    Format","status":"INVALID_ARGUMENT"}}`
  - `?$alt=json` → same 400.
  - `Accept: application/json` header → ignored, still protobuf.
  - Note: *error* responses ARE JSON even though success responses are not, so
    probing with an invalid key gives a misleading impression. Do not conclude
    from a JSON error that success will be JSON.
- The success response is small and its wire format was decoded directly:
  - **Clean**: only top-level field 2 (cache duration). Example full body,
    5 bytes: `12 03 08 AC 02`
  - **Flagged**: top-level field 1 present (repeated `FullHash`), then field 2.
    Example for a phishing URL, 56 bytes beginning:
    `0A 31 0A 2C testsafebrowsing.appspot.com/s/phishing.html ...`
  - Therefore: **presence of top-level protobuf field number 1 means flagged.**
    No full protobuf schema or dependency is needed to make that determination.
- Auth: API key as `?key=`. The "Safe Browsing API" must be enabled in Google
  Cloud Console.
- Free quota ~10,000 queries/day; free tier is **non-commercial use only**
  (commercial use requires Google's Web Risk API). A free community service
  qualifies.

### Test URLs (verified reachable over HTTPS on 2026-09-16)

Google's older `http://malware.testing.google.test/...` is unreachable AND is
`http://`, so it cannot pass this Worker's HTTPS-only validator. Use these
instead — both return HTTP 200 and are flagged by the live API:

- `https://testsafebrowsing.appspot.com/s/phishing.html` → `SOCIAL_ENGINEERING`
- `https://testsafebrowsing.appspot.com/s/malware.html` → `MALWARE`

Confirmed clean control: `https://manjaro.org`.

## Commands you will need

| Purpose   | Command                | Expected on success            |
|-----------|------------------------|--------------------------------|
| Install   | `bun install`          | exit 0                         |
| Regen types | `bun run types`      | exit 0                         |
| Typecheck | `bun run typecheck`    | exit 0, no output              |
| Lint      | `bun run check`        | exit 0                         |
| Dry-run   | `bunx wrangler deploy --dry-run --outdir /tmp/mjr-dryrun` | exit 0 |

There is no test suite in this repo.

## Scope

**In scope** (the only files you should modify):

- `src/safeBrowsing.ts` (create)
- `src/handlers/add.ts`
- `.dev.vars.example`
- `README.md` (one line documenting the new secret, in the Development section)
- `worker-configuration.d.ts` (regenerated, not hand-edited)

**Out of scope** (do NOT touch, even though they look related):

- `src/handlers/edit.ts` — editing to a malicious URL is a real gap, but it
  needs the same check plus a decision about latency on the edit path. Deferred
  deliberately; see maintenance notes.
- `src/handlers/redirect.ts` — do not add a check at redirect time. That would
  put a third-party API call in the hot path of every redirect.
- Any caching layer for Safe Browsing responses — out of scope for this plan.
- `wrangler.toml` — the API key is a secret set via `wrangler secret put`, **not**
  a `[vars]` entry. Do not add it to `wrangler.toml`.

## Git workflow

- Branch: `advisor/004-safe-browsing-check`
- One commit is fine.
- Commit message style: capitalized imperative sentence, no trailing period.
  Example from `git log`: `Convert from Pages Functions to a standalone Worker`.
- Do NOT push or open a PR.

## Steps

### Step 1: Declare the secret for local development

Add a placeholder line to `.dev.vars.example`. The file currently contains:

```
SALT="change-me"
```

Add a second line so it reads:

```
SALT="change-me"
SAFE_BROWSING_API_KEY=""
```

Then ensure your local `.dev.vars` has the same key present (empty is fine and is
the case this plan explicitly supports):

```sh
cp -n .dev.vars.example .dev.vars || true
grep -q SAFE_BROWSING_API_KEY .dev.vars || printf 'SAFE_BROWSING_API_KEY=""\n' >> .dev.vars
bun run types
```

**Verify**: `grep -n "SAFE_BROWSING_API_KEY" worker-configuration.d.ts` → returns
a match.

**Never put a real key in `.dev.vars.example`** — it is committed.

### Step 2: Create `src/safeBrowsing.ts`

Write a client with one exported function. The critical design requirement:
**fail open**. If the key is missing, the API errors, or the request times out,
the function returns "not flagged" and the submission proceeds. A community
shortener must not go down because Google is unreachable.

The shape to produce:

```ts
/**
 * v5 `urls:search` returns protobuf only — `alt=json` is rejected. A flagged
 * URL is signalled by the presence of top-level field 1 (repeated FullHash);
 * a clean response carries only field 2 (cache duration). Reading the field
 * numbers off the wire avoids a protobuf dependency for a one-bit answer.
 */
const endpoint = "https://safebrowsing.googleapis.com/v5/urls:search";

const hasThreatField = (body: Uint8Array): boolean => {
	let i = 0;

	while (i < body.length) {
		const tag = body[i];
		if (tag === undefined) break;
		i += 1;

		const fieldNumber = tag >> 3;
		const wireType = tag & 7;

		if (wireType !== 2) return false;

		let length = 0;
		let shift = 0;
		while (i < body.length) {
			const byte = body[i];
			if (byte === undefined) return false;
			i += 1;
			length |= (byte & 0x7f) << shift;
			shift += 7;
			if ((byte & 0x80) === 0) break;
		}

		if (fieldNumber === 1) return true;
		i += length;
	}

	return false;
};

export const checkUrl = async (url: string, env: Env): Promise<boolean> => {
	const key = env.SAFE_BROWSING_API_KEY;
	if (!key) return false;

	const query = new URL(endpoint);
	query.searchParams.set("key", key);
	query.searchParams.set("urls", url);

	try {
		const response = await fetch(query, {
			signal: AbortSignal.timeout(2000),
		});
		if (!response.ok) {
			console.warn(`safe browsing lookup failed: ${response.status}`);
			return false;
		}

		return hasThreatField(new Uint8Array(await response.arrayBuffer()));
	} catch (error) {
		console.warn(`safe browsing lookup errored: ${(error as Error).message}`);
		return false;
	}
};
```

`checkUrl` returns a plain boolean — `true` means flagged. Zod is not used here
because the response is binary, not JSON.

Note the 2-second timeout: this call sits inline in a user request, so it must
be bounded.

**Verify**: `bun run typecheck` → exit 0, no output.

### Step 3: Verify the API contract directly (before wiring it in)

This step proves the endpoint shape without needing the Worker. It requires a
real API key. If you do not have one, skip this step and say so explicitly in
your report — do not fabricate a result.

```sh
# Replace $KEY with a real key; do NOT write the key into any file.
# Clean URL — expect a 5-byte protobuf body: 12 03 08 AC 02
curl -s "https://safebrowsing.googleapis.com/v5/urls:search?key=$KEY&urls=https%3A%2F%2Fmanjaro.org" \
  -o /tmp/sb-clean.bin -w 'http=%{http_code} type=%{content_type} size=%{size_download}\n'
python3 -c "print(open('/tmp/sb-clean.bin','rb').read())"

# Known phishing URL — expect a ~56-byte body that STARTS with byte 0x0A (field 1)
curl -s "https://safebrowsing.googleapis.com/v5/urls:search?key=$KEY&urls=https%3A%2F%2Ftestsafebrowsing.appspot.com%2Fs%2Fphishing.html" \
  -o /tmp/sb-bad.bin -w 'http=%{http_code} type=%{content_type} size=%{size_download}\n'
python3 -c "print(open('/tmp/sb-bad.bin','rb').read())"
```

**Verify**: both return HTTP 200 with `content_type=application/x-protobuf`.
The clean body is 5 bytes and its first byte is `0x12` (field 2). The flagged
body is larger and its first byte is `0x0A` (field 1) — that first-byte
difference is exactly what `hasThreatField` keys on.

If you have no key, skip this step and say so explicitly in your report — do
not fabricate a result. Note that querying with an INVALID key returns a JSON
error body; that is the error renderer, not the success format, and must not be
taken as evidence that JSON output works.

### Step 4: Wire the check into `src/handlers/add.ts`

Insert the check immediately after input validation succeeds and **before** any
database work. Reject flagged URLs with a `400` matching the file's existing
error shape.

The shape to produce — inserted right after the `if (!input.success)` block:

```ts
	if (await checkUrl(input.data.url, env)) {
		return Response.json(
			{ error: "URL rejected by Safe Browsing" },
			{ status: 400 },
		);
	}
```

Add the import: `import { checkUrl } from "../safeBrowsing";`

Do not change anything else in the handler.

**Verify**: `bun run typecheck` → exit 0. Then `bun run check` → exit 0.

### Step 5: Document the secret in `README.md`

In the "Development" section, the README currently says:

```
The `SALT` secret has to exist in production as well:

```sh
bunx wrangler secret put SALT
bunx wrangler d1 migrations apply urls --remote
```
```

Extend that so both secrets are documented. Add a sentence noting that
`SAFE_BROWSING_API_KEY` is optional and that submissions are accepted unchecked
when it is absent, plus the `wrangler secret put SAFE_BROWSING_API_KEY` command.

Keep the change small — a few lines. Do not restructure the README.

**Verify**: `grep -n "SAFE_BROWSING_API_KEY" README.md` → returns a match.

### Step 6: Smoke test with and without a key

Set up local state (safe: `--local` only; never `--remote`):

```sh
bun run build
bunx wrangler d1 execute mjr-sh --local --file=./schema.sql -y
bunx wrangler d1 migrations apply mjr-sh --local
bunx wrangler dev --port 8799 > /tmp/mjr-004.log 2>&1 &
for i in $(seq 1 30); do curl -sf -o /dev/null http://127.0.0.1:8799/stats && break; sleep 1; done
```

**Test A — fail-open with no key** (this is the important one; `.dev.vars` has
`SAFE_BROWSING_API_KEY=""` from step 1):

```sh
curl -s -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:8799/add?url=https://example.com"
```

**Verify**: prints `200`. A missing key must never break submissions.

**Test B — flagged URL rejected** (requires a real key). Put the real key in
`.dev.vars` (gitignored), restart `wrangler dev`, then:

```sh
curl -s "http://127.0.0.1:8799/add?url=https://example.com"
```

Expected `200` (example.com is clean). Safe Browsing's published test URL is
`http://` and cannot pass this Worker's HTTPS-only validator, so an end-to-end
flagged test through `/add` may not be possible. If you cannot find a flagged
HTTPS URL, verify the rejection path by temporarily pointing `endpoint` in
`src/safeBrowsing.ts` at a local stub that returns a flagged body, confirm the
`400`, then **revert that edit**. Report exactly what you did.

Stop the server: `pkill -f "wrangler dev"`.

**Verify**: Test A prints `200`. Report Test B's outcome honestly, including if
it could not be fully exercised.

## Test plan

No new automated tests. This repo has no test runner, no test files, and no
`test` script; introducing one is out of scope. Steps 3 and 6 are the
verification. Do not add a test file or test dependency.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun run typecheck` exits 0
- [ ] `bun run check` exits 0
- [ ] `src/safeBrowsing.ts` exists and exports `checkUrl`
- [ ] `grep -n "arrayBuffer\|hasThreatField" src/safeBrowsing.ts` returns matches (binary parsing, not JSON)
- [ ] `grep -n "alt" src/safeBrowsing.ts` returns **no matches** setting `alt=json` — v5 rejects it
- [ ] `grep -n "checkUrl" src/handlers/add.ts` returns a match
- [ ] `grep -n "SAFE_BROWSING_API_KEY" .dev.vars.example README.md worker-configuration.d.ts` returns a match in all three
- [ ] `grep -rn "AIza" . --exclude-dir=node_modules --exclude-dir=.git` returns **no matches** (no API key committed anywhere)
- [ ] Step 6 Test A prints `200` with an empty key
- [ ] `git status --porcelain` shows changes only to the in-scope files
- [ ] `.dev.vars` is NOT in `git status` output (it is gitignored)

## STOP conditions

Stop and report back (do not improvise) if:

- The v5 `urls:search` endpoint returns `404` or `NOT_FOUND` for a valid key —
  the API may have changed. Do not silently switch to `hashes:search` (it
  requires canonicalization and prefix matching, which is a different plan).
  Note a working fallback exists if needed: v4 `POST
  https://safebrowsing.googleapis.com/v4/threatMatches:find?key=...` still
  responds with JSON and was verified working with this project's key on
  2026-09-16 — but v4 is deprecated, so raise it rather than switching silently.
- A clean URL and a flagged URL produce responses whose first byte is the same —
  the field-presence heuristic is then invalid. Report the exact bytes for both;
  do not add a protobuf library.
- The response `content_type` is NOT `application/x-protobuf` — the API changed
  shape since this plan was written. Report what you got.
- Test A returns anything other than `200` — fail-open is broken, which is worse
  than having no check at all.
- You find yourself adding the API key to `wrangler.toml`, `.dev.vars.example`,
  or any committed file with a real value.
- Implementing this appears to require modifying `src/handlers/redirect.ts`.

## Maintenance notes

- **Fail-open is a deliberate choice.** An outage at Google must not take down
  link creation for a community service. The tradeoff: during an outage,
  malicious URLs pass. If the project later prefers fail-closed, that is a
  one-line change in `checkUrl` plus a conscious availability decision.
- `/edit` is deliberately unchecked by this plan, which means a link can be
  created clean and edited to a flagged destination. Plan 001 closes the scheme
  hole on that path; extending the Safe Browsing check to `/edit` is a sensible
  follow-up and should reuse `checkUrl` unchanged.
- The free Safe Browsing API is non-commercial-use only. If `mjr.sh` ever
  becomes revenue-generating, this must move to Google's Web Risk API.
- No caching is implemented. At this project's volume the quota is not a
  concern, but if submission volume grows, cache verdicts by URL (Google returns
  a `cacheDuration` on the hashes endpoint) before raising the quota.
- A reviewer should verify the 2-second timeout is present — an unbounded
  third-party call inline in a request is a latency risk.
- Plan 005 adds a static blocklist that runs before this network call. Their
  order matters for latency: local list first, network second.
