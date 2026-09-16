import allowList, { getCutoffDate } from "../allowList";
import { getDB } from "../utils";

export const purge = async (env: Env): Promise<number> => {
	const result = await getDB(env)
		.deleteFrom("urls")
		.where((eb) =>
			eb("timestamp", "<", getCutoffDate()).and("domain", "not in", allowList),
		)
		.execute();

	return Number(result[0]?.numDeletedRows ?? 0);
};
