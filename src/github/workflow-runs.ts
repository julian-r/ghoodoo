import type { DeliveryEffect, OdooClient } from "../odoo/client.js";
import type { DeliveryContext, ProcessResult } from "./events.js";

export interface WorkflowRunEvent {
	action: string;
	workflow_run: {
		id: number;
		run_attempt: number;
		run_number: number;
		name: string;
		event: string;
		conclusion: string | null;
		head_branch: string | null;
		head_sha: string;
		html_url: string;
	};
	repository: {
		full_name: string;
		default_branch: string;
	};
}

/** Scheduled workflows whose failed runs become Odoo tasks in one project. */
export interface WorkflowFailureConfig {
	projectId: number;
	/** `owner/repo:Workflow name` entries. */
	workflows: Set<string>;
}

const FAILED_CONCLUSIONS = new Set(["failure", "timed_out", "startup_failure"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** The fields this module reads, with their types; anything else is a malformed payload. */
export function isWorkflowRunEvent(value: unknown): value is WorkflowRunEvent {
	if (!isRecord(value) || typeof value.action !== "string") return false;
	const run = value.workflow_run;
	const repository = value.repository;
	if (!isRecord(run) || !isRecord(repository)) return false;
	const stringOrNull = (field: unknown) => typeof field === "string" || field === null;
	return (
		Number.isSafeInteger(run.id) &&
		Number.isSafeInteger(run.run_attempt) &&
		Number.isSafeInteger(run.run_number) &&
		typeof run.name === "string" &&
		typeof run.event === "string" &&
		stringOrNull(run.conclusion) &&
		stringOrNull(run.head_branch) &&
		typeof run.head_sha === "string" &&
		typeof run.html_url === "string" &&
		typeof repository.full_name === "string" &&
		typeof repository.default_branch === "string"
	);
}

/** Both settings are required; without them the feature is off. */
export function parseWorkflowFailureConfig(
	projectId: string | undefined,
	workflows: string | undefined,
): WorkflowFailureConfig | null {
	const id = Number.parseInt(projectId ?? "", 10);
	const entries = (workflows ?? "")
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
	if (!Number.isSafeInteger(id) || id <= 0 || entries.length === 0) return null;
	return { projectId: id, workflows: new Set(entries) };
}

/** A failed scheduled run of a configured workflow on the repository's default branch. */
export function isTrackedWorkflowFailure(
	event: WorkflowRunEvent,
	config: WorkflowFailureConfig,
): boolean {
	const run = event.workflow_run;
	return (
		event.action === "completed" &&
		FAILED_CONCLUSIONS.has(run.conclusion ?? "") &&
		run.event === "schedule" &&
		run.head_branch === event.repository.default_branch &&
		config.workflows.has(`${event.repository.full_name}:${run.name}`)
	);
}

/** Only the fields the consumer reads, so a queued message stays small. */
export function compactWorkflowRunEvent(event: WorkflowRunEvent): WorkflowRunEvent {
	const run = event.workflow_run;
	return {
		action: event.action,
		workflow_run: {
			id: run.id,
			run_attempt: run.run_attempt,
			run_number: run.run_number,
			name: run.name,
			event: run.event,
			conclusion: run.conclusion,
			head_branch: run.head_branch,
			head_sha: run.head_sha,
			html_url: run.html_url,
		},
		repository: {
			full_name: event.repository.full_name,
			default_branch: event.repository.default_branch,
		},
	};
}

export function workflowFailureTaskName(repository: string, workflow: string): string {
	return `Scheduled workflow failed: ${repository} · ${workflow}`;
}

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

async function workflowKey(repository: string, workflow: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(`${repository}:${workflow}`),
	);
	return Array.from(new Uint8Array(digest).slice(0, 8), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

/**
 * One open task per workflow: the first failed run creates it, every failed run adds one note.
 * Two markers identify the workflow and the run: the notes' message IDs
 * (`workflow-failure-<workflow hash>-run-<id>-<attempt>`), which users cannot edit, and the same
 * keys in brackets in the description of a task this module creates, which cover the gap between
 * creating a task and writing its first note. A renamed task still collects the notes, and a retry
 * creates nothing twice.
 */
export async function handleWorkflowRunEvent(
	event: WorkflowRunEvent,
	odoo: OdooClient,
	config: WorkflowFailureConfig,
	_context: DeliveryContext,
): Promise<ProcessResult> {
	const run = event.workflow_run;
	const repository = event.repository.full_name;
	const name = workflowFailureTaskName(repository, run.name);

	try {
		const workflow = `workflow-failure-${await workflowKey(repository, run.name)}`;
		const effect: DeliveryEffect = { id: `${workflow}-run-${run.id}-${run.run_attempt}` };
		// The run is noted already, maybe on a task closed since: nothing to do.
		if ((await odoo.findTaskByEffect(effect.id, "exact")) !== null) {
			return { processed: 1, errors: [] };
		}
		// A retry after this attempt created its task but did not note it: note it there, even if the
		// task was closed, archived or moved since.
		let taskId = await odoo.findTaskByDescription(`[${effect.id}]`);
		taskId ??= await odoo.findOpenTask(config.projectId, `${workflow}-run-`, `[${workflow}]`);
		taskId ??= await odoo.createTask({
			project_id: config.projectId,
			name,
			description:
				`<p>The scheduled <b>${escapeHtml(run.name)}</b> workflow of ` +
				`<b>${escapeHtml(repository)}</b> failed on its default branch, first in ` +
				`<a href="${escapeHtml(run.html_url)}">${escapeHtml(run.html_url)}</a>. ` +
				"Each failed run adds a note below. Close this task when the cause is fixed; " +
				"the next failed run opens a new one.</p>" +
				`<p>Ghoodoo keys: [${workflow}] [${effect.id}]</p>`,
		});
		const attempt = run.run_attempt > 1 ? `, attempt ${run.run_attempt}` : "";
		await odoo.addMessage(
			taskId,
			`<p>Scheduled run <a href="${escapeHtml(run.html_url)}">#${run.run_number}${attempt}</a> ` +
				`ended with <b>${escapeHtml(run.conclusion ?? "unknown")}</b> on ` +
				`<code>${escapeHtml(run.head_branch ?? "")}</code> at <code>${escapeHtml(run.head_sha.slice(0, 7))}</code>.</p>`,
			undefined,
			effect,
		);
		return { processed: 1, errors: [] };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { processed: 0, errors: [`${name}: ${message}`] };
	}
}
