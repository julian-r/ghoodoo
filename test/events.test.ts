import { describe, expect, it, vi } from "vitest";
import {
	handlePullRequestEvent,
	handlePushEvent,
	type PullRequestEvent,
	type PushEvent,
} from "../src/github/events.js";
import type { OdooClient } from "../src/odoo/client.js";

// Create a mock OdooClient
function createMockOdooClient(overrides: Partial<OdooClient> = {}): OdooClient {
	return {
		getTask: vi.fn().mockResolvedValue({ id: 123, name: "Test Task", stage_id: [1, "Todo"] }),
		addMessage: vi.fn().mockResolvedValue(1),
		setStage: vi.fn().mockResolvedValue(true),
		setPrimaryPullRequestUrl: vi.fn().mockResolvedValue(undefined),
		resolveStage: vi.fn().mockResolvedValue(1),
		getUserByEmail: vi.fn().mockResolvedValue(null),
		getPartnerIdForUser: vi.fn().mockResolvedValue(null),
		resolveAuthorPartnerId: vi.fn().mockResolvedValue(null),
		resolveAuthorLink: vi.fn().mockResolvedValue("@testuser"),
		getDeliveryEffectStatus: vi.fn().mockResolvedValue("pending"),
		stages: { done: 5, inProgress: 2, canceled: 6 },
		...overrides,
	} as unknown as OdooClient;
}

describe("handlePushEvent", () => {
	const basePushEvent: PushEvent = {
		ref: "refs/heads/main",
		repository: {
			full_name: "owner/repo",
			html_url: "https://github.com/owner/repo",
		},
		commits: [],
	};

	it("processes commits with ODP references", async () => {
		const odoo = createMockOdooClient();
		const event: PushEvent = {
			...basePushEvent,
			commits: [
				{
					id: "abc1234567890",
					message: "Fix bug ODP-123",
					url: "https://github.com/owner/repo/commit/abc1234567890",
					author: { name: "Test User", email: "test@example.com", username: "testuser" },
				},
			],
		};

		const result = await handlePushEvent(event, odoo);

		expect(result.processed).toBe(1);
		expect(result.errors).toHaveLength(0);
		expect(odoo.getTask).toHaveBeenCalledWith(123);
		expect(odoo.addMessage).toHaveBeenCalledWith(
			123,
			expect.stringContaining("abc1234"),
			"test@example.com",
		);
	});

	it("sets stage to done when commit closes task", async () => {
		const odoo = createMockOdooClient();
		const event: PushEvent = {
			...basePushEvent,
			commits: [
				{
					id: "abc1234567890",
					message: "Closes ODP-456",
					url: "https://github.com/owner/repo/commit/abc1234567890",
					author: { name: "Test User", email: "test@example.com" },
				},
			],
		};

		await handlePushEvent(event, odoo);

		expect(odoo.setStage).toHaveBeenCalledWith(456);
	});

	it("does not set stage for ref-only references", async () => {
		const odoo = createMockOdooClient();
		const event: PushEvent = {
			...basePushEvent,
			commits: [
				{
					id: "abc1234567890",
					message: "Working on ODP-789",
					url: "https://github.com/owner/repo/commit/abc1234567890",
					author: { name: "Test User" },
				},
			],
		};

		await handlePushEvent(event, odoo);

		expect(odoo.setStage).not.toHaveBeenCalled();
	});

	it("reports error when task not found", async () => {
		const odoo = createMockOdooClient({
			getTask: vi.fn().mockResolvedValue(null),
		});
		const event: PushEvent = {
			...basePushEvent,
			commits: [
				{
					id: "abc1234567890",
					message: "Refs ODP-999",
					url: "https://github.com/owner/repo/commit/abc1234567890",
					author: { name: "Test User" },
				},
			],
		};

		const result = await handlePushEvent(event, odoo);

		expect(result.processed).toBe(0);
		expect(result.errors).toContain("ODP-999: Task not found");
	});

	it("deduplicates task references across commits", async () => {
		const odoo = createMockOdooClient();
		const event: PushEvent = {
			...basePushEvent,
			commits: [
				{
					id: "abc1234567890",
					message: "Start ODP-123",
					url: "https://github.com/owner/repo/commit/abc1234567890",
					author: { name: "Test User" },
				},
				{
					id: "def1234567890",
					message: "Continue ODP-123",
					url: "https://github.com/owner/repo/commit/def1234567890",
					author: { name: "Test User" },
				},
			],
		};

		const result = await handlePushEvent(event, odoo);

		expect(result.processed).toBe(1);
		expect(odoo.addMessage).toHaveBeenCalledTimes(1);
	});

	it("prioritizes close action over ref when same task in multiple commits", async () => {
		const odoo = createMockOdooClient();
		const event: PushEvent = {
			...basePushEvent,
			commits: [
				{
					id: "abc1234567890",
					message: "Refs ODP-123",
					url: "https://github.com/owner/repo/commit/abc1234567890",
					author: { name: "Test User" },
				},
				{
					id: "def1234567890",
					message: "Closes ODP-123",
					url: "https://github.com/owner/repo/commit/def1234567890",
					author: { name: "Test User" },
				},
			],
		};

		await handlePushEvent(event, odoo);

		expect(odoo.setStage).toHaveBeenCalledWith(123);
	});

	it("returns empty result for commits without references", async () => {
		const odoo = createMockOdooClient();
		const event: PushEvent = {
			...basePushEvent,
			commits: [
				{
					id: "abc1234567890",
					message: "Regular commit without references",
					url: "https://github.com/owner/repo/commit/abc1234567890",
					author: { name: "Test User" },
				},
			],
		};

		const result = await handlePushEvent(event, odoo);

		expect(result.processed).toBe(0);
		expect(result.errors).toHaveLength(0);
		expect(odoo.getTask).not.toHaveBeenCalled();
	});

	it("does not replay a completed delivery effect", async () => {
		const odoo = createMockOdooClient({
			getDeliveryEffectStatus: vi.fn().mockResolvedValue("completed"),
		});
		const event: PushEvent = {
			...basePushEvent,
			commits: [
				{
					id: "abc1234567890",
					message: "Closes ODP-123",
					url: "https://github.com/owner/repo/commit/abc1234567890",
					author: { name: "Test User" },
				},
			],
		};

		const result = await handlePushEvent(event, odoo, {
			deliveryId: "delivery-1",
		});

		expect(result.errors).toHaveLength(0);
		expect(odoo.getTask).not.toHaveBeenCalled();
		expect(odoo.setStage).not.toHaveBeenCalled();
		expect(odoo.addMessage).not.toHaveBeenCalled();
	});

	it("does not replay successful tasks when a mixed result retries", async () => {
		const status = vi
			.fn()
			.mockResolvedValueOnce("pending")
			.mockResolvedValueOnce("pending")
			.mockResolvedValueOnce("completed")
			.mockResolvedValueOnce("pending");
		const odoo = createMockOdooClient({
			getDeliveryEffectStatus: status,
			getTask: vi.fn(async (taskId: number) =>
				taskId === 123
					? {
							id: 123,
							name: "Task",
							stage_id: [1, "Todo"] as [number, string],
							github_pr_url: null,
						}
					: null,
			),
		});
		const event: PushEvent = {
			...basePushEvent,
			commits: [
				{
					id: "abc1234567890",
					message: "Refs ODP-123 and ODP-999",
					url: "https://github.com/owner/repo/commit/abc1234567890",
					author: { name: "Test User" },
				},
			],
		};
		const context = { deliveryId: "delivery-1" };

		const first = await handlePushEvent(event, odoo, context);
		const retry = await handlePushEvent(event, odoo, context);

		expect(first.errors).toContain("ODP-999: Task not found");
		expect(retry.errors).toContain("ODP-999: Task not found");
		expect(odoo.addMessage).toHaveBeenCalledTimes(1);
	});
});

describe("handlePullRequestEvent", () => {
	const basePREvent: PullRequestEvent = {
		action: "opened",
		pull_request: {
			number: 42,
			title: "Test PR",
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

	it("processes PR with ODP reference in title", async () => {
		const odoo = createMockOdooClient();
		const event: PullRequestEvent = {
			...basePREvent,
			pull_request: {
				...basePREvent.pull_request,
				title: "Fix ODP-123",
			},
		};

		const result = await handlePullRequestEvent(event, odoo, null);

		expect(result.processed).toBe(1);
		expect(odoo.setPrimaryPullRequestUrl).toHaveBeenCalledWith(
			123,
			"https://github.com/owner/repo/pull/42",
		);
		expect(odoo.addMessage).toHaveBeenCalledWith(123, expect.stringContaining("#42"), "testuser");
	});

	it("links one PR as primary on multiple referenced tasks", async () => {
		const odoo = createMockOdooClient();
		const event: PullRequestEvent = {
			...basePREvent,
			pull_request: { ...basePREvent.pull_request, title: "Refs ODP-123 and ODP-456" },
		};

		const result = await handlePullRequestEvent(event, odoo, null);

		expect(result.processed).toBe(2);
		expect(odoo.setPrimaryPullRequestUrl).toHaveBeenCalledWith(123, event.pull_request.html_url);
		expect(odoo.setPrimaryPullRequestUrl).toHaveBeenCalledWith(456, event.pull_request.html_url);
	});

	it("does not replace a different primary PR, but still posts the new reference", async () => {
		const odoo = createMockOdooClient({
			getTask: vi.fn().mockResolvedValue({
				id: 123,
				name: "Test Task",
				stage_id: [1, "Todo"],
				github_pr_url: "https://github.com/owner/repo/pull/41",
			}),
		});
		const event: PullRequestEvent = {
			...basePREvent,
			pull_request: { ...basePREvent.pull_request, title: "Refs ODP-123" },
		};

		const result = await handlePullRequestEvent(event, odoo, null);

		expect(result.processed).toBe(1);
		expect(odoo.setPrimaryPullRequestUrl).not.toHaveBeenCalled();
		expect(odoo.addMessage).toHaveBeenCalledWith(123, expect.stringContaining("#42"), "testuser");
	});

	it("does not rewrite the existing primary PR on subsequent events", async () => {
		const odoo = createMockOdooClient({
			getTask: vi.fn().mockResolvedValue({
				id: 123,
				name: "Test Task",
				stage_id: [1, "Todo"],
				github_pr_url: basePREvent.pull_request.html_url,
			}),
		});
		const event: PullRequestEvent = {
			...basePREvent,
			action: "edited",
			pull_request: { ...basePREvent.pull_request, title: "Refs ODP-123" },
		};

		const result = await handlePullRequestEvent(event, odoo, null);

		expect(result.processed).toBe(1);
		expect(odoo.setPrimaryPullRequestUrl).not.toHaveBeenCalled();
	});

	it("does not mark delivery complete when the primary link write fails", async () => {
		const odoo = createMockOdooClient({
			setPrimaryPullRequestUrl: vi.fn().mockRejectedValue(new Error("Odoo write failed")),
		});
		const event: PullRequestEvent = {
			...basePREvent,
			pull_request: { ...basePREvent.pull_request, title: "Refs ODP-123" },
		};

		const result = await handlePullRequestEvent(event, odoo, null, { deliveryId: "delivery-42" });

		expect(result.errors).toContain("ODP-123: Odoo write failed");
		expect(odoo.setStage).not.toHaveBeenCalled();
		expect(odoo.addMessage).not.toHaveBeenCalled();
	});

	it("processes PR with ODP reference in body", async () => {
		const odoo = createMockOdooClient();
		const event: PullRequestEvent = {
			...basePREvent,
			pull_request: {
				...basePREvent.pull_request,
				title: "Some feature",
				body: "This closes ODP-456",
			},
		};

		const result = await handlePullRequestEvent(event, odoo, null);

		expect(result.processed).toBe(1);
		expect(odoo.getTask).toHaveBeenCalledWith(456);
	});

	it("sets inProgress stage when PR is opened", async () => {
		const odoo = createMockOdooClient();
		const event: PullRequestEvent = {
			...basePREvent,
			action: "opened",
			pull_request: {
				...basePREvent.pull_request,
				title: "Refs ODP-123",
			},
		};

		await handlePullRequestEvent(event, odoo, null);

		expect(odoo.setStage).toHaveBeenCalledWith(123, 2); // inProgress stage
	});

	it("sets done stage when PR with close keyword is merged", async () => {
		const odoo = createMockOdooClient();
		const event: PullRequestEvent = {
			...basePREvent,
			action: "closed",
			pull_request: {
				...basePREvent.pull_request,
				title: "Closes ODP-123",
				merged: true,
			},
		};

		await handlePullRequestEvent(event, odoo, null);

		expect(odoo.setStage).toHaveBeenCalledWith(123, 5); // done stage
	});

	it("sets canceled stage when PR is closed without merge", async () => {
		const odoo = createMockOdooClient();
		const event: PullRequestEvent = {
			...basePREvent,
			action: "closed",
			pull_request: {
				...basePREvent.pull_request,
				title: "Refs ODP-123",
				merged: false,
			},
		};

		await handlePullRequestEvent(event, odoo, null);

		expect(odoo.setStage).toHaveBeenCalledWith(123, 6); // canceled stage
	});

	it("does not set inProgress stage when draft PR is opened", async () => {
		const odoo = createMockOdooClient();
		const event: PullRequestEvent = {
			...basePREvent,
			action: "opened",
			pull_request: {
				...basePREvent.pull_request,
				title: "Refs ODP-123",
				draft: true,
			},
		};

		await handlePullRequestEvent(event, odoo, null);

		expect(odoo.addMessage).toHaveBeenCalled();
		expect(odoo.setStage).not.toHaveBeenCalled();
	});

	it("sets inProgress stage when draft PR is marked ready for review", async () => {
		const odoo = createMockOdooClient();
		const event: PullRequestEvent = {
			...basePREvent,
			action: "ready_for_review",
			pull_request: {
				...basePREvent.pull_request,
				title: "Refs ODP-123",
				draft: false,
			},
		};

		await handlePullRequestEvent(event, odoo, null);

		expect(odoo.setStage).toHaveBeenCalledWith(123, 2);
	});

	it("does not let an older retried event overwrite a newer task state", async () => {
		const odoo = createMockOdooClient({
			getDeliveryEffectStatus: vi.fn().mockResolvedValue("stale"),
		});
		const event: PullRequestEvent = {
			...basePREvent,
			pull_request: {
				...basePREvent.pull_request,
				title: "Refs ODP-123",
			},
		};

		await handlePullRequestEvent(event, odoo, null, {
			deliveryId: "older-delivery",
		});

		expect(odoo.setStage).not.toHaveBeenCalled();
		expect(odoo.addMessage).not.toHaveBeenCalled();
	});

	it("does not let an edited marker suppress an opened stage transition", async () => {
		const status = vi.fn().mockResolvedValue("pending");
		const odoo = createMockOdooClient({ getDeliveryEffectStatus: status });
		const edited: PullRequestEvent = {
			...basePREvent,
			action: "edited",
			pull_request: {
				...basePREvent.pull_request,
				title: "Refs ODP-123",
				updated_at: "2026-01-01T10:01:00Z",
			},
		};
		const opened: PullRequestEvent = {
			...basePREvent,
			pull_request: {
				...basePREvent.pull_request,
				title: "Refs ODP-123",
			},
		};

		await handlePullRequestEvent(edited, odoo, null, { deliveryId: "edited-delivery" });
		await handlePullRequestEvent(opened, odoo, null, { deliveryId: "opened-delivery" });

		expect(status.mock.calls[0][1]).toEqual({
			id: "pull_request.edited-delivery.task.123",
			stageOrder: undefined,
		});
		expect(status.mock.calls[1][1]).toEqual({
			id: "pull_request.opened-delivery.task.123",
			stageOrder: { occurredAt: Date.parse("2026-01-01T10:00:00Z"), state: "open" },
		});
	});

	it("records delivery completion only after the stage transition", async () => {
		const odoo = createMockOdooClient();
		const event: PullRequestEvent = {
			...basePREvent,
			pull_request: {
				...basePREvent.pull_request,
				title: "Refs ODP-123",
			},
		};

		await handlePullRequestEvent(event, odoo, null, {
			deliveryId: "delivery-1",
		});

		const setStage = vi.mocked(odoo.setStage);
		const addMessage = vi.mocked(odoo.addMessage);
		expect(setStage.mock.invocationCallOrder[0]).toBeLessThan(
			addMessage.mock.invocationCallOrder[0],
		);
		expect(addMessage).toHaveBeenCalledWith(
			123,
			expect.stringContaining("#42"),
			"testuser",
			expect.objectContaining({ id: "pull_request.delivery-1.task.123" }),
		);
	});

	it("ignores unhandled PR actions", async () => {
		const odoo = createMockOdooClient();
		const event: PullRequestEvent = {
			...basePREvent,
			action: "labeled",
			pull_request: {
				...basePREvent.pull_request,
				title: "Refs ODP-123",
			},
		};

		const result = await handlePullRequestEvent(event, odoo, null);

		expect(result.processed).toBe(0);
		expect(odoo.getTask).not.toHaveBeenCalled();
	});

	it("returns empty result for PR without references", async () => {
		const odoo = createMockOdooClient();
		const event: PullRequestEvent = {
			...basePREvent,
			pull_request: {
				...basePREvent.pull_request,
				title: "Regular PR",
				body: "No task references here",
			},
		};

		const result = await handlePullRequestEvent(event, odoo, null);

		expect(result.processed).toBe(0);
		expect(result.errors).toHaveLength(0);
	});

	it("posts GitHub comment when configured and tasks updated", async () => {
		const odoo = createMockOdooClient();
		const githubConfig = { token: "test-token" };
		const event: PullRequestEvent = {
			...basePREvent,
			pull_request: {
				...basePREvent.pull_request,
				title: "Refs ODP-123",
			},
		};

		// Mock fetch for GitHub API
		const fetchSpy = vi
			.spyOn(global, "fetch")
			.mockResolvedValue(new Response(JSON.stringify({ id: 1 }), { status: 201 }));

		await handlePullRequestEvent(event, odoo, githubConfig);

		expect(fetchSpy).toHaveBeenCalledWith(
			"https://api.github.com/repos/owner/repo/issues/42/comments",
			expect.objectContaining({
				method: "POST",
				headers: expect.objectContaining({
					Authorization: "Bearer test-token",
				}),
			}),
		);

		fetchSpy.mockRestore();
	});

	it("does not fail required processing when the GitHub comment fails", async () => {
		const odoo = createMockOdooClient();
		const event: PullRequestEvent = {
			...basePREvent,
			pull_request: {
				...basePREvent.pull_request,
				title: "Refs ODP-123",
			},
		};
		const fetchSpy = vi
			.spyOn(global, "fetch")
			.mockResolvedValue(new Response("failed", { status: 500 }));

		const result = await handlePullRequestEvent(event, odoo, { token: "test-token" });

		expect(result.processed).toBe(1);
		expect(result.errors).toHaveLength(0);
		fetchSpy.mockRestore();
	});

	it("does not post GitHub comment on PR close", async () => {
		const odoo = createMockOdooClient();
		const githubConfig = { token: "test-token" };
		const event: PullRequestEvent = {
			...basePREvent,
			action: "closed",
			pull_request: {
				...basePREvent.pull_request,
				title: "Refs ODP-123",
				merged: true,
			},
		};

		const fetchSpy = vi
			.spyOn(global, "fetch")
			.mockResolvedValue(new Response(JSON.stringify({ id: 1 }), { status: 201 }));

		await handlePullRequestEvent(event, odoo, githubConfig);

		// Should not call GitHub API (only Odoo calls)
		expect(fetchSpy).not.toHaveBeenCalledWith(
			expect.stringContaining("github.com"),
			expect.anything(),
		);

		fetchSpy.mockRestore();
	});
});
