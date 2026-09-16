import { sql } from "kysely";
import { getDB } from "../utils";

export const redirect = async (env: Env, key: string): Promise<Response> => {
	const db = getDB(env);

	const result = await db
		.selectFrom("urls")
		.select(["value"])
		.where("key", "=", key)
		.executeTakeFirst();

	if (!result?.value) {
		return Response.json({ error: "Not found" }, { status: 404 });
	}

	await db
		.updateTable("urls")
		.where("key", "=", key)
		.set({ count: sql`count + 1` })
		.execute();

	return Response.redirect(result.value, 307);
};
