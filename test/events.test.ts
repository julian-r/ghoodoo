import { describe, expect, it, vi, beforeEach } from "vitest";
import { handlePushEvent, handlePullRequestEvent, type PushEvent, type PullRequestEvent } from "../src/github/events.js";
import type { OdooClient } from "../src/odoo/client.js";

// Create a mock OdooClient
function createMockOdooClient(overrides: Partial<OdooClient> = {}): OdooClient {
	return {
		getTask: vi.fn().mockResolvedValue({ id: 123, name: "Test Task", stage_id: [1, "Todo"] }),
		addMessage: vi.fn().mockResolvedValue(1),
		setStage: vi.fn().mockResolvedValue(true),
		resolveStage: vi.fn().mockResolvedValue(1),
		getUserByEmail: vi.fn().mockResolvedValue(null),
		getPartnerIdForUser: vi.fn().mockResolvedValue(null),
		resolveAuthorPartnerId: vi.fn().mockResolvedValue(null),
		resolveAuthorLink: vi.fn().mockResolvedValue("@testuser"),
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
			"test@example.com"
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
		expect(odoo.addMessage).toHaveBeenCalledWith(
			123,
			expect.stringContaining("#42"),
			"testuser"
		);
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
		const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ id: 1 }), { status: 201 })
		);

		await handlePullRequestEvent(event, odoo, githubConfig);

		expect(fetchSpy).toHaveBeenCalledWith(
			"https://api.github.com/repos/owner/repo/issues/42/comments",
			expect.objectContaining({
				method: "POST",
				headers: expect.objectContaining({
					Authorization: "Bearer test-token",
				}),
			})
		);

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

		const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ id: 1 }), { status: 201 })
		);

		await handlePullRequestEvent(event, odoo, githubConfig);

		// Should not call GitHub API (only Odoo calls)
		expect(fetchSpy).not.toHaveBeenCalledWith(
			expect.stringContaining("github.com"),
			expect.anything()
		);

		fetchSpy.mockRestore();
	});
});
