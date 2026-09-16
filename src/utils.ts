import { type Generated, Kysely } from "kysely";
import { D1Dialect } from "kysely-d1";
import z from "zod";

export const keyValidator = z.string().min(3).max(6);

export const urlValidator = z
	.url()
	.refine(
		(url) => new URL(url).protocol === "https:",
		"Only HTTPS URLs are allowed",
	)
	.refine(
		(url) => new URL(url).hostname.length > 3,
		"Length of hostname must be greater than 3",
	);

type Table = {
	key: string;
	value: string;
	count: Generated<number>;
	secret: string;
	timestamp: Generated<string>;
	domain: string;
};

interface Database {
	urls: Table;
}

export const getDB = (env: Env) => {
	return new Kysely<Database>({
		dialect: new D1Dialect({ database: env.urls }),
	});
};

const encoder = new TextEncoder();

export const createHash = async ({
	plaintextSecret,
	salt,
}: {
	plaintextSecret: string;
	salt: string;
}) => {
	const secret = await crypto.subtle.digest(
		"SHA-256",
		encoder.encode(`${plaintextSecret}${salt}`),
	);
	const hashBuffer = new Uint8Array(secret);
	const hashArray = Array.from(hashBuffer);
	const hash = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");

	return { plaintextSecret, hash };
};
