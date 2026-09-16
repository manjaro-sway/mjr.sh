import { refreshBlocklists } from "./blocklist";
import { add } from "./handlers/add";
import { edit } from "./handlers/edit";
import { purge } from "./handlers/purge";
import { redirect } from "./handlers/redirect";
import { rescreen } from "./handlers/rescreen";
import { globalStats, keyStats } from "./handlers/stats";
import { keyValidator } from "./utils";

const notFound = () => Response.json({ error: "Not found" }, { status: 404 });

export default {
	async fetch(request, env) {
		const { pathname } = new URL(request.url);
		const [first, second, ...rest] = pathname.split("/").filter(Boolean);

		if (rest.length > 0) return notFound();

		if (first === undefined) return notFound();
		if (first === "add" && second === undefined) {
			const clientIp = request.headers.get("CF-Connecting-IP") ?? "unknown";
			const { success } = await env.ADD_LIMITER.limit({ key: clientIp });
			if (!success) {
				return Response.json({ error: "Too many requests" }, { status: 429 });
			}
			return add(request, env);
		}
		if (first === "stats" && second === undefined)
			return globalStats(request, env);

		const key = keyValidator.safeParse(first);
		if (!key.success) {
			return Response.json({ error: "Invalid key" }, { status: 400 });
		}

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
} satisfies ExportedHandler<Env>;
