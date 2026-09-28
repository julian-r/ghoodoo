import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Env, type GitHubEventMessage, handleQueue, handleWebhook } from "../src/index.js";

const worker = { fetch: handleWebhook, queue: handleQueue };

async function createSignature(payload: string, secret: string): Promise<string> {
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signatureBytes = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
	return `sha256=${Array.from(new Uint8Array(signatureBytes))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("")}`;
}

const queueSend = vi.fn(async (_message: unknown) => undefined);
const queueBinding = {
	send: queueSend,
	sendBatch: vi.fn(async () => undefined),
} as unknown as Queue;

const testEnv: Env = {
	GITHUB_EVENTS_QUEUE: queueBinding,
	GITHUB_WEBHOOK_SECRET: "test-secret",
	ODOO_URL: "https://odoo.example.com",
	ODOO_DATABASE: "test_db",
	ODOO_USERNAME: "bot@example.com",
	ODOO_API_KEY: "test_api_key",
	ODOO_STAGE_DONE: "5",
};

const pushEvent = {
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
};

const pullRequestEvent = {
	action: "opened",
	pull_request: {
		number: 42,
		title: "Refs ODP-123",
		body: null,
		html_url: "https://github.com/owner/repo/pull/42",
		merged: false,
		draft: false,
		created_at: "2026-01-01T10:00:00Z",
		updated_at: "2026-01-01T10:00:00Z",
		closed_at: null,
		merged_at: null,
		user: { login: "testuser" },
	},
	repository: {
		owner: { login: "owner" },
		name: "repo",
		full_name: "owner/repo",
	},
};

async function webhookRequest(eventType: string, body: string): Promise<Request> {
	return new Request("http://localhost/webhook", {
		method: "POST",
		body,
		headers: {
			"x-github-event": eventType,
			"x-github-delivery": "delivery-123",
			"x-hub-signature-256": await createSignature(body, "test-secret"),
		},
	});
}

function mockOdooResponses(responses: unknown[]): ReturnType<typeof vi.spyOn> {
	let callIndex = 0;
	return vi.spyOn(global, "fetch").mockImplementation(async (url) => {
		if (typeof url === "string" && url.includes("odoo.example.com")) {
			const response = responses[callIndex++] ?? responses.at(-1);
			return Response.json({ jsonrpc: "2.0", id: callIndex, result: response });
		}
		return new Response("Not mocked", { status: 500 });
	});
}

function queueBatch(body: GitHubEventMessage, attempts = 1) {
	const ack = vi.fn();
	const retry = vi.fn();
	const message: Message<GitHubEventMessage> = {
		id: "queue-message-1",
		timestamp: new Date(),
		body,
		attempts,
		ack,
		retry,
	};
	const batch: MessageBatch<GitHubEventMessage> = {
		queue: "ghoodoo-events",
		messages: [message],
		metadata: {
			metrics: { backlogCount: 1, backlogBytes: 1 },
		},
		ackAll: vi.fn(),
		retryAll: vi.fn(),
	};
	return { batch, ack, retry };
}

describe("Worker integration", () => {
	beforeEach(() => {
		queueSend.mockReset();
		queueSend.mockResolvedValue(undefined);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("webhook producer", () => {
		it("rejects non-POST requests", async () => {
			const response = await worker.fetch(
				new Request("http://localhost/webhook", { method: "GET" }),
				testEnv,
			);
			expect(response.status).toBe(405);
			expect(await response.text()).toBe("Method not allowed");
		});

		it("returns 404 for non-webhook paths", async () => {
			const response = await worker.fetch(
				new Request("http://localhost/other", { method: "POST" }),
				testEnv,
			);
			expect(response.status).toBe(404);
		});

		it("rejects requests without an event type", async () => {
			const response = await worker.fetch(
				new Request("http://localhost/webhook", { method: "POST", body: "{}" }),
				testEnv,
			);
			expect(response.status).toBe(400);
			expect(await response.text()).toBe("Missing event type");
		});

		it("rejects invalid signatures", async () => {
			const response = await worker.fetch(
				new Request("http://localhost/webhook", {
					method: "POST",
					body: "{}",
					headers: {
						"x-github-event": "push",
						"x-hub-signature-256": "sha256=invalid",
					},
				}),
				testEnv,
			);
			expect(response.status).toBe(401);
		});

		it("responds to ping events without queueing", async () => {
			const response = await worker.fetch(await webhookRequest("ping", '{"zen":"test"}'), testEnv);
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ status: "ok", event: "ping" });
			expect(queueSend).not.toHaveBeenCalled();
		});

		it("queues push events and responds with 202", async () => {
			const response = await worker.fetch(
				await webhookRequest("push", JSON.stringify(pushEvent)),
				testEnv,
			);

			expect(response.status).toBe(202);
			expect(await response.json()).toEqual({
				status: "queued",
				event: "push",
				deliveryId: "delivery-123",
				messages: 1,
			});
			expect(queueSend).toHaveBeenCalledWith({
				eventType: "push",
				deliveryId: "delivery-123",
				event: {
					ref: pushEvent.ref,
					repository: pushEvent.repository,
					commits: [
						{
							id: "abc1234",
							message: "Refs ODP-123",
							url: pushEvent.commits[0].url,
							displayTitle: "Fix bug ODP-123",
							author: { name: "GitHub user", email: "test@example.com" },
						},
					],
				},
			});
		});

		it("keeps queued work below the Queue limit for oversized nested push fields", async () => {
			const largeEvent = {
				...pushEvent,
				irrelevant: "x".repeat(200_000),
				repository: {
					...pushEvent.repository,
					irrelevant: "r".repeat(200_000),
				},
				commits: [
					{
						...pushEvent.commits[0],
						message: `Refs ODP-123 ${"y".repeat(200_000)}`,
						author: {
							...pushEvent.commits[0].author,
							irrelevant: "a".repeat(200_000),
						},
					},
				],
			};
			const response = await worker.fetch(
				await webhookRequest("push", JSON.stringify(largeEvent)),
				testEnv,
			);

			expect(response.status).toBe(202);
			const queued = queueSend.mock.calls[0][0] as GitHubEventMessage;
			for (const [message] of queueSend.mock.calls) {
				expect(new TextEncoder().encode(JSON.stringify(message)).byteLength).toBeLessThan(
					128 * 1024,
				);
			}
			expect("irrelevant" in queued.event).toBe(false);
			if (queued.eventType === "push") {
				expect(queued.event.repository).toEqual(pushEvent.repository);
				expect(queued.event.commits[0].displayTitle?.length).toBeLessThanOrEqual(1025);
				expect("irrelevant" in queued.event.commits[0].author).toBe(false);
			}
		});

		it("queues pull request events", async () => {
			const response = await worker.fetch(
				await webhookRequest("pull_request", JSON.stringify(pullRequestEvent)),
				testEnv,
			);
			expect(response.status).toBe(202);
			expect(queueSend).toHaveBeenCalledWith({
				eventType: "pull_request",
				deliveryId: "delivery-123",
				event: {
					action: pullRequestEvent.action,
					pull_request: {
						...pullRequestEvent.pull_request,
						user: { login: "testuser", email: undefined },
					},
					repository: pullRequestEvent.repository,
				},
			});
		});

		it("compacts oversized nested PR fields to normalized references", async () => {
			const largeEvent = {
				...pullRequestEvent,
				pull_request: {
					...pullRequestEvent.pull_request,
					body: `Refs ODP-123\n${"z".repeat(200_000)}`,
					irrelevant: "p".repeat(200_000),
					user: {
						...pullRequestEvent.pull_request.user,
						irrelevant: "u".repeat(200_000),
					},
				},
				repository: {
					...pullRequestEvent.repository,
					irrelevant: "r".repeat(200_000),
					owner: {
						...pullRequestEvent.repository.owner,
						irrelevant: "o".repeat(200_000),
					},
				},
			};
			const response = await worker.fetch(
				await webhookRequest("pull_request", JSON.stringify(largeEvent)),
				testEnv,
			);

			expect(response.status).toBe(202);
			const queued = queueSend.mock.calls[0][0] as GitHubEventMessage;
			for (const [message] of queueSend.mock.calls) {
				expect(new TextEncoder().encode(JSON.stringify(message)).byteLength).toBeLessThan(
					128 * 1024,
				);
			}
			if (queued.eventType === "pull_request") {
				expect(queued.event.pull_request).toMatchObject({ title: "Refs ODP-123", body: null });
				expect("irrelevant" in queued.event.pull_request).toBe(false);
				expect("irrelevant" in queued.event.pull_request.user).toBe(false);
				expect("irrelevant" in queued.event.repository).toBe(false);
				expect("irrelevant" in queued.event.repository.owner).toBe(false);
			}
		});

		it("acknowledges unsupported event types without queueing", async () => {
			const response = await worker.fetch(
				await webhookRequest("issues", '{"action":"created"}'),
				testEnv,
			);
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({
				status: "ok",
				event: "issues",
				message: "Event type not handled",
			});
			expect(queueSend).not.toHaveBeenCalled();
		});

		it("rejects malformed JSON before queueing", async () => {
			const response = await worker.fetch(
				await webhookRequest("push", "invalid json {{{"),
				testEnv,
			);
			expect(response.status).toBe(400);
			expect(queueSend).not.toHaveBeenCalled();
		});

		it("queues the same stable ordering metadata when GitHub retries later", async () => {
			const now = vi.spyOn(Date, "now");
			now.mockReturnValue(1_000);
			await worker.fetch(
				await webhookRequest("pull_request", JSON.stringify(pullRequestEvent)),
				testEnv,
			);
			now.mockReturnValue(9_999_999);
			await worker.fetch(
				await webhookRequest("pull_request", JSON.stringify(pullRequestEvent)),
				testEnv,
			);

			expect(queueSend).toHaveBeenCalledTimes(2);
			expect(queueSend.mock.calls[1][0]).toEqual(queueSend.mock.calls[0][0]);
		});

		it("returns 503 when publishing to the queue fails", async () => {
			queueSend.mockRejectedValueOnce(new Error("queue unavailable"));
			const response = await worker.fetch(
				await webhookRequest("push", JSON.stringify(pushEvent)),
				testEnv,
			);
			expect(response.status).toBe(503);
			expect(await response.json()).toEqual({
				status: "error",
				message: "Failed to enqueue event",
			});
		});
	});

	describe("queue consumer", () => {
		it("processes and acknowledges a push event", async () => {
			mockOdooResponses([
				42,
				[], // exact delivery marker
				[{ id: 123, name: "Test Task", stage_id: [1, "Todo"] }],
				[], // author lookup
				[{ id: 1, name: "Note" }],
				1,
			]);
			const { batch, ack, retry } = queueBatch({
				eventType: "push",
				deliveryId: "delivery-123",
				event: pushEvent,
			});

			await worker.queue(batch, testEnv);

			expect(ack).toHaveBeenCalledOnce();
			expect(retry).not.toHaveBeenCalled();
		});

		it("retries a message when event processing reports an error", async () => {
			mockOdooResponses([42, []]);
			const { batch, ack, retry } = queueBatch({
				eventType: "push",
				deliveryId: "delivery-123",
				event: pushEvent,
			});

			await worker.queue(batch, testEnv);

			expect(retry).toHaveBeenCalledOnce();
			expect(ack).not.toHaveBeenCalled();
		});

		it("processes merged PR transitions before acknowledging", async () => {
			const fetchSpy = mockOdooResponses([
				42,
				[], // exact delivery marker
				[], // latest delivery marker
				[{ id: 123, name: "Test Task", stage_id: [1, "Todo"], github_pr_url: null }],
				true, // set primary PR link
				true, // set stage
				[], // author lookup
				[{ id: 1, name: "Note" }],
				1,
			]);
			const mergedEvent = {
				...pullRequestEvent,
				action: "closed",
				pull_request: {
					...pullRequestEvent.pull_request,
					title: "Closes ODP-123",
					merged: true,
				},
			};
			const { batch, ack } = queueBatch({
				eventType: "pull_request",
				deliveryId: "delivery-123",
				event: mergedEvent,
			});

			await worker.queue(batch, testEnv);

			expect(ack).toHaveBeenCalledOnce();
			expect(fetchSpy).toHaveBeenCalledTimes(9);
		});

		it("resolves configured stage names in the consumer", async () => {
			mockOdooResponses([
				42,
				[], // exact delivery marker
				[], // latest delivery marker
				[{ id: 123, name: "Test Task", stage_id: [1, "Todo"], github_pr_url: null }],
				true, // set primary PR link
				[{ id: 5, name: "Review" }],
				true,
				[], // author lookup
				[{ id: 1, name: "Note" }],
				1,
			]);
			const env: Env = {
				...testEnv,
				ODOO_STAGE_IN_PROGRESS: "Review",
			};
			const { batch, ack } = queueBatch({
				eventType: "pull_request",
				deliveryId: "delivery-123",
				event: pullRequestEvent,
			});

			await worker.queue(batch, env);

			expect(ack).toHaveBeenCalledOnce();
		});
	});
});
