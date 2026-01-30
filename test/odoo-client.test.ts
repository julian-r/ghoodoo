import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { OdooClient, type OdooConfig } from "../src/odoo/client.js";

const baseConfig: OdooConfig = {
	url: "https://odoo.example.com",
	database: "test_db",
	username: "bot@example.com",
	apiKey: "test_api_key",
	stages: {
		done: 5,
		inProgress: 2,
		canceled: 6,
	},
};

// Auth response that returns uid=42
const authResponse = { result: 42 };

function mockFetch(responses: Array<{ result?: unknown; error?: { message: string } }>) {
	let callIndex = 0;
	return vi.spyOn(global, "fetch").mockImplementation(async () => {
		const response = responses[callIndex++] || responses[responses.length - 1];
		return new Response(
			JSON.stringify({
				jsonrpc: "2.0",
				id: callIndex,
				...(response.error ? { error: response.error } : { result: response.result }),
			}),
			{ status: 200, headers: { "Content-Type": "application/json" } }
		);
	});
}

describe("OdooClient", () => {
	let fetchSpy: ReturnType<typeof vi.spyOn>;

	afterEach(() => {
		fetchSpy?.mockRestore();
	});

	describe("getTask", () => {
		it("returns task when found", async () => {
			const task = { id: 123, name: "Test Task", stage_id: [1, "Todo"] };
			fetchSpy = mockFetch([authResponse, { result: [task] }]);

			const client = new OdooClient(baseConfig);
			const result = await client.getTask(123);

			expect(result).toEqual(task);
		});

		it("returns null when task not found", async () => {
			fetchSpy = mockFetch([authResponse, { result: [] }]);

			const client = new OdooClient(baseConfig);
			const result = await client.getTask(999);

			expect(result).toBeNull();
		});

		it("throws on RPC error", async () => {
			fetchSpy = mockFetch([authResponse, { error: { message: "Access denied" } }]);

			const client = new OdooClient(baseConfig);

			await expect(client.getTask(123)).rejects.toThrow("Odoo RPC error: Access denied");
		});
	});

	describe("addMessage", () => {
		it("creates message directly in mail.message", async () => {
			fetchSpy = mockFetch([
				authResponse,
				{ result: [{ id: 1, name: "Note" }] }, // getNoteSubtypeId
				{ result: 1 }, // create message
			]);

			const client = new OdooClient(baseConfig);
			const result = await client.addMessage(123, "<p>Test message</p>");

			expect(result).toBe(1);
			// Third call is the create (after auth and getNoteSubtypeId)
			const callBody = JSON.parse((fetchSpy.mock.calls[2][1] as RequestInit).body as string);
			expect(callBody.params.args[3]).toBe("mail.message");
			expect(callBody.params.args[4]).toBe("create");
			expect(callBody.params.args[5][0].res_id).toBe(123);
			expect(callBody.params.args[5][0].body).toBe("<p>Test message</p>");
		});

		it("includes author_id when author resolved", async () => {
			const config: OdooConfig = {
				...baseConfig,
				defaultUserId: 10,
			};

			fetchSpy = mockFetch([
				authResponse,
				{ result: [{ id: 10, partner_id: [20, "Partner Name"] }] }, // getPartnerIdForUser
				{ result: [{ id: 1, name: "Note" }] }, // getNoteSubtypeId
				{ result: 1 }, // create message
			]);

			const client = new OdooClient(config);
			const result = await client.addMessage(123, "<p>Test message</p>");

			expect(result).toBe(1);
			// Fourth call is the create
			const callBody = JSON.parse((fetchSpy.mock.calls[3][1] as RequestInit).body as string);
			expect(callBody.params.args[5][0].author_id).toBe(20);
		});
	});

	describe("setStage", () => {
		it("sets stage by ID", async () => {
			fetchSpy = mockFetch([authResponse, { result: true }]);

			const client = new OdooClient(baseConfig);
			const result = await client.setStage(123, 5);

			expect(result).toBe(true);
			const callBody = JSON.parse((fetchSpy.mock.calls[1][1] as RequestInit).body as string);
			expect(callBody.params.args[4]).toBe("write");
			expect(callBody.params.args[5][1]).toEqual({ stage_id: 5 });
		});

		it("resolves stage by name then sets", async () => {
			fetchSpy = mockFetch([
				authResponse,
				{ result: [{ id: 5, name: "Done" }] }, // resolveStage
				{ result: true }, // write
			]);

			const client = new OdooClient(baseConfig);
			const result = await client.setStage(123, "Done");

			expect(result).toBe(true);
		});

		it("uses default done stage when no stage specified", async () => {
			fetchSpy = mockFetch([authResponse, { result: true }]);

			const client = new OdooClient(baseConfig);
			await client.setStage(123);

			const callBody = JSON.parse((fetchSpy.mock.calls[1][1] as RequestInit).body as string);
			expect(callBody.params.args[5][1]).toEqual({ stage_id: 5 }); // default done stage
		});

		it("throws when stage not found by name", async () => {
			fetchSpy = mockFetch([authResponse, { result: [] }]); // resolveStage returns empty

			const client = new OdooClient(baseConfig);

			await expect(client.setStage(123, "NonExistent")).rejects.toThrow(
				"Stage not found: NonExistent"
			);
		});
	});

	describe("getUserByEmail", () => {
		it("returns user when found", async () => {
			const user = { id: 1, login: "user@example.com", email: "user@example.com", partner_id: [10, "Partner"] };
			fetchSpy = mockFetch([authResponse, { result: [user] }]);

			const client = new OdooClient(baseConfig);
			const result = await client.getUserByEmail("user@example.com");

			expect(result).toEqual(user);
		});

		it("returns null when user not found", async () => {
			fetchSpy = mockFetch([authResponse, { result: [] }]);

			const client = new OdooClient(baseConfig);
			const result = await client.getUserByEmail("nobody@example.com");

			expect(result).toBeNull();
		});
	});

	describe("resolveAuthorPartnerId", () => {
		it("returns null when no email and no default user", async () => {
			const client = new OdooClient(baseConfig);
			const result = await client.resolveAuthorPartnerId();

			expect(result).toBeNull();
		});

		it("uses default user when no email provided", async () => {
			const config: OdooConfig = {
				...baseConfig,
				defaultUserId: 10,
			};
			fetchSpy = mockFetch([authResponse, { result: [{ id: 10, partner_id: [20, "Partner"] }] }]);

			const client = new OdooClient(config);
			const result = await client.resolveAuthorPartnerId();

			expect(result).toBe(20);
		});

		it("looks up user by email", async () => {
			const user = { id: 1, email: "user@example.com", partner_id: [10, "Partner"] };
			fetchSpy = mockFetch([authResponse, { result: [user] }]);

			const client = new OdooClient(baseConfig);
			const result = await client.resolveAuthorPartnerId("user@example.com");

			expect(result).toBe(10);
		});

		it("uses mapped email from userMapping config", async () => {
			const config: OdooConfig = {
				...baseConfig,
				userMapping: { "github@example.com": "odoo@example.com" },
			};
			const user = { id: 1, email: "odoo@example.com", partner_id: [10, "Partner"] };
			fetchSpy = mockFetch([authResponse, { result: [user] }]);

			const client = new OdooClient(config);
			const result = await client.resolveAuthorPartnerId("github@example.com");

			expect(result).toBe(10);
			// Verify it searched with mapped email (second call after auth)
			const callBody = JSON.parse((fetchSpy.mock.calls[1][1] as RequestInit).body as string);
			expect(callBody.params.args[5][0]).toContainEqual(["email", "=", "odoo@example.com"]);
		});

		it("caches partner ID lookups", async () => {
			const user = { id: 1, email: "user@example.com", partner_id: [10, "Partner"] };
			fetchSpy = mockFetch([authResponse, { result: [user] }]);

			const client = new OdooClient(baseConfig);
			await client.resolveAuthorPartnerId("user@example.com");
			await client.resolveAuthorPartnerId("user@example.com");

			expect(fetchSpy).toHaveBeenCalledTimes(2); // Auth + one lookup (second is cached)
		});

		it("falls back to default user when email lookup fails", async () => {
			const config: OdooConfig = {
				...baseConfig,
				defaultUserId: 10,
			};
			fetchSpy = mockFetch([
				authResponse,
				{ result: [] }, // getUserByEmail returns empty
				{ result: [{ id: 10, partner_id: [20, "Default Partner"] }] }, // getPartnerIdForUser
			]);

			const client = new OdooClient(config);
			const result = await client.resolveAuthorPartnerId("unknown@example.com");

			expect(result).toBe(20);
		});
	});

	describe("retry logic", () => {
		it("retries on 5xx errors", async () => {
			let callCount = 0;
			fetchSpy = vi.spyOn(global, "fetch").mockImplementation(async () => {
				callCount++;
				// First call is auth
				if (callCount === 1) {
					return new Response(
						JSON.stringify({ jsonrpc: "2.0", id: 1, result: 42 }),
						{ status: 200 }
					);
				}
				// Fail twice, then succeed
				if (callCount < 4) {
					return new Response("Server Error", { status: 500 });
				}
				return new Response(
					JSON.stringify({ jsonrpc: "2.0", id: 1, result: [{ id: 123 }] }),
					{ status: 200 }
				);
			});

			const client = new OdooClient(baseConfig);
			const result = await client.getTask(123);

			expect(result).toEqual({ id: 123 });
			expect(callCount).toBe(4); // 1 auth + 2 failures + 1 success
		}, 10000);

		it("retries on 429 rate limit", async () => {
			let callCount = 0;
			fetchSpy = vi.spyOn(global, "fetch").mockImplementation(async () => {
				callCount++;
				// First call is auth
				if (callCount === 1) {
					return new Response(
						JSON.stringify({ jsonrpc: "2.0", id: 1, result: 42 }),
						{ status: 200 }
					);
				}
				// Fail once, then succeed
				if (callCount === 2) {
					return new Response("Rate limited", { status: 429 });
				}
				return new Response(
					JSON.stringify({ jsonrpc: "2.0", id: 1, result: [{ id: 123 }] }),
					{ status: 200 }
				);
			});

			const client = new OdooClient(baseConfig);
			const result = await client.getTask(123);

			expect(result).toEqual({ id: 123 });
			expect(callCount).toBe(3); // 1 auth + 1 failure + 1 success
		}, 10000);

		it("throws after max retries", async () => {
			let callCount = 0;
			fetchSpy = vi.spyOn(global, "fetch").mockImplementation(async () => {
				callCount++;
				// First call is auth
				if (callCount === 1) {
					return new Response(
						JSON.stringify({ jsonrpc: "2.0", id: 1, result: 42 }),
						{ status: 200 }
					);
				}
				return new Response("Server Error", { status: 500 });
			});

			const client = new OdooClient(baseConfig);

			await expect(client.getTask(123)).rejects.toThrow("Odoo HTTP error: 500");
		}, 30000);
	});

	describe("stages getter", () => {
		it("returns configured stages", () => {
			const client = new OdooClient(baseConfig);
			expect(client.stages).toEqual({
				done: 5,
				inProgress: 2,
				canceled: 6,
			});
		});
	});
});
