const encoder = new TextEncoder();

export async function verifyWebhookSignature(
	payload: string,
	signature: string | null,
	secret: string,
): Promise<boolean> {
	if (!signature?.startsWith("sha256=")) {
		return false;
	}

	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);

	const signatureBytes = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));

	const expectedSignature = `sha256=${arrayToHex(new Uint8Array(signatureBytes))}`;

	return timingSafeEqual(signature, expectedSignature);
}

function arrayToHex(arr: Uint8Array): string {
	return Array.from(arr)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) {
		return false;
	}

	let result = 0;
	for (let i = 0; i < a.length; i++) {
		result |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}

	return result === 0;
}
