import { describe, expect, it } from "vitest";
import { verifyWebhookSignature } from "../src/github/webhook.js";

describe("verifyWebhookSignature", () => {
	const secret = "test-secret";

	it("returns true for valid signature", async () => {
		const payload = '{"test":"data"}';
		// Pre-computed HMAC SHA-256 of payload with secret
		const signature = "sha256=f84765f6e07f5c1f9d8b5e3f5c7d9a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8";

		// Generate the actual valid signature
		const encoder = new TextEncoder();
		const key = await crypto.subtle.importKey(
			"raw",
			encoder.encode(secret),
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["sign"],
		);
		const signatureBytes = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
		const validSignature = `sha256=${Array.from(new Uint8Array(signatureBytes))
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("")}`;

		const result = await verifyWebhookSignature(payload, validSignature, secret);
		expect(result).toBe(true);
	});

	it("returns false for invalid signature", async () => {
		const payload = '{"test":"data"}';
		const invalidSignature =
			"sha256=0000000000000000000000000000000000000000000000000000000000000000";

		const result = await verifyWebhookSignature(payload, invalidSignature, secret);
		expect(result).toBe(false);
	});

	it("returns false for missing signature", async () => {
		const payload = '{"test":"data"}';

		const result = await verifyWebhookSignature(payload, null, secret);
		expect(result).toBe(false);
	});

	it("returns false for signature without sha256 prefix", async () => {
		const payload = '{"test":"data"}';
		const signature = "invalid-format";

		const result = await verifyWebhookSignature(payload, signature, secret);
		expect(result).toBe(false);
	});

	it("returns false when payload is tampered", async () => {
		const originalPayload = '{"test":"data"}';
		const tamperedPayload = '{"test":"tampered"}';

		// Generate signature for original payload
		const encoder = new TextEncoder();
		const key = await crypto.subtle.importKey(
			"raw",
			encoder.encode(secret),
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["sign"],
		);
		const signatureBytes = await crypto.subtle.sign("HMAC", key, encoder.encode(originalPayload));
		const signature = `sha256=${Array.from(new Uint8Array(signatureBytes))
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("")}`;

		// Verify with tampered payload
		const result = await verifyWebhookSignature(tamperedPayload, signature, secret);
		expect(result).toBe(false);
	});
});
