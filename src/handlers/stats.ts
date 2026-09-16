import { getDB } from "../utils";

const badgeUrl = (statsUrl: string, query: string, label: string) =>
	`https://img.shields.io/badge/dynamic/json?url=${encodeURIComponent(
		statsUrl,
	)}&query=${query}&label=${label}`;

export const globalStats = async (
	request: Request,
	env: Env,
): Promise<Response> => {
	const cache = caches.default;
	const cachedResponse = await cache.match(request);

	if (cachedResponse) {
		console.info("cache hit");
		return cachedResponse;
	}

	const result = await getDB(env)
		.selectFrom("urls")
		.select(({ fn }) => [
			fn.count<number>("key").as("links"),
			fn.sum<number>("count").as("redirects"),
		])
		.executeTakeFirst();

	const statsUrl = new URL(request.url);
	statsUrl.pathname = "/stats";
	statsUrl.search = "";

	const response = Response.json(
		{
			...result,
			redirects_badge: badgeUrl(
				statsUrl.toString(),
				"%24.redirects",
				"redirects",
			),
			links_badge: badgeUrl(statsUrl.toString(), "%24.links", "links"),
		},
		{
			headers: {
				expires: new Date(Date.now() + 60 * 1000 * 10).toUTCString(),
			},
		},
	);

	await cache.put(request, response.clone());

	return response;
};

export const keyStats = async (
	request: Request,
	env: Env,
	key: string,
): Promise<Response> => {
	const cache = caches.default;
	const cachedResponse = await cache.match(request);

	if (cachedResponse) {
		console.info("cache hit");
		return cachedResponse;
	}

	const result = await getDB(env)
		.selectFrom("urls")
		.select(["count", "timestamp"])
		.where("key", "=", key)
		.executeTakeFirst();

	if (result?.count == null) {
		return Response.json({ error: "Not found" }, { status: 404 });
	}

	const statsUrl = new URL(request.url);
	statsUrl.pathname = `/${key}/stats`;
	statsUrl.search = "";

	const response = Response.json(
		{
			key,
			...result,
			badge: badgeUrl(statsUrl.toString(), "%24.count", "redirects"),
		},
		{
			headers: {
				expires: new Date(Date.now() + 60 * 1000).toUTCString(),
			},
		},
	);

	await cache.put(request, response.clone());

	return response;
};
