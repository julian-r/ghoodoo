import * as Sentry from "@sentry/cloudflare";
import {
	handlePullRequestEvent,
	handlePushEvent,
	type PullRequestEvent,
	type PushEvent,
} from "./github/events.js";
import { verifyWebhookSignature } from "./github/webhook.js";
import { OdooClient } from "./odoo/client.js";

export interface Env {
	GITHUB_WEBHOOK_SECRET: string;
	GITHUB_TOKEN?: string;
	ODOO_URL: string;
	ODOO_DATABASE: string;
	ODOO_USERNAME: string;
	ODOO_API_KEY: string;
	// Stage configuration - can be ID (number) or name (string)
	ODOO_STAGE_DONE: string; // Required: stage for closes/fixes when merged
	ODOO_STAGE_IN_PROGRESS?: string; // Optional: stage when PR opened
	ODOO_STAGE_CANCELED?: string; // Optional: stage when PR closed without merge
	// User mapping - JSON object: {"github@email.com": "odoo_username"}
	ODOO_USER_MAPPING?: string; // Optional: GitHub email -> Odoo username mapping
	ODOO_DEFAULT_USER_ID?: string; // Optional: fallback Odoo user ID for posting messages
	ODOO_CF_ACCESS_CLIENT_ID?: string; // Optional: Cloudflare Access service token client ID
	ODOO_CF_ACCESS_CLIENT_SECRET?: string; // Optional: Cloudflare Access service token client secret
	SENTRY_DSN?: string; // Optional: Sentry DSN for error monitoring
	SENTRY_ENVIRONMENT?: string; // Optional: Sentry environment tag (e.g. production)
	SENTRY_RELEASE?: string; // Optional: Sentry release tag
	SENTRY_ENABLE_LOGS?: string; // Optional: true/false to capture console logs in Sentry
}

function reportProcessingErrors(eventType: string, deliveryId: string, errors: string[]): void {
	if (errors.length === 0) {
		return;
	}

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

const handler = {
	async fetch(request: Request, env: Env): Promise<Response> {
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
		if (eventType) {
			Sentry.setTag("github_event_type", eventType);
		}

		if (!eventType) {
			return new Response("Missing event type", { status: 400 });
		}

		const isValid = await verifyWebhookSignature(payload, signature, env.GITHUB_WEBHOOK_SECRET);
		if (!isValid) {
			return new Response("Invalid signature", { status: 401 });
		}

		const parseStageRef = (value: string): number | string => {
			const num = Number.parseInt(value, 10);
			return Number.isNaN(num) ? value : num;
		};

		const parseUserMapping = (json?: string): Record<string, string> | undefined => {
			if (!json) return undefined;
			try {
				return JSON.parse(json) as Record<string, string>;
			} catch {
				console.error("Invalid ODOO_USER_MAPPING JSON");
				Sentry.captureMessage("Invalid ODOO_USER_MAPPING JSON", {
					level: "error",
					tags: {
						github_event_type: eventType,
						github_delivery_id: deliveryId,
					},
				});
				return undefined;
			}
		};

		const hasAccessClientId = Boolean(env.ODOO_CF_ACCESS_CLIENT_ID);
		const hasAccessClientSecret = Boolean(env.ODOO_CF_ACCESS_CLIENT_SECRET);
		if (hasAccessClientId !== hasAccessClientSecret) {
			console.warn(
				"Incomplete Cloudflare Access config: both ODOO_CF_ACCESS_CLIENT_ID and ODOO_CF_ACCESS_CLIENT_SECRET must be set",
			);
			Sentry.captureMessage("Incomplete Cloudflare Access config", {
				level: "warning",
				tags: {
					github_event_type: eventType,
					github_delivery_id: deliveryId,
				},
			});
		}

		const odoo = new OdooClient({
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
			userMapping: parseUserMapping(env.ODOO_USER_MAPPING),
			defaultUserId: env.ODOO_DEFAULT_USER_ID
				? Number.parseInt(env.ODOO_DEFAULT_USER_ID, 10)
				: undefined,
			accessClientId:
				hasAccessClientId && hasAccessClientSecret ? env.ODOO_CF_ACCESS_CLIENT_ID : undefined,
			accessClientSecret:
				hasAccessClientId && hasAccessClientSecret ? env.ODOO_CF_ACCESS_CLIENT_SECRET : undefined,
		});

		const githubConfig = env.GITHUB_TOKEN ? { token: env.GITHUB_TOKEN } : null;

		try {
			const event = JSON.parse(payload);

			if (eventType === "push") {
				const result = await handlePushEvent(event as PushEvent, odoo);
				reportProcessingErrors(eventType, deliveryId, result.errors);
				return Response.json({
					status: "ok",
					event: "push",
					processed: result.processed,
					errors: result.errors,
				});
			}

			if (eventType === "pull_request") {
				const result = await handlePullRequestEvent(event as PullRequestEvent, odoo, githubConfig);
				reportProcessingErrors(eventType, deliveryId, result.errors);
				return Response.json({
					status: "ok",
					event: "pull_request",
					processed: result.processed,
					errors: result.errors,
				});
			}

			if (eventType === "ping") {
				return Response.json({ status: "ok", event: "ping" });
			}

			return Response.json({ status: "ok", event: eventType, message: "Event type not handled" });
		} catch (error) {
			console.error("Handler error:", error);
			Sentry.captureException(error, {
				tags: {
					github_event_type: eventType,
					github_delivery_id: deliveryId,
				},
				extra: {
					payloadSize: payload.length,
				},
			});
			return Response.json(
				{
					status: "error",
					message: error instanceof Error ? error.message : "Unknown error",
				},
				{ status: 500 },
			);
		}
	},
};

export default Sentry.withSentry((env: Env) => {
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
