import { add } from "./handlers/add";
import { edit } from "./handlers/edit";
import { purge } from "./handlers/purge";
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
	async scheduled(_controller, env, _ctx) {
		const deleted = await purge(env);
		console.info(`purged ${deleted} expired links`);
	},
} satisfies ExportedHandler<Env>;
