import { describe, expect, it, vi, afterEach } from "vitest";
import { postPRComment, type GitHubCommentConfig } from "../src/github/comments.js";

describe("postPRComment", () => {
	let fetchSpy: ReturnType<typeof vi.spyOn>;

	afterEach(() => {
		fetchSpy?.mockRestore();
	});

	const config: GitHubCommentConfig = {
		token: "test-token",
	};

	it("posts comment to correct GitHub API endpoint", async () => {
		fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ id: 1 }), { status: 201 })
		);

		await postPRComment(config, "owner", "repo", 42, "Test comment");

		expect(fetchSpy).toHaveBeenCalledWith(
			"https://api.github.com/repos/owner/repo/issues/42/comments",
			expect.objectContaining({
				method: "POST",
				headers: expect.objectContaining({
					Accept: "application/vnd.github+json",
					Authorization: "Bearer test-token",
					"X-GitHub-Api-Version": "2022-11-28",
					"User-Agent": "ghoodoo",
				}),
				body: JSON.stringify({ body: "Test comment" }),
			})
		);
	});

	it("throws error on non-OK response", async () => {
		fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
			new Response("Not Found", { status: 404 })
		);

		await expect(
			postPRComment(config, "owner", "repo", 999, "Test comment")
		).rejects.toThrow("GitHub API error: 404 Not Found");
	});

	it("handles authentication errors", async () => {
		fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
			new Response("Bad credentials", { status: 401 })
		);

		await expect(
			postPRComment(config, "owner", "repo", 42, "Test comment")
		).rejects.toThrow("GitHub API error: 401 Bad credentials");
	});

	it("handles rate limiting errors", async () => {
		fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
			new Response("Rate limit exceeded", { status: 403 })
		);

		await expect(
			postPRComment(config, "owner", "repo", 42, "Test comment")
		).rejects.toThrow("GitHub API error: 403 Rate limit exceeded");
	});

	it("handles special characters in comment body", async () => {
		fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ id: 1 }), { status: 201 })
		);

		const commentWithSpecialChars = 'Updated tasks: ODP-123, ODP-456\n\n> Quote "here"';
		await postPRComment(config, "owner", "repo", 42, commentWithSpecialChars);

		const callBody = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
		expect(callBody.body).toBe(commentWithSpecialChars);
	});
});
