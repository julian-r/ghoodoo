import * as Sentry from "@sentry/cloudflare";
import {
	handlePullRequestEvent,
	handlePushEvent,
	type ProcessResult,
	type PullRequestEvent,
	type PushEvent,
} from "./github/events.js";
import { verifyWebhookSignature } from "./github/webhook.js";
import { OdooClient } from "./odoo/client.js";

export interface GhoodooEnv extends Cloudflare.Env {
	GITHUB_EVENTS_QUEUE: Queue<GitHubEventMessage>;
	GITHUB_TOKEN?: string;
	ODOO_URL: string;
	ODOO_DATABASE: string;
	ODOO_USERNAME: string;
	ODOO_STAGE_DONE: string;
	ODOO_STAGE_IN_PROGRESS?: string;
	ODOO_STAGE_CANCELED?: string;
	ODOO_USER_MAPPING?: string;
	ODOO_DEFAULT_USER_ID?: string;
	ODOO_CF_ACCESS_CLIENT_ID?: string;
	ODOO_CF_ACCESS_CLIENT_SECRET?: string;
	SENTRY_DSN?: string;
	SENTRY_ENVIRONMENT?: string;
	SENTRY_RELEASE?: string;
	SENTRY_ENABLE_LOGS?: string;
}

// Backwards-compatible type export for tests and consumers.
export type Env = GhoodooEnv;

export type GitHubEventMessage =
	| {
			eventType: "push";
			deliveryId: string;
			event: PushEvent;
	  }
	| {
			eventType: "pull_request";
			deliveryId: string;
			event: PullRequestEvent;
	  };

function reportProcessingErrors(eventType: string, deliveryId: string, errors: string[]): void {
	if (errors.length === 0) return;

	Sentry.captureMessage(`${eventType} processing completed with ${errors.length} error(s)`, {
		level: "warning",
		tags: {
			github_event_type: eventType,
			github_delivery_id: deliveryId,
		},
		extra: {
			deliveryId,
			errors,
			errorCount: errors.length,
		},
	});
}

function parseStageRef(value: string): number | string {
	const num = Number.parseInt(value, 10);
	return Number.isNaN(num) ? value : num;
}

function parseUserMapping(
	json: string | undefined,
	eventType: string,
	deliveryId: string,
): Record<string, string> | undefined {
	if (!json) return undefined;
	try {
		return JSON.parse(json) as Record<string, string>;
	} catch {
		console.error(
			JSON.stringify({ message: "Invalid ODOO_USER_MAPPING JSON", eventType, deliveryId }),
		);
		Sentry.captureMessage("Invalid ODOO_USER_MAPPING JSON", {
			level: "error",
			tags: {
				github_event_type: eventType,
				github_delivery_id: deliveryId,
			},
		});
		return undefined;
	}
}

function createOdooClient(env: GhoodooEnv, eventType: string, deliveryId: string): OdooClient {
	const hasAccessClientId = Boolean(env.ODOO_CF_ACCESS_CLIENT_ID);
	const hasAccessClientSecret = Boolean(env.ODOO_CF_ACCESS_CLIENT_SECRET);
	if (hasAccessClientId !== hasAccessClientSecret) {
		console.warn(
			JSON.stringify({
				message:
					"Incomplete Cloudflare Access config: both ODOO_CF_ACCESS_CLIENT_ID and ODOO_CF_ACCESS_CLIENT_SECRET must be set",
				eventType,
				deliveryId,
			}),
		);
		Sentry.captureMessage("Incomplete Cloudflare Access config", {
			level: "warning",
			tags: {
				github_event_type: eventType,
				github_delivery_id: deliveryId,
			},
		});
	}

	return new OdooClient({
		url: env.ODOO_URL,
		database: env.ODOO_DATABASE,
		username: env.ODOO_USERNAME,
		apiKey: env.ODOO_API_KEY,
		stages: {
			done: parseStageRef(env.ODOO_STAGE_DONE),
			inProgress: env.ODOO_STAGE_IN_PROGRESS
				? parseStageRef(env.ODOO_STAGE_IN_PROGRESS)
				: undefined,
			canceled: env.ODOO_STAGE_CANCELED ? parseStageRef(env.ODOO_STAGE_CANCELED) : undefined,
		},
		userMapping: parseUserMapping(env.ODOO_USER_MAPPING, eventType, deliveryId),
		defaultUserId: env.ODOO_DEFAULT_USER_ID
			? Number.parseInt(env.ODOO_DEFAULT_USER_ID, 10)
			: undefined,
		accessClientId:
			hasAccessClientId && hasAccessClientSecret ? env.ODOO_CF_ACCESS_CLIENT_ID : undefined,
		accessClientSecret:
			hasAccessClientId && hasAccessClientSecret ? env.ODOO_CF_ACCESS_CLIENT_SECRET : undefined,
	});
}

async function processQueuedEvent(
	message: GitHubEventMessage,
	env: GhoodooEnv,
): Promise<ProcessResult> {
	const { eventType, deliveryId } = message;
	Sentry.setTag("github_delivery_id", deliveryId);
	Sentry.setTag("github_event_type", eventType);

	const odoo = createOdooClient(env, eventType, deliveryId);
	const result =
		eventType === "push"
			? await handlePushEvent(message.event, odoo)
			: await handlePullRequestEvent(
					message.event,
					odoo,
					env.GITHUB_TOKEN ? { token: env.GITHUB_TOKEN } : null,
				);

	reportProcessingErrors(eventType, deliveryId, result.errors);
	if (result.errors.length > 0) {
		throw new Error(`Event processing failed: ${result.errors.join("; ")}`);
	}
	return result;
}

export const handler = {
	async fetch(request: Request, env: GhoodooEnv): Promise<Response> {
		if (request.method !== "POST") {
			return new Response("Method not allowed", { status: 405 });
		}

		const url = new URL(request.url);
		if (url.pathname !== "/webhook") {
			return new Response("Not found", { status: 404 });
		}

		const signature = request.headers.get("x-hub-signature-256");
		const eventType = request.headers.get("x-github-event");
		const deliveryId = request.headers.get("x-github-delivery") ?? "unknown";
		const payload = await request.text();

		Sentry.setTag("github_delivery_id", deliveryId);
		if (eventType) Sentry.setTag("github_event_type", eventType);

		if (!eventType) {
			return new Response("Missing event type", { status: 400 });
		}

		const isValid = await verifyWebhookSignature(payload, signature, env.GITHUB_WEBHOOK_SECRET);
		if (!isValid) {
			return new Response("Invalid signature", { status: 401 });
		}

		if (eventType === "ping") {
			return Response.json({ status: "ok", event: "ping" });
		}

		if (eventType !== "push" && eventType !== "pull_request") {
			return Response.json({ status: "ok", event: eventType, message: "Event type not handled" });
		}

		let event: PushEvent | PullRequestEvent;
		try {
			event = JSON.parse(payload) as PushEvent | PullRequestEvent;
		} catch (error) {
			Sentry.captureException(error, {
				tags: {
					github_event_type: eventType,
					github_delivery_id: deliveryId,
				},
				extra: { payloadSize: payload.length },
			});
			return Response.json({ status: "error", message: "Invalid JSON payload" }, { status: 400 });
		}

		try {
			const queuedEvent: GitHubEventMessage =
				eventType === "push"
					? { eventType, deliveryId, event: event as PushEvent }
					: { eventType, deliveryId, event: event as PullRequestEvent };
			await env.GITHUB_EVENTS_QUEUE.send(queuedEvent);
			return Response.json({ status: "queued", event: eventType, deliveryId }, { status: 202 });
		} catch (error) {
			console.error(
				JSON.stringify({
					message: "Failed to enqueue GitHub event",
					eventType,
					deliveryId,
					error: error instanceof Error ? error.message : String(error),
				}),
			);
			Sentry.captureException(error, {
				tags: {
					github_event_type: eventType,
					github_delivery_id: deliveryId,
				},
			});
			return Response.json(
				{ status: "error", message: "Failed to enqueue event" },
				{ status: 503 },
			);
		}
	},

	async queue(batch: MessageBatch<GitHubEventMessage>, env: GhoodooEnv): Promise<void> {
		for (const message of batch.messages) {
			try {
				const result = await processQueuedEvent(message.body, env);
				message.ack();
				console.info(
					JSON.stringify({
						message: "GitHub event processed",
						eventType: message.body.eventType,
						deliveryId: message.body.deliveryId,
						processed: result.processed,
						attempts: message.attempts,
					}),
				);
			} catch (error) {
				message.retry();
				console.error(
					JSON.stringify({
						message: "Queued GitHub event failed",
						eventType: message.body.eventType,
						deliveryId: message.body.deliveryId,
						attempts: message.attempts,
						error: error instanceof Error ? error.message : String(error),
					}),
				);
				Sentry.captureException(error, {
					tags: {
						github_event_type: message.body.eventType,
						github_delivery_id: message.body.deliveryId,
					},
					extra: { queueMessageId: message.id, attempts: message.attempts },
				});
			}
		}
	},
} satisfies ExportedHandler<GhoodooEnv, GitHubEventMessage>;

// Export uninstrumented entry points for hermetic unit tests.
export const handleWebhook = handler.fetch;
export const handleQueue = handler.queue;

export default Sentry.withSentry<GhoodooEnv, GitHubEventMessage>((env: GhoodooEnv) => {
	const enableLogs =
		env.SENTRY_ENABLE_LOGS !== undefined
			? ["1", "true", "yes", "on"].includes(env.SENTRY_ENABLE_LOGS.toLowerCase())
			: Boolean(env.SENTRY_DSN);

	return {
		dsn: env.SENTRY_DSN,
		enabled: Boolean(env.SENTRY_DSN),
		environment: env.SENTRY_ENVIRONMENT,
		release: env.SENTRY_RELEASE,
		sendDefaultPii: false,
		enableLogs,
		integrations: enableLogs
			? [Sentry.consoleLoggingIntegration({ levels: ["log", "info", "warn", "error"] })]
			: undefined,
	};
}, handler);
