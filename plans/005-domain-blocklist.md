# Plan 005: Block known-bad and nested-shortener domains from a KV-backed blocklist

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 302035d..HEAD -- src/handlers/add.ts src/index.ts wrangler.toml src/utils.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/003-move-purge-to-cron.md
- **Category**: security
- **Planned at**: commit `302035d`, 2026-09-16

## Why this matters

Safe Browsing (plan 004) catches URLs Google already knows about, and costs a
network round-trip per submission. A local domain blocklist is complementary: it
is instant, works when the network call fails open, and catches two things
Safe Browsing does not prioritize —

1. **Known-malicious domains** from community threat-intelligence feeds.
2. **Nested URL shorteners.** Shortening another shortener hides the real
   destination from every check this service performs. This is the single most
   effective abuse-laundering technique against a shortener, and blocking it is
   cheap.

After this plan, `/add` rejects submissions whose hostname appears in either
list, the lists refresh daily from upstream, and the check adds no third-party
latency to submissions.

## Current state

Files involved:

- `src/handlers/add.ts` — the `/add` endpoint; the check goes here
- `src/blocklist.ts` (create) — fetch/refresh/lookup logic
- `src/index.ts` — already gains a `scheduled` handler in plan 003; this plan
  adds the refresh to it
- `wrangler.toml` — needs a KV namespace binding

`src/handlers/add.ts:19-30` as it exists today (plan 003 removes the purge block
that currently follows; plan 004 adds a Safe Browsing call — expect the file to
differ if those landed, and work with what is actually there):

```ts
export const add = async (request: Request, env: Env): Promise<Response> => {
	const { searchParams } = new URL(request.url);
	const input = queryValidator.safeParse(Object.fromEntries(searchParams));

	if (!input.success) {
		return Response.json(input.error, { status: 400 });
	}

	const db = getDB(env);
```

The `scheduled` handler added by plan 003 in `src/index.ts` looks like:

```ts
	async scheduled(_controller, env, _ctx) {
		const deleted = await purge(env);
		console.info(`purged ${deleted} expired links`);
	},
```

Repo conventions to match:

- Tabs, double quotes, semicolons — Biome enforces; run `bun run check`.
- `Env` is an ambient global from `worker-configuration.d.ts` (`wrangler types`).
  Never import it. Re-run `bun run types` after changing bindings.
- Zod v4 for parsing external input.
- Handlers/modules export named functions; default exports are used only for the
  `allowList` array pattern in `src/allowList.ts`.

### Verified facts about the data sources

Each URL below was fetched and measured in this environment on 2026-09-16 — use
these exact URLs, not the ones you may recall:

| List | URL | Entries | Size |
|---|---|---|---|
| hagezi TIF mini | `https://raw.githubusercontent.com/hagezi/dns-blocklists/main/wildcard/tif.mini-onlydomains.txt` | 183,052 | 3.16 MB raw / 1.16 MB gzipped |
| URL shorteners | `https://raw.githubusercontent.com/PeterDaveHello/url-shorteners/master/list` | 1,454 | 13 KB |

Both files are plain text, one domain per line, with `#`-prefixed comment lines
at the top that must be skipped. hagezi is GPL-3.0; the shortener list is MIT.

**Important — paths that do NOT exist** (verified 404, do not use):
`.../main/domains/tif.mini.txt`, `.../main/domains/urlshortener.txt`.

### Why KV and not D1

Verified constraints:

- D1 free plan allows **100,000 row writes per day**. Ingesting 183,052 domains
  exceeds that in a single refresh — it cannot work on the free plan.
- KV free plan allows **1,000 writes/day** and a **25 MiB max value size**. The
  entire domain list is 3.16 MB, so it fits in **one key, one write**.

Therefore: store each list as a single newline-delimited blob in KV, read it at
request time, and parse into a `Set`.

Verified against the live production data: **zero** of the 18 domains currently
in the database appear in the hagezi list, so enabling it will not break
existing links. `goo.gl` does appear in the shortener list — correctly, it is a
shortener.

## Commands you will need

| Purpose   | Command                | Expected on success            |
|-----------|------------------------|--------------------------------|
| Install   | `bun install`          | exit 0                         |
| Regen types | `bun run types`      | exit 0                         |
| Typecheck | `bun run typecheck`    | exit 0, no output              |
| Lint      | `bun run check`        | exit 0                         |
| Dry-run   | `bunx wrangler deploy --dry-run --outdir /tmp/mjr-dryrun` | exit 0, lists KV binding |

There is no test suite in this repo.

## Scope

**In scope** (the only files you should modify):

- `src/blocklist.ts` (create)
- `src/handlers/add.ts`
- `src/index.ts`
- `wrangler.toml`
- `README.md` (document the blocklist and its sources)
- `worker-configuration.d.ts` (regenerated, not hand-edited)

**Out of scope** (do NOT touch, even though they look related):

- `src/allowList.ts` — that list controls *purge exemption*, a different
  concept. Do not merge the two or repurpose it.
- `src/handlers/redirect.ts` — do not check the blocklist at redirect time;
  existing links keep working.
- `src/handlers/edit.ts` — same reasoning as plan 004; deferred deliberately.
- Adding Phishing.Database as a third source — it lists `pastebin.com`, which is
  already used by an existing link in production. Explicitly rejected; see
  maintenance notes.

## Git workflow

- Branch: `advisor/005-domain-blocklist`
- One commit is fine.
- Commit message style: capitalized imperative sentence, no trailing period.
- Do NOT push or open a PR.

## Steps

### Step 1: Create the KV namespace and bind it

Create the namespace (this is a create-only operation against the account; it
does not modify existing data):

```sh
bunx wrangler kv namespace create BLOCKLIST
```

The command prints a binding snippet containing an `id`. Add this block to
`wrangler.toml`, substituting the printed id:

```toml
[[kv_namespaces]]
binding = "BLOCKLIST"
id = "<id printed by the create command>"
```

**Verify**: `bunx wrangler deploy --dry-run --outdir /tmp/mjr-dryrun` → exit 0,
and the binding table includes `env.BLOCKLIST   KV Namespace`.

Then `bun run types` and confirm:
`grep -n "BLOCKLIST" worker-configuration.d.ts` → returns a match.

### Step 2: Create `src/blocklist.ts`

Two responsibilities: refreshing the lists from upstream into KV (called from
the cron handler), and checking a hostname (called from `/add`).

Design requirements:

- **Fail open on read.** If KV is empty or errors, `isBlocked` returns `false`.
  A blocklist that has never been populated must not block everything.
- **Check the hostname and its parent domains.** A submission to
  `evil.example.com` must be caught by a list entry for `example.com`. Walk the
  labels from most specific to least.
- Skip `#` comment lines and blank lines when parsing.

The shape to produce:

```ts
const sources = {
	threats:
		"https://raw.githubusercontent.com/hagezi/dns-blocklists/main/wildcard/tif.mini-onlydomains.txt",
	shorteners:
		"https://raw.githubusercontent.com/PeterDaveHello/url-shorteners/master/list",
} as const;

type SourceName = keyof typeof sources;

const kvKey = (name: SourceName) => `blocklist:${name}`;

const parseList = (body: string) =>
	body
		.split("\n")
		.map((line) => line.trim().toLowerCase())
		.filter((line) => line.length > 0 && !line.startsWith("#"));

/**
 * One KV value per source: the free plan allows 1000 writes/day, and D1's
 * 100k row-writes/day cannot absorb a 183k-entry refresh at all.
 */
export const refreshBlocklists = async (env: Env): Promise<number> => {
	let total = 0;

	for (const [name, url] of Object.entries(sources) as [
		SourceName,
		string,
	][]) {
		const response = await fetch(url);
		if (!response.ok) {
			console.warn(`blocklist ${name} fetch failed: ${response.status}`);
			continue;
		}

		const entries = parseList(await response.text());
		if (entries.length === 0) {
			console.warn(`blocklist ${name} parsed empty, keeping previous value`);
			continue;
		}

		await env.BLOCKLIST.put(kvKey(name), entries.join("\n"));
		total += entries.length;
	}

	return total;
};

const loadSet = async (env: Env, name: SourceName): Promise<Set<string>> => {
	const body = await env.BLOCKLIST.get(kvKey(name));
	return new Set(body ? parseList(body) : []);
};

/**
 * Walks parent domains so a list entry for `example.com` also blocks
 * `evil.example.com`.
 */
const candidates = (hostname: string) => {
	const labels = hostname.toLowerCase().split(".");
	const result: string[] = [];

	for (let i = 0; i < labels.length - 1; i++) {
		result.push(labels.slice(i).join("."));
	}

	return result;
};

export const isBlocked = async (
	hostname: string,
	env: Env,
): Promise<boolean> => {
	try {
		const [threats, shorteners] = await Promise.all([
			loadSet(env, "threats"),
			loadSet(env, "shorteners"),
		]);

		return candidates(hostname).some(
			(candidate) => threats.has(candidate) || shorteners.has(candidate),
		);
	} catch (error) {
		console.warn(`blocklist lookup failed: ${(error as Error).message}`);
		return false;
	}
};
```

**Verify**: `bun run typecheck` → exit 0, no output.

### Step 3: Refresh the lists from the scheduled handler

In `src/index.ts`, extend the `scheduled` handler (added by plan 003) to also
refresh the blocklists. It should end up like:

```ts
	async scheduled(_controller, env, _ctx) {
		const deleted = await purge(env);
		console.info(`purged ${deleted} expired links`);

		const entries = await refreshBlocklists(env);
		console.info(`refreshed ${entries} blocklist entries`);
	},
```

Add the import: `import { refreshBlocklists } from "./blocklist";`

If plan 003 has not landed and there is no `scheduled` handler, STOP — this plan
depends on it.

**Verify**: `bun run typecheck` → exit 0.

### Step 4: Check the blocklist in `src/handlers/add.ts`

Insert the check after input validation and **before** the Safe Browsing call if
plan 004 has landed (local check first: it is free and instant, so a blocked
domain never costs a network round-trip).

The shape to produce:

```ts
	const hostname = new URL(input.data.url).hostname;
	if (await isBlocked(hostname, env)) {
		return Response.json(
			{ error: "URL rejected: domain is blocklisted" },
			{ status: 400 },
		);
	}
```

Add the import: `import { isBlocked } from "../blocklist";`

**Verify**: `bun run typecheck` → exit 0. Then `bun run check` → exit 0.

### Step 5: Document the lists in `README.md`

Add a bullet to the "Notes" section naming both sources with their URLs and
licenses (hagezi TIF mini, GPL-3.0; PeterDaveHello/url-shorteners, MIT), and
stating that submissions to listed domains are rejected and that nested
shorteners are not accepted.

Keep it to a few lines; do not restructure the README.

**Verify**: `grep -n "hagezi\|url-shorteners" README.md` → returns matches.

### Step 6: Smoke test locally

Set up local state (safe: `--local` only, never `--remote`):

```sh
bun run build
bunx wrangler d1 execute mjr-sh --local --file=./schema.sql -y
bunx wrangler d1 migrations apply mjr-sh --local
bunx wrangler dev --port 8799 --test-scheduled > /tmp/mjr-005.log 2>&1 &
for i in $(seq 1 30); do curl -sf -o /dev/null http://127.0.0.1:8799/stats && break; sleep 1; done
```

**Test A — fail open before any refresh** (KV is empty):

```sh
curl -s -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:8799/add?url=https://example.com"
```

**Verify**: prints `200`. An unpopulated blocklist must not block anything.

**Test B — populate, then check**:

```sh
curl -s "http://127.0.0.1:8799/cdn-cgi/handler/scheduled"   # or /__scheduled
B=http://127.0.0.1:8799
echo "legit domain (expect 200):"
curl -s -o /dev/null -w '%{http_code}\n' "$B/add?url=https://manjaro.org/news"
echo "nested shortener bit.ly (expect 400):"
curl -s -o /dev/null -w '%{http_code}\n' "$B/add?url=https://bit.ly/abc"
echo "subdomain of a shortener (expect 400):"
curl -s -o /dev/null -w '%{http_code}\n' "$B/add?url=https://foo.bit.ly/abc"
```

Stop the server: `pkill -f "wrangler dev"`.

**Verify**: `manjaro.org` returns `200`; both `bit.ly` cases return `400`. The
subdomain case proves the parent-domain walk works.

Confirm the refresh actually stored data:

```sh
bunx wrangler kv key get --binding BLOCKLIST --local "blocklist:shorteners" | head -5
```

**Verify**: prints domain lines, not an error.

## Test plan

No new automated tests. This repo has no test runner, no test files, and no
`test` script; introducing one is out of scope. Step 6 is the verification. Do
not add a test file or test dependency.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun run typecheck` exits 0
- [ ] `bun run check` exits 0
- [ ] `src/blocklist.ts` exists and exports both `refreshBlocklists` and `isBlocked`
- [ ] `grep -n "tif.mini-onlydomains\|url-shorteners" src/blocklist.ts` returns both URLs exactly as specified
- [ ] `grep -n "BLOCKLIST" wrangler.toml worker-configuration.d.ts` returns matches in both
- [ ] `grep -n "isBlocked" src/handlers/add.ts` returns a match
- [ ] `grep -n "refreshBlocklists" src/index.ts` returns a match
- [ ] Step 6 Test A returns `200` with an empty KV
- [ ] Step 6 Test B returns `200` / `400` / `400` as specified
- [ ] `git status --porcelain` shows changes only to the in-scope files

## STOP conditions

Stop and report back (do not improvise) if:

- Either source URL returns a non-200 — report the status. Do **not** substitute
  a different list URL you believe is equivalent; the exact lists were chosen
  after checking them against this project's live data for false positives.
- `manjaro.org` is rejected in Test B — a false positive on a core domain means
  the list or the matching logic is wrong. STOP immediately.
- Test A blocks `example.com` with an empty KV — fail-open is broken.
- A refresh appears to need more than one KV write per list, or you are tempted
  to write one KV key per domain — that would blow the 1,000 writes/day free
  limit on the first run.
- You conclude the lists belong in D1 — they do not fit the free plan's
  100k row-writes/day limit.
- Plan 003's `scheduled` handler does not exist in `src/index.ts`.

## Maintenance notes

- **Phishing.Database was deliberately rejected** as a third source: it lists
  `pastebin.com`, which an existing production link already uses. Adding it
  would break that link and require an override mechanism. Revisit only with an
  allowlist-override design.
- The KV read happens on every `/add`. At this project's volume that is well
  inside the free 100,000 reads/day. If submission volume grows, cache the
  parsed `Set` in module scope — Workers reuse isolates across requests, so a
  module-level cache with a TTL is the natural next step.
- `isBlocked` parses a 183k-entry list into a `Set` per call. That is acceptable
  for low volume but is the first thing to optimize if CPU time becomes an issue.
- Lists refresh daily via cron. If the fetch fails, the previous KV value is
  retained deliberately — a network blip must not empty the blocklist.
- `src/allowList.ts` (purge exemption) and this blocklist are separate concepts
  with confusingly similar names. A reviewer should confirm they were not merged.
- Existing links pointing at now-blocklisted domains are not retroactively
  removed. Auditing stored URLs against the blocklist is not covered by any
  plan — see "Known gaps" in `plans/README.md`.
