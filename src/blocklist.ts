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

	for (const [name, url] of Object.entries(sources) as [SourceName, string][]) {
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
