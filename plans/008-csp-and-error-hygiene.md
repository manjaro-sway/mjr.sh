# Plan 008: Fix the landing-page DOM XSS and stop leaking internal errors

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 302035d..HEAD -- README.md src/index.ts src/handlers/add.ts package.json`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `302035d`, 2026-09-16

## Why this matters

Two separate output-hygiene problems:

**1. DOM XSS on the landing page.** The rendered landing page reads query
parameters and writes them into `innerHTML` with no encoding. Confirmed live at
`https://mjr.sh/`: the served HTML contains a script that reads
`document.location.search` and assigns an interpolated template string into
`innerHTML`. No `encodeURI`, `textContent`, or sanitizer is applied in that
block, and no Content-Security-Policy header is set on the response. A crafted
`?url=…` link executes attacker JavaScript in the `mjr.sh` origin.

This is reachable by link alone, and `/add` already produces URLs of exactly
that shape when called with `Accept: text/html`, so the pattern looks legitimate
to a victim.

**2. Internal errors returned to clients.** The router returns raw Zod error
objects and the `/add` handler returns raw exception messages, which surface
D1/SQLite internals to anyone who sends a malformed request.

After this plan, the landing page escapes interpolated values, a CSP header is
served, and error responses carry a generic message while details go to logs.

## Current state

Files involved:

- `README.md` — the source of the landing page; contains the vulnerable script
  (lines 108–125 in the current file, inside a `<details>` block)
- `src/index.ts` — returns raw Zod errors (line 22)
- `src/handlers/add.ts` — returns raw exception messages (lines 104–106)
- `public/_headers` (create) — declarative header rules for static assets

The vulnerable script in `README.md`, as it exists today:

```html
<details>
  <summary>Script</summary>
  
  <script async>
    var result = document.querySelector('#result')
    var searchParams = new URLSearchParams(document.location.search)
    var params = Object.fromEntries(searchParams);

    if (params["url"]) {
      var pre = document.querySelector(".language-sh").cloneNode(true)
      var copied = pre.querySelector(".copied")
      copied.setAttribute('data-code', params["url"])
      var content = pre.querySelector("code").querySelector("span")
      content.innerHTML = `url: <a href="${params["url"]}">${params["url"]}</a>\nedit: <a href="${params["edit"]}">${params["edit"]}</a>\nstats: <a href="${params["stats"]}">${params["stats"]}</a>`
      result.appendChild(pre);
    }
  </script>
</details>
```

`src/index.ts:21-22` as it exists today:

```ts
		const key = keyValidator.safeParse(first);
		if (!key.success) return Response.json(key.error, { status: 400 });
```

`src/handlers/add.ts:104-106` as it exists today:

```ts
	} catch (error) {
		return Response.json({ error: (error as Error).message }, { status: 400 });
	}
```

The build pipeline, from `package.json`:

```json
    "build": "bun run build:assets && bunx markdown-to-html-cli --style ./assets/style.css --output public/index.html",
    "build:assets": "rm -rf public && mkdir -p public/assets && cp assets/favicon.svg assets/style.css public/assets/",
```

`public/` is generated and gitignored — the README is the source of truth for
the page, so the XSS fix belongs in `README.md`, not in `public/index.html`.

Repo conventions to match:

- Tabs, double quotes, semicolons in TypeScript — Biome enforces; run `bun run check`.
- Error responses use `Response.json({ error: "…" }, { status: N })`.
- `console.warn` / `console.info` are the logging calls already used in this repo
  (see `src/handlers/stats.ts`).

### Verified fact about `_headers`

A `_headers` file in the assets directory **is** honored by the Workers Assets
binding. Tested in this environment with a scratch Worker: wrangler logged
`✨ Parsed 1 valid header rule` at startup, and the custom header appeared on
the asset response. No Worker-side interception is needed.

Docs: https://developers.cloudflare.com/workers/static-assets/headers/

Because `build:assets` does `rm -rf public`, the `_headers` file must be copied
in by that script — a file placed directly in `public/` would be destroyed on
the next build.

## Commands you will need

| Purpose   | Command                | Expected on success            |
|-----------|------------------------|--------------------------------|
| Install   | `bun install`          | exit 0                         |
| Build     | `bun run build`        | exit 0, writes `public/index.html` |
| Typecheck | `bun run typecheck`    | exit 0, no output              |
| Lint      | `bun run check`        | exit 0                         |
| Dry-run   | `bunx wrangler deploy --dry-run --outdir /tmp/mjr-dryrun` | exit 0 |

There is no test suite in this repo.

## Scope

**In scope** (the only files you should modify):

- `README.md` (the inline script only)
- `assets/_headers` (create)
- `package.json` (the `build:assets` script only)
- `src/index.ts`
- `src/handlers/add.ts`

**Out of scope** (do NOT touch, even though they look related):

- `public/` — entirely generated output, gitignored. Never hand-edit it.
- The rest of `README.md` — the prose, the badges, the curl examples. Only the
  `<script>` block changes.
- `src/handlers/edit.ts`, `src/handlers/stats.ts`, `src/handlers/redirect.ts` —
  their error paths already return fixed strings.
- The `markdown-to-html-cli` dependency or its configuration.
- Adding a CSP so strict it breaks the page's own inline scripts — the generated
  page contains inline scripts and inline styles; see step 3.

## Git workflow

- Branch: `advisor/008-csp-and-error-hygiene`
- One commit is fine.
- Commit message style: capitalized imperative sentence, no trailing period.
- Do NOT push or open a PR.

## Steps

### Step 1: Escape interpolated values in the landing-page script

Rewrite the script block in `README.md` so query-parameter values are never
interpolated into an HTML string unescaped. Build the nodes with DOM APIs and
assign text via `textContent`, which cannot execute markup.

The shape to produce (replacing the body of the `if (params["url"])` block):

```html
  <script async>
    var result = document.querySelector('#result')
    var searchParams = new URLSearchParams(document.location.search)
    var params = Object.fromEntries(searchParams);

    function safeLink(label, value) {
      var line = document.createElement('div')
      line.appendChild(document.createTextNode(label + ': '))
      if (/^https:\/\//.test(value || '')) {
        var anchor = document.createElement('a')
        anchor.href = value
        anchor.textContent = value
        line.appendChild(anchor)
      } else if (value) {
        line.appendChild(document.createTextNode(value))
      }
      return line
    }

    if (params["url"]) {
      var pre = document.querySelector(".language-sh").cloneNode(true)
      var copied = pre.querySelector(".copied")
      copied.setAttribute('data-code', params["url"])
      var content = pre.querySelector("code").querySelector("span")
      content.textContent = ''
      content.appendChild(safeLink('url', params["url"]))
      content.appendChild(safeLink('edit', params["edit"]))
      content.appendChild(safeLink('stats', params["stats"]))
      result.appendChild(pre);
    }
  </script>
```

Two defenses here: `textContent`/`createTextNode` never parses markup, and the
`^https://` test prevents a `javascript:` value from becoming a clickable
`href`.

**Verify**: `bun run build` → exit 0, then confirm the sink is gone:

```sh
grep -c "innerHTML" public/index.html
```

Expected: the count must not include the landing-page script. Because the
generated page also bundles a third-party clipboard library that may contain
`innerHTML`, check the specific block instead:

```sh
python3 -c "
h = open('public/index.html', encoding='utf-8', errors='replace').read()
i = h.find('safeLink')
print('safeLink present:', i > 0)
seg = h[i-200:i+1200] if i > 0 else ''
print('innerHTML in our block:', 'innerHTML' in seg)
"
```

Expected: `safeLink present: True` and `innerHTML in our block: False`.

### Step 2: Create `assets/_headers` with security headers

Create `assets/_headers` containing:

```
/*
  Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' https://img.shields.io data:; base-uri 'none'; form-action 'self' https://mjr.sh; frame-ancestors 'none'
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
```

`'unsafe-inline'` is required for `script-src` and `style-src` because the
generated page embeds inline scripts and styles — a stricter policy would break
the page. The CSP still adds real value: `base-uri 'none'`,
`frame-ancestors 'none'`, and restricted `img-src`/`form-action`. Do not remove
`'unsafe-inline'` "to be safer"; verify the page still works if you change it.

`img-src` must allow `https://img.shields.io` — the README embeds status badges
from there. `form-action` must allow `https://mjr.sh` — the page's form posts to
`https://mjr.sh/add`.

### Step 3: Copy `_headers` into the build output

`build:assets` does `rm -rf public`, so the file must be copied on every build.
Update the `build:assets` script in `package.json`:

```json
    "build:assets": "rm -rf public && mkdir -p public/assets && cp assets/favicon.svg assets/style.css public/assets/ && cp assets/_headers public/_headers",
```

**Verify**: `bun run build` → exit 0, then `ls public/_headers` → the file exists.

Then confirm wrangler parses it:

```sh
bunx wrangler dev --port 8799 > /tmp/mjr-008.log 2>&1 &
for i in $(seq 1 30); do curl -sf -o /dev/null http://127.0.0.1:8799/ && break; sleep 1; done
curl -sI http://127.0.0.1:8799/ | grep -i "content-security-policy\|x-content-type-options"
pkill -f "wrangler dev"
grep -c "valid header rule" /tmp/mjr-008.log
```

**Verify**: the `curl -sI` output shows both headers, and the log contains a
"valid header rule" line.

### Step 4: Stop returning raw validation errors in `src/index.ts`

Replace the raw Zod error response:

```ts
		const key = keyValidator.safeParse(first);
		if (!key.success) return Response.json(key.error, { status: 400 });
```

with a generic message:

```ts
		const key = keyValidator.safeParse(first);
		if (!key.success) {
			return Response.json({ error: "Invalid key" }, { status: 400 });
		}
```

**Verify**: `bun run typecheck` → exit 0.

### Step 5: Stop returning raw exception messages in `src/handlers/add.ts`

Replace:

```ts
	} catch (error) {
		return Response.json({ error: (error as Error).message }, { status: 400 });
	}
```

with a logged-but-not-returned version:

```ts
	} catch (error) {
		console.warn(`failed to store link: ${(error as Error).message}`);
		return Response.json(
			{ error: "Could not create short link" },
			{ status: 400 },
		);
	}
```

The detail still reaches the logs (observability is enabled in `wrangler.toml`),
just not the client.

Leave the `input.success` validation error at the top of the handler alone — it
describes the caller's own input (which URL rules were violated) and is useful
feedback, not an internal leak.

**Verify**: `bun run typecheck` → exit 0. Then `bun run check` → exit 0.

### Step 6: Smoke test the error responses

```sh
cp -n .dev.vars.example .dev.vars || true
bun run build
bunx wrangler d1 execute mjr-sh --local --file=./schema.sql -y
bunx wrangler d1 migrations apply mjr-sh --local
bunx wrangler dev --port 8799 > /tmp/mjr-008b.log 2>&1 &
for i in $(seq 1 30); do curl -sf -o /dev/null http://127.0.0.1:8799/stats && break; sleep 1; done
B=http://127.0.0.1:8799

echo "short key (expect 400 with generic message):"
curl -s -w ' [%{http_code}]\n' "$B/ab"

echo "valid flow still works (expect 200):"
curl -s -o /dev/null -w '%{http_code}\n' "$B/add?url=https://example.com"
pkill -f "wrangler dev"
```

**Verify**: the short-key request returns `{"error":"Invalid key"} [400]` — not a
JSON blob containing `ZodError`, `too_small`, or `minimum`. The valid flow
returns `200`.

## Test plan

No new automated tests. This repo has no test runner, no test files, and no
`test` script; introducing one is out of scope. Steps 1, 3, and 6 are the
verification. Do not add a test file or test dependency.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun run typecheck` exits 0
- [ ] `bun run check` exits 0
- [ ] `bun run build` exits 0
- [ ] Step 1's python check prints `safeLink present: True` and `innerHTML in our block: False`
- [ ] `grep -n "innerHTML" README.md` returns **no matches**
- [ ] `ls public/_headers` succeeds after a build
- [ ] `curl -sI` against a local dev server shows a `content-security-policy` header
- [ ] `grep -n "ZodError\|key.error" src/index.ts` returns **no matches**
- [ ] `grep -n "(error as Error).message" src/handlers/add.ts` appears only inside a `console.warn` call, not in a `Response.json` body
- [ ] Step 6 returns `{"error":"Invalid key"}` for `/ab`
- [ ] `git status --porcelain` shows changes only to the in-scope files

## STOP conditions

Stop and report back (do not improvise) if:

- The landing page stops rendering results after step 1 — the DOM-building code
  is wrong. Do not revert to `innerHTML`; fix the DOM code or STOP.
- Wrangler does not log a "valid header rule" line — the `_headers` file is
  malformed (it is whitespace-sensitive: the path pattern at column 0, each
  header indented by exactly two spaces).
- The CSP breaks the page (badges missing, form non-functional, console CSP
  violations). Report exactly which directive blocked what rather than deleting
  the whole header.
- You find yourself editing `public/index.html` directly — it is generated and
  gitignored; the source is `README.md`.
- Removing the raw Zod error breaks a consumer you can identify — report it; the
  `/add` input-validation error is deliberately left intact.

## Maintenance notes

- `README.md` is both documentation and the landing-page source. Anyone editing
  the script block must remember it ships to production as executable code.
- The CSP uses `'unsafe-inline'` out of necessity — the static-site generator
  emits inline scripts and styles. Eliminating that requires either a different
  generator or hashing every inline block, which is a much larger change and is
  deliberately deferred.
- `assets/_headers` is copied by `build:assets`. If that script is ever
  rewritten, the copy step must survive or the headers silently disappear —
  worth a reviewer's attention.
- The `/add` validation error still returns Zod's structured output. That is
  intentional (it tells callers which URL rule failed) but it does expose the
  validator's internal shape; if that ever matters, map it to a message list.
- Adding `Strict-Transport-Security` was considered and left out: Cloudflare
  manages HSTS at the zone level, and setting it per-asset would be both
  incomplete (it would not cover Worker responses) and easy to get wrong.
