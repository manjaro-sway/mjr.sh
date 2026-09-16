/**
 * v5 `urls:search` returns protobuf only — `alt=json` is rejected. A flagged
 * URL is signalled by the presence of top-level field 1 (repeated FullHash);
 * a clean response carries only field 2 (cache duration). Reading the field
 * numbers off the wire avoids a protobuf dependency for a one-bit answer.
 */
const endpoint = "https://safebrowsing.googleapis.com/v5/urls:search";

const hasThreatField = (body: Uint8Array): boolean => {
	let i = 0;

	while (i < body.length) {
		const tag = body[i];
		if (tag === undefined) break;
		i += 1;

		const fieldNumber = tag >> 3;
		const wireType = tag & 7;

		if (wireType !== 2) return false;

		let length = 0;
		let shift = 0;
		while (i < body.length) {
			const byte = body[i];
			if (byte === undefined) return false;
			i += 1;
			length |= (byte & 0x7f) << shift;
			shift += 7;
			if ((byte & 0x80) === 0) break;
		}

		if (fieldNumber === 1) return true;
		i += length;
	}

	return false;
};

export const checkUrl = async (url: string, env: Env): Promise<boolean> => {
	const key = env.SAFE_BROWSING_API_KEY;
	if (!key) return false;

	const query = new URL(endpoint);
	query.searchParams.set("key", key);
	query.searchParams.set("urls", url);

	try {
		const response = await fetch(query, {
			signal: AbortSignal.timeout(2000),
		});
		if (!response.ok) {
			console.warn(`safe browsing lookup failed: ${response.status}`);
			return false;
		}

		return hasThreatField(new Uint8Array(await response.arrayBuffer()));
	} catch (error) {
		console.warn(`safe browsing lookup errored: ${(error as Error).message}`);
		return false;
	}
};
