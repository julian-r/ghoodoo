import type { DeliveryEffect, OdooClient, StageRef } from "../odoo/client.js";
import { parseReferences, type TaskReference } from "../parser/references.js";
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
		displayTitle?: string;
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
		draft: boolean;
		created_at?: string;
		updated_at?: string;
		closed_at?: string | null;
		merged_at?: string | null;
		user: {
			login: string;
			email?: string;
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

export interface DeliveryContext {
	deliveryId: string;
}

interface CommitReference {
	ref: TaskReference;
	shortSha: string;
	commitUrl: string;
	commitTitle: string;
	authorEmail?: string;
}

function collectPushReferences(event: PushEvent): Map<number, CommitReference> {
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
					commitTitle: commit.displayTitle ?? commit.message.split("\n")[0],
					authorEmail: commit.author.email,
				});
			}
		}
	}

	return allReferences;
}

export function buildCompactPushEvents(event: PushEvent): PushEvent[] {
	return [...collectPushReferences(event).entries()].map(([taskId, commitRef]) => ({
		ref: event.ref,
		repository: {
			full_name: event.repository.full_name,
			html_url: event.repository.html_url,
		},
		commits: [
			{
				id: commitRef.shortSha,
				message: `${commitRef.ref.action === "close" ? "Closes" : "Refs"} ODP-${taskId}`,
				url: commitRef.commitUrl,
				displayTitle:
					commitRef.commitTitle.length > 1024
						? `${commitRef.commitTitle.slice(0, 1024)}…`
						: commitRef.commitTitle,
				author: {
					name: "GitHub user",
					email: commitRef.authorEmail,
				},
			},
		],
	}));
}

export function buildCompactPullRequestEvents(event: PullRequestEvent): PullRequestEvent[] {
	const pr = event.pull_request;
	const refs = parseReferences(`${pr.title}\n${pr.body ?? ""}`);
	const chunks: TaskReference[][] = [];
	for (let offset = 0; offset < refs.length; offset += 500) {
		chunks.push(refs.slice(offset, offset + 500));
	}
	return chunks.map((chunk) => ({
		action: event.action,
		pull_request: {
			number: pr.number,
			title: chunk
				.map((ref) => `${ref.action === "close" ? "Closes" : "Refs"} ODP-${ref.taskId}`)
				.join(" "),
			body: null,
			html_url: pr.html_url,
			merged: pr.merged,
			draft: pr.draft,
			created_at: pr.created_at,
			updated_at: pr.updated_at,
			closed_at: pr.closed_at,
			merged_at: pr.merged_at,
			user: {
				login: pr.user.login,
				email: pr.user.email,
			},
		},
		repository: {
			owner: { login: event.repository.owner.login },
			name: event.repository.name,
			full_name: event.repository.full_name,
		},
	}));
}

function deliveryEffect(
	context: DeliveryContext | undefined,
	eventType: "push" | "pull_request",
	taskId: number,
	stageOrder?: DeliveryEffect["stageOrder"],
): DeliveryEffect | undefined {
	return context
		? { id: `${eventType}.${context.deliveryId}.task.${taskId}`, stageOrder }
		: undefined;
}

function parseEventTime(value: string | null | undefined): number | undefined {
	if (!value) return undefined;
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? timestamp : undefined;
}

function pullRequestStageOrder(
	event: PullRequestEvent,
	isOpened: boolean,
	isClosed: boolean,
	isMerged: boolean,
): DeliveryEffect["stageOrder"] {
	const pr = event.pull_request;
	if (isClosed || isMerged) {
		const occurredAt = parseEventTime(pr.merged_at ?? pr.closed_at ?? pr.updated_at);
		return occurredAt === undefined ? undefined : { occurredAt, state: "closed" };
	}
	if (!isOpened) return undefined;

	const occurredAt = parseEventTime(
		event.action === "opened" ? (pr.created_at ?? pr.updated_at) : pr.updated_at,
	);
	return occurredAt === undefined ? undefined : { occurredAt, state: "open" };
}

export async function handlePushEvent(
	event: PushEvent,
	odoo: OdooClient,
	context?: DeliveryContext,
): Promise<ProcessResult> {
	const result: ProcessResult = { processed: 0, errors: [] };
	const allReferences = collectPushReferences(event);

	for (const [taskId, commitRef] of allReferences) {
		const { ref, shortSha, commitUrl, commitTitle, authorEmail } = commitRef;
		try {
			const effect = deliveryEffect(context, "push", taskId);
			if (effect) {
				const status = await odoo.getDeliveryEffectStatus(taskId, effect);
				if (status !== "pending") continue;
			}

			const task = await odoo.getTask(taskId);
			if (!task) {
				result.errors.push(`ODP-${taskId}: Task not found`);
				continue;
			}

			if (ref.action === "close") {
				await odoo.setStage(taskId);
			}

			const message = `${GH_ICON} Referenced in commit <a href="${commitUrl}">${shortSha}</a>: ${commitTitle}`;
			if (effect) {
				await odoo.addMessage(taskId, message, authorEmail, effect);
			} else {
				await odoo.addMessage(taskId, message, authorEmail);
			}

			result.processed++;
		} catch (error) {
			const msg = `ODP-${taskId}: ${error instanceof Error ? error.message : "Unknown error"}`;
			console.error(msg);
			result.errors.push(msg);
		}
	}

	return result;
}

export async function handlePullRequestEvent(
	event: PullRequestEvent,
	odoo: OdooClient,
	githubConfig: GitHubCommentConfig | null,
	context?: DeliveryContext,
): Promise<ProcessResult> {
	const result: ProcessResult = { processed: 0, errors: [] };

	if (!["opened", "edited", "closed", "reopened", "ready_for_review"].includes(event.action)) {
		return result;
	}

	const pr = event.pull_request;
	const textToSearch = `${pr.title}\n${pr.body ?? ""}`;
	const refs = parseReferences(textToSearch);

	console.info(
		`PR #${pr.number} action=${event.action} merged=${pr.merged} draft=${pr.draft} refs=${
			refs.map((r) => `${r.action}:ODP-${r.taskId}`).join(",") || "none"
		}`,
	);

	if (refs.length === 0) {
		return result;
	}

	const isMerged = event.action === "closed" && pr.merged;
	const isClosed = event.action === "closed" && !pr.merged;
	const isOpened =
		event.action === "opened" || event.action === "reopened" || event.action === "ready_for_review";
	const stageOrder = pullRequestStageOrder(event, isOpened, isClosed, isMerged);
	const updatedTasks: string[] = [];

	// Determine which stage to transition to based on PR action
	const getTargetStage = (refAction: "close" | "ref"): StageRef | null => {
		if (refAction !== "close") return null;
		if (isMerged) {
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
			const effect = deliveryEffect(
				context,
				"pull_request",
				ref.taskId,
				ref.action === "close" ? stageOrder : undefined,
			);
			if (effect) {
				const status = await odoo.getDeliveryEffectStatus(ref.taskId, effect);
				if (status !== "pending") continue;
			}

			const task = await odoo.getTask(ref.taskId);
			if (!task) {
				result.errors.push(`ODP-${ref.taskId}: Task not found`);
				continue;
			}

			// Only explicit closing references establish ownership. Incidental
			// references belong in chatter and never claim the primary PR link.
			if (ref.action === "close" && !task.github_pr_url) {
				await odoo.setPrimaryPullRequestUrl(ref.taskId, pr.html_url);
			}

			const doneStage = odoo.stages.done;
			const isCompleted =
				task.state === "1_done" ||
				(typeof doneStage === "number"
					? task.stage_id?.[0] === doneStage
					: task.stage_id?.[1] === doneStage);
			const isSecondaryPr = Boolean(task.github_pr_url && task.github_pr_url !== pr.html_url);
			// A new reference is not a request to reopen completed work. Secondary
			// PRs still get chatter entries, but cannot restart the primary task.
			const targetStage =
				isOpened && (isCompleted || isSecondaryPr) ? null : getTargetStage(ref.action);
			if (targetStage) {
				console.info(
					`PR #${pr.number} transitioning ODP-${ref.taskId} via action=${ref.action} to stage=${String(targetStage)}`,
				);
				await odoo.setStage(ref.taskId, targetStage);
			} else {
				console.info(
					`PR #${pr.number} no stage transition for ODP-${ref.taskId} (action=${ref.action}, event=${event.action}, merged=${pr.merged})`,
				);
			}

			const action = event.action === "closed" ? (pr.merged ? "merged" : "closed") : event.action;
			const message = `${GH_ICON} Referenced in PR <a href="${pr.html_url}">#${pr.number}</a> (${action})`;
			const authorIdentifier = pr.user.email || pr.user.login;
			if (effect) {
				await odoo.addMessage(ref.taskId, message, authorIdentifier, effect);
			} else {
				await odoo.addMessage(ref.taskId, message, authorIdentifier);
			}

			updatedTasks.push(`ODP-${ref.taskId}`);
			result.processed++;
		} catch (error) {
			const msg = `ODP-${ref.taskId}: ${error instanceof Error ? error.message : "Unknown error"}`;
			console.error(msg);
			result.errors.push(msg);
		}
	}

	if (
		githubConfig &&
		updatedTasks.length > 0 &&
		result.errors.length === 0 &&
		event.action !== "closed"
	) {
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
			// GitHub feedback is best effort. Required Odoo effects have already
			// completed and must not be replayed because a PR comment failed.
			console.error(
				`GitHub comment failed: ${error instanceof Error ? error.message : "Unknown error"}`,
			);
		}
	}

	return result;
}
