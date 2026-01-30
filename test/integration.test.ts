import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import worker, { type Env } from "../src/index.js";

// Helper to create valid webhook signature
async function createSignature(payload: string, secret: string): Promise<string> {
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"]
	);
	const signatureBytes = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
	return `sha256=${Array.from(new Uint8Array(signatureBytes))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("")}`;
}

const testEnv: Env = {
	GITHUB_WEBHOOK_SECRET: "test-secret",
	ODOO_URL: "https://odoo.example.com",
	ODOO_DATABASE: "test_db",
	ODOO_API_KEY: "test_api_key",
	ODOO_STAGE_DONE: "5",
};

describe("Worker Integration", () => {
	let fetchSpy: ReturnType<typeof vi.spyOn>;

	// Mock Odoo responses
	function mockOdooResponses(responses: unknown[]) {
		let callIndex = 0;
		fetchSpy = vi.spyOn(global, "fetch").mockImplementation(async (url) => {
			// Only mock Odoo calls, not GitHub
			if (typeof url === "string" && url.includes("odoo.example.com")) {
				const response = responses[callIndex++] || responses[responses.length - 1];
				return new Response(
					JSON.stringify({ jsonrpc: "2.0", id: callIndex, result: response }),
					{ status: 200 }
				);
			}
			return new Response("Not mocked", { status: 500 });
		});
	}

	afterEach(() => {
		fetchSpy?.mockRestore();
	});

	describe("request validation", () => {
		it("rejects non-POST requests", async () => {
			const request = new Request("http://localhost/webhook", { method: "GET" });
			const response = await worker.fetch(request, testEnv);

			expect(response.status).toBe(405);
			expect(await response.text()).toBe("Method not allowed");
		});

		it("returns 404 for non-webhook paths", async () => {
			const request = new Request("http://localhost/other", { method: "POST" });
			const response = await worker.fetch(request, testEnv);

			expect(response.status).toBe(404);
		});

		it("rejects requests without event type header", async () => {
			const request = new Request("http://localhost/webhook", {
				method: "POST",
				body: "{}",
			});
			const response = await worker.fetch(request, testEnv);

			expect(response.status).toBe(400);
			expect(await response.text()).toBe("Missing event type");
		});

		it("rejects requests with invalid signature", async () => {
			const request = new Request("http://localhost/webhook", {
				method: "POST",
				body: "{}",
				headers: {
					"x-github-event": "push",
					"x-hub-signature-256": "sha256=invalid",
				},
			});
			const response = await worker.fetch(request, testEnv);

			expect(response.status).toBe(401);
			expect(await response.text()).toBe("Invalid signature");
		});
	});

	describe("ping event", () => {
		it("responds to ping events", async () => {
			const payload = '{"zen":"test"}';
			const signature = await createSignature(payload, "test-secret");

			const request = new Request("http://localhost/webhook", {
				method: "POST",
				body: payload,
				headers: {
					"x-github-event": "ping",
					"x-hub-signature-256": signature,
				},
			});
			const response = await worker.fetch(request, testEnv);

			expect(response.status).toBe(200);
			const json = await response.json();
			expect(json).toEqual({ status: "ok", event: "ping" });
		});
	});

	describe("push event", () => {
		it("processes push event with ODP reference", async () => {
			mockOdooResponses([
				[{ id: 123, name: "Test Task", stage_id: [1, "Todo"] }], // getTask
				1, // addMessage
			]);

			const payload = JSON.stringify({
				ref: "refs/heads/main",
				repository: {
					full_name: "owner/repo",
					html_url: "https://github.com/owner/repo",
				},
				commits: [
					{
						id: "abc1234567890",
						message: "Fix bug ODP-123",
						url: "https://github.com/owner/repo/commit/abc1234567890",
						author: { name: "Test User", email: "test@example.com" },
					},
				],
			});
			const signature = await createSignature(payload, "test-secret");

			const request = new Request("http://localhost/webhook", {
				method: "POST",
				body: payload,
				headers: {
					"x-github-event": "push",
					"x-hub-signature-256": signature,
				},
			});
			const response = await worker.fetch(request, testEnv);

			expect(response.status).toBe(200);
			const json = await response.json() as { status: string; processed: number; errors: string[] };
			expect(json.status).toBe("ok");
			expect(json.processed).toBe(1);
			expect(json.errors).toHaveLength(0);
		});

		it("reports errors for missing tasks", async () => {
			mockOdooResponses([
				[], // getTask returns empty
			]);

			const payload = JSON.stringify({
				ref: "refs/heads/main",
				repository: {
					full_name: "owner/repo",
					html_url: "https://github.com/owner/repo",
				},
				commits: [
					{
						id: "abc1234567890",
						message: "Fix bug ODP-999",
						url: "https://github.com/owner/repo/commit/abc1234567890",
						author: { name: "Test User" },
					},
				],
			});
			const signature = await createSignature(payload, "test-secret");

			const request = new Request("http://localhost/webhook", {
				method: "POST",
				body: payload,
				headers: {
					"x-github-event": "push",
					"x-hub-signature-256": signature,
				},
			});
			const response = await worker.fetch(request, testEnv);

			expect(response.status).toBe(200);
			const json = await response.json() as { processed: number; errors: string[] };
			expect(json.processed).toBe(0);
			expect(json.errors).toContain("ODP-999: Task not found");
		});
	});

	describe("pull_request event", () => {
		it("processes PR open event", async () => {
			mockOdooResponses([
				[{ id: 456, name: "Test Task", stage_id: [1, "Todo"] }], // getTask
				1, // addMessage
			]);

			const payload = JSON.stringify({
				action: "opened",
				pull_request: {
					number: 42,
					title: "Refs ODP-456",
					body: null,
					html_url: "https://github.com/owner/repo/pull/42",
					merged: false,
					user: { login: "testuser" },
				},
				repository: {
					owner: { login: "owner" },
					name: "repo",
					full_name: "owner/repo",
				},
			});
			const signature = await createSignature(payload, "test-secret");

			const request = new Request("http://localhost/webhook", {
				method: "POST",
				body: payload,
				headers: {
					"x-github-event": "pull_request",
					"x-hub-signature-256": signature,
				},
			});
			const response = await worker.fetch(request, testEnv);

			expect(response.status).toBe(200);
			const json = await response.json() as { status: string; processed: number };
			expect(json.status).toBe("ok");
			expect(json.processed).toBe(1);
		});

		it("sets done stage when PR with close keyword is merged", async () => {
			mockOdooResponses([
				[{ id: 123, name: "Test Task", stage_id: [1, "Todo"] }], // getTask
				1, // addMessage
				true, // setStage
			]);

			const payload = JSON.stringify({
				action: "closed",
				pull_request: {
					number: 42,
					title: "Closes ODP-123",
					body: null,
					html_url: "https://github.com/owner/repo/pull/42",
					merged: true,
					user: { login: "testuser" },
				},
				repository: {
					owner: { login: "owner" },
					name: "repo",
					full_name: "owner/repo",
				},
			});
			const signature = await createSignature(payload, "test-secret");

			const request = new Request("http://localhost/webhook", {
				method: "POST",
				body: payload,
				headers: {
					"x-github-event": "pull_request",
					"x-hub-signature-256": signature,
				},
			});
			const response = await worker.fetch(request, testEnv);

			expect(response.status).toBe(200);
			// Verify setStage was called (getTask, getNoteSubtype, addMessage, setStage = 4 calls)
			expect(fetchSpy).toHaveBeenCalledTimes(4);
		});
	});

	describe("unhandled events", () => {
		it("acknowledges unhandled event types", async () => {
			const payload = '{"action":"created"}';
			const signature = await createSignature(payload, "test-secret");

			const request = new Request("http://localhost/webhook", {
				method: "POST",
				body: payload,
				headers: {
					"x-github-event": "issues",
					"x-hub-signature-256": signature,
				},
			});
			const response = await worker.fetch(request, testEnv);

			expect(response.status).toBe(200);
			const json = await response.json() as { status: string; event: string; message: string };
			expect(json.status).toBe("ok");
			expect(json.event).toBe("issues");
			expect(json.message).toBe("Event type not handled");
		});
	});

	describe("error handling", () => {
		it("returns 500 on handler errors", async () => {
			const payload = "invalid json {{{";
			const signature = await createSignature(payload, "test-secret");

			const request = new Request("http://localhost/webhook", {
				method: "POST",
				body: payload,
				headers: {
					"x-github-event": "push",
					"x-hub-signature-256": signature,
				},
			});
			const response = await worker.fetch(request, testEnv);

			expect(response.status).toBe(500);
			const json = await response.json() as { status: string; message: string };
			expect(json.status).toBe("error");
		});
	});

	describe("configuration parsing", () => {
		it("parses stage IDs as numbers", async () => {
			mockOdooResponses([
				[{ id: 123, name: "Test Task", stage_id: [1, "Todo"] }],
				1, // addMessage
				true, // setStage  
			]);

			const envWithStages: Env = {
				...testEnv,
				ODOO_STAGE_DONE: "10",
				ODOO_STAGE_IN_PROGRESS: "5",
				ODOO_STAGE_CANCELED: "15",
			};

			const payload = JSON.stringify({
				action: "opened",
				pull_request: {
					number: 42,
					title: "Refs ODP-123",
					body: null,
					html_url: "https://github.com/owner/repo/pull/42",
					merged: false,
					user: { login: "testuser" },
				},
				repository: {
					owner: { login: "owner" },
					name: "repo",
					full_name: "owner/repo",
				},
			});
			const signature = await createSignature(payload, "test-secret");

			const request = new Request("http://localhost/webhook", {
				method: "POST",
				body: payload,
				headers: {
					"x-github-event": "pull_request",
					"x-hub-signature-256": signature,
				},
			});

			const response = await worker.fetch(request, envWithStages);
			expect(response.status).toBe(200);
		});

		it("parses stage names as strings", async () => {
			mockOdooResponses([
				[{ id: 123, name: "Test Task", stage_id: [1, "Todo"] }],
				1, // addMessage
				[{ id: 5, name: "In Progress" }], // resolveStage
				true, // setStage
			]);

			const envWithStageNames: Env = {
				...testEnv,
				ODOO_STAGE_DONE: "Done",
				ODOO_STAGE_IN_PROGRESS: "In Progress",
			};

			const payload = JSON.stringify({
				action: "opened",
				pull_request: {
					number: 42,
					title: "Refs ODP-123",
					body: null,
					html_url: "https://github.com/owner/repo/pull/42",
					merged: false,
					user: { login: "testuser" },
				},
				repository: {
					owner: { login: "owner" },
					name: "repo",
					full_name: "owner/repo",
				},
			});
			const signature = await createSignature(payload, "test-secret");

			const request = new Request("http://localhost/webhook", {
				method: "POST",
				body: payload,
				headers: {
					"x-github-event": "pull_request",
					"x-hub-signature-256": signature,
				},
			});

			const response = await worker.fetch(request, envWithStageNames);
			expect(response.status).toBe(200);
		});
	});
});
