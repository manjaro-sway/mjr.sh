import { sql } from "kysely";
import z from "zod";
import { checkUrl } from "../safeBrowsing";
import { createHash, getDB, urlValidator } from "../utils";

const queryValidator = z.object({
	url: urlValidator,
});

export const add = async (request: Request, env: Env): Promise<Response> => {
	const { searchParams } = new URL(request.url);
	const input = queryValidator.safeParse(Object.fromEntries(searchParams));

	if (!input.success) {
		return Response.json(input.error, { status: 400 });
	}

	if (await checkUrl(input.data.url, env)) {
		return Response.json(
			{ error: "URL rejected by Safe Browsing" },
			{ status: 400 },
		);
	}

	const db = getDB(env);

	const { hash, plaintextSecret } = await createHash({
		plaintextSecret: crypto.randomUUID(),
		salt: env.SALT,
	});
	// `substr(X, 0, n)` returns n-1 chars, so 7..9 yields keys of 6..8
	const keyLength = Math.floor(Math.random() * 3) + 7;
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
				key: sql`substr(hex(randomblob(8)), 0, ${keyLength})`,
				value: input.data.url,
				secret: hash,
				domain,
			})
			.returning(["key", "timestamp", "value"])
			.executeTakeFirstOrThrow();

		const url = new URL(request.url);
		url.pathname = result.key;
		url.search = "";

		const editUrl = new URL(request.url);
		editUrl.pathname = `${result.key}/edit`;
		editUrl.search = "";
		editUrl.searchParams.set("secret", plaintextSecret);
		editUrl.searchParams.set("url", "https://example.com");

		const statsUrl = new URL(request.url);
		statsUrl.pathname = `${result.key}/stats`;
		statsUrl.search = "";

		const values = {
			url: url.toString(),
			edit: editUrl.toString(),
			stats: statsUrl.toString(),
			...result,
			secret: plaintextSecret,
		};

		const accepts = request.headers.get("accept")?.split(",") ?? [];
		if (
			accepts.includes("text/html") &&
			!accepts.includes("application/json")
		) {
			const url = new URL(request.url);
			url.pathname = "";
			url.search = new URLSearchParams(values).toString();
			return Response.redirect(url.toString(), 302);
		}

		return Response.json(values);
	} catch (error) {
		return Response.json({ error: (error as Error).message }, { status: 400 });
	}
};
