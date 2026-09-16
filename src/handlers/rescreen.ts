import { isBlocked } from "../blocklist";
import { getDB } from "../utils";

/**
 * Write-time checks cannot catch a domain that turns malicious after the link
 * was stored, so the daily job re-examines what is already in the table.
 * Reports only: deleting a user's link is a decision for a human.
 */
export const rescreen = async (env: Env): Promise<string[]> => {
	const rows = await getDB(env)
		.selectFrom("urls")
		.select(["key", "value"])
		.execute();

	const flagged: string[] = [];

	for (const row of rows) {
		let hostname: string;
		try {
			hostname = new URL(row.value).hostname;
		} catch {
			console.warn(`rescreen: unparseable url stored under ${row.key}`);
			continue;
		}

		if (await isBlocked(hostname, env)) flagged.push(row.key);
	}

	return flagged;
};
