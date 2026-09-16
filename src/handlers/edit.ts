import { sql } from "kysely";
import z from "zod";
import { createHash, getDB } from "../utils";

const queryValidator = z.object({
	url: z.url(),
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
