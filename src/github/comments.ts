export interface GitHubCommentConfig {
	token: string;
}

export async function postPRComment(
	config: GitHubCommentConfig,
	owner: string,
	repo: string,
	prNumber: number,
	body: string,
): Promise<void> {
	const url = `https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments`;

	const response = await fetch(url, {
		method: "POST",
		headers: {
			Accept: "application/vnd.github+json",
			Authorization: `Bearer ${config.token}`,
			"X-GitHub-Api-Version": "2022-11-28",
			"User-Agent": "ghoodoo",
		},
		body: JSON.stringify({ body }),
	});

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`GitHub API error: ${response.status} ${text}`);
	}
}
