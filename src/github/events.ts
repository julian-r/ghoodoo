import type { OdooClient, StageRef } from "../odoo/client.js";
import { type TaskReference, parseReferences } from "../parser/references.js";
import { type GitHubCommentConfig, postPRComment } from "./comments.js";

// GitHub icon - using their fluidicon which has colored background for both themes
const GH_ICON = `<img src="https://github.com/fluidicon.png" width="16" height="16" style="vertical-align: middle; margin-right: 4px; border-radius: 3px;">`;

export interface PushEvent {
	ref: string;
	repository: {
		full_name: string;
		html_url: string;
	};
	commits: Array<{
		id: string;
		message: string;
		url: string;
		author: {
			name: string;
			email?: string;
			username?: string;
		};
	}>;
}

export interface PullRequestEvent {
	action: string;
	pull_request: {
		number: number;
		title: string;
		body: string | null;
		html_url: string;
		merged: boolean;
		user: {
			login: string;
		};
	};
	repository: {
		owner: {
			login: string;
		};
		name: string;
		full_name: string;
	};
}

export interface ProcessResult {
	processed: number;
	errors: string[];
}

interface CommitReference {
	ref: TaskReference;
	shortSha: string;
	commitUrl: string;
	commitTitle: string;
	authorEmail?: string;
}

export async function handlePushEvent(event: PushEvent, odoo: OdooClient): Promise<ProcessResult> {
	const result: ProcessResult = { processed: 0, errors: [] };
	const allReferences = new Map<number, CommitReference>();

	for (const commit of event.commits) {
		const refs = parseReferences(commit.message);

		for (const ref of refs) {
			const existing = allReferences.get(ref.taskId);
			if (!existing || ref.action === "close") {
				allReferences.set(ref.taskId, {
					ref: existing?.ref.action === "close" ? existing.ref : ref,
					shortSha: commit.id.substring(0, 7),
					commitUrl: commit.url,
					commitTitle: commit.message.split("\n")[0],
					authorEmail: commit.author.email,
				});
			}
		}
	}

	for (const [taskId, commitRef] of allReferences) {
		const { ref, shortSha, commitUrl, commitTitle, authorEmail } = commitRef;
		try {
			const task = await odoo.getTask(taskId);
			if (!task) {
				result.errors.push(`ODP-${taskId}: Task not found`);
				continue;
			}

			const message = `${GH_ICON} Referenced in commit <a href="${commitUrl}">${shortSha}</a>: ${commitTitle}`;
			await odoo.addMessage(taskId, message, authorEmail);

			if (ref.action === "close") {
				await odoo.setStage(taskId);
			}

			result.processed++;
		} catch (error) {
			result.errors.push(
				`ODP-${taskId}: ${error instanceof Error ? error.message : "Unknown error"}`,
			);
		}
	}

	return result;
}

export async function handlePullRequestEvent(
	event: PullRequestEvent,
	odoo: OdooClient,
	githubConfig: GitHubCommentConfig | null,
): Promise<ProcessResult> {
	const result: ProcessResult = { processed: 0, errors: [] };

	if (!["opened", "edited", "closed", "reopened"].includes(event.action)) {
		return result;
	}

	const pr = event.pull_request;
	const textToSearch = `${pr.title}\n${pr.body ?? ""}`;
	const refs = parseReferences(textToSearch);

	if (refs.length === 0) {
		return result;
	}

	const isMerged = event.action === "closed" && pr.merged;
	const isClosed = event.action === "closed" && !pr.merged;
	const isOpened = event.action === "opened" || event.action === "reopened";
	const updatedTasks: string[] = [];

	// Determine which stage to transition to based on PR action
	const getTargetStage = (refAction: "close" | "ref"): StageRef | null => {
		if (isMerged && refAction === "close") {
			return odoo.stages.done;
		}
		if (isClosed && odoo.stages.canceled) {
			return odoo.stages.canceled;
		}
		if (isOpened && odoo.stages.inProgress) {
			return odoo.stages.inProgress;
		}
		return null;
	};

	for (const ref of refs) {
		try {
			const task = await odoo.getTask(ref.taskId);
			if (!task) {
				result.errors.push(`ODP-${ref.taskId}: Task not found`);
				continue;
			}

			const action = event.action === "closed" ? (pr.merged ? "merged" : "closed") : event.action;
			const message = `${GH_ICON} Referenced in PR <a href="${pr.html_url}">#${pr.number}</a> (${action})`;
			await odoo.addMessage(ref.taskId, message);

			const targetStage = getTargetStage(ref.action);
			if (targetStage) {
				await odoo.setStage(ref.taskId, targetStage);
			}

			updatedTasks.push(`ODP-${ref.taskId}`);
			result.processed++;
		} catch (error) {
			result.errors.push(
				`ODP-${ref.taskId}: ${error instanceof Error ? error.message : "Unknown error"}`,
			);
		}
	}

	if (githubConfig && updatedTasks.length > 0 && event.action !== "closed") {
		try {
			const comment = `Updated Odoo tasks: ${updatedTasks.join(", ")}`;
			await postPRComment(
				githubConfig,
				event.repository.owner.login,
				event.repository.name,
				pr.number,
				comment,
			);
		} catch (error) {
			result.errors.push(
				`GitHub comment failed: ${error instanceof Error ? error.message : "Unknown error"}`,
			);
		}
	}

	return result;
}
