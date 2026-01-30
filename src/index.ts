import {
	type PullRequestEvent,
	type PushEvent,
	handlePullRequestEvent,
	handlePushEvent,
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
}

export default {
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
		const payload = await request.text();

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
				return undefined;
			}
		};

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
		});

		const githubConfig = env.GITHUB_TOKEN ? { token: env.GITHUB_TOKEN } : null;

		try {
			const event = JSON.parse(payload);

			if (eventType === "push") {
				const result = await handlePushEvent(event as PushEvent, odoo);
				return Response.json({
					status: "ok",
					event: "push",
					processed: result.processed,
					errors: result.errors,
				});
			}

			if (eventType === "pull_request") {
				const result = await handlePullRequestEvent(event as PullRequestEvent, odoo, githubConfig);
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
