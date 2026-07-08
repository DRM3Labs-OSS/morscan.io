// JWT via Web Crypto - HMAC-SHA256, zero deps.
// Used for UI session cookies. API keys are separate.

const ALG = { name: "HMAC", hash: "SHA-256" };
const JWT_EXPIRY_SECONDS = 86400; // 24 hours

function base64url(buf: ArrayBuffer): string {
	return btoa(String.fromCharCode(...new Uint8Array(buf)))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

function base64urlDecode(str: string): Uint8Array {
	const padded =
		str.replace(/-/g, "+").replace(/_/g, "/") + "==".slice(0, (4 - (str.length % 4)) % 4);
	const binary = atob(padded);
	return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

async function getKey(secret: string): Promise<CryptoKey> {
	const enc = new TextEncoder();
	return crypto.subtle.importKey("raw", enc.encode(secret), ALG, false, [
		"sign",
		"verify",
	]);
}

export interface JwtPayload {
	keyId: string;
	name: string;
	iat: number;
	exp: number;
}

export async function signJwt(
	payload: Omit<JwtPayload, "iat" | "exp">,
	secret: string,
): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	const full: JwtPayload = { ...payload, iat: now, exp: now + JWT_EXPIRY_SECONDS };

	const header = base64url(
		new TextEncoder().encode(JSON.stringify({ alg: "HS256", typ: "JWT" }))
			.buffer as ArrayBuffer,
	);
	const body = base64url(
		new TextEncoder().encode(JSON.stringify(full)).buffer as ArrayBuffer,
	);
	const sigInput = new TextEncoder().encode(`${header}.${body}`);

	const key = await getKey(secret);
	const sig = await crypto.subtle.sign("HMAC", key, sigInput);

	return `${header}.${body}.${base64url(sig)}`;
}

export async function verifyJwt(
	token: string,
	secret: string,
): Promise<JwtPayload | null> {
	const parts = token.split(".");
	if (parts.length !== 3) return null;

	const [header, body, sig] = parts;
	const sigInput = new TextEncoder().encode(`${header}.${body}`);

	const key = await getKey(secret);
	const sigBytes = base64urlDecode(sig);
	const valid = await crypto.subtle.verify("HMAC", key, sigBytes, sigInput);
	if (!valid) return null;

	try {
		const payload: JwtPayload = JSON.parse(
			new TextDecoder().decode(base64urlDecode(body)),
		);
		if (payload.exp < Math.floor(Date.now() / 1000)) return null;
		return payload;
	} catch {
		return null;
	}
}

export function sessionCookie(token: string): string {
	return `morscan_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${JWT_EXPIRY_SECONDS}`;
}

export function clearSessionCookie(): string {
	return "morscan_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0";
}

export function getSessionToken(request: Request): string | null {
	const cookie = request.headers.get("Cookie") || "";
	const match = cookie.match(/morscan_session=([^;]+)/);
	return match ? match[1] : null;
}
