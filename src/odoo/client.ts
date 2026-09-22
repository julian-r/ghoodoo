import { type FetchLike, NetworkError, type OdooProtocol, OdooClient as VodooClient } from "vodoo";
import type { OdooMessageSubtype, OdooStage, OdooTask, OdooUser } from "./types.js";

// Stage can be specified by ID (number) or name (string)
export type StageRef = number | string;

export interface StageConfig {
	done: StageRef; // Required: stage for closes/fixes when merged
	inProgress?: StageRef; // Optional: stage when PR opened
	canceled?: StageRef; // Optional: stage when PR closed without merge
}

// User mapping: GitHub email -> Odoo email
export type UserMapping = Record<string, string>;

export interface OdooConfig {
	url: string;
	database: string;
	username: string; // Login email for the API user
	apiKey: string;
	stages: StageConfig;
	userMapping?: UserMapping; // Optional: GitHub email -> Odoo email
	defaultUserId?: number; // Optional: fallback user ID for posting messages
	accessClientId?: string; // Optional: Cloudflare Access service token client ID
	accessClientSecret?: string; // Optional: Cloudflare Access service token client secret
	protocol?: OdooProtocol;
}

/**
 * Ghoodoo-specific adapter around the public Vodoo SDK.
 *
 * It keeps the small API consumed by the GitHub event handlers while delegating
 * authentication, transport, retries, and generic Odoo operations to Vodoo.
 */
export class OdooClient {
	private readonly config: OdooConfig;
	private readonly client: VodooClient;
	private readonly partnerIdCache = new Map<string, number>();
	private subtypeCache: number | null = null;

	constructor(config: OdooConfig) {
		this.config = config;

		const headers: Record<string, string> = {};
		if (config.accessClientId && config.accessClientSecret) {
			headers["CF-Access-Client-Id"] = config.accessClientId;
			headers["CF-Access-Client-Secret"] = config.accessClientSecret;
		}

		this.client = new VodooClient(
			{
				url: config.url,
				database: config.database,
				username: config.username,
				password: config.apiKey,
				defaultUserId: config.defaultUserId,
				retry: { maxRetries: 5 },
				headers,
			},
			{
				// Preserve the existing Worker's legacy transport by default while
				// allowing callers to opt into Vodoo's JSON-2 or auto-detection modes.
				protocol: config.protocol ?? "jsonrpc",
				fetch: this.fetchWithDiagnostics,
			},
		);
	}

	private readonly fetchWithDiagnostics: FetchLike = async (input, init) => {
		const response = await globalThis.fetch(input, { ...init, redirect: "manual" });

		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get("location") ?? "(unknown location)";
			const compactLocation = this.toPreview(location, 220);
			const isAccessLoginRedirect =
				location.includes("cloudflareaccess.com") || location.includes("/cdn-cgi/access/login");
			const hint = isAccessLoginRedirect
				? "Cloudflare Access login redirect detected. Configure ODOO_CF_ACCESS_CLIENT_ID and ODOO_CF_ACCESS_CLIENT_SECRET (service token), or allow this Worker in Access policy."
				: "Unexpected redirect from Odoo endpoint.";
			return this.diagnosticErrorResponse(
				`Odoo request redirected (HTTP ${response.status}) to ${compactLocation}. ${hint}`,
			);
		}

		// Vodoo retries NetworkError for idempotent reads only. Converting these
		// transient responses here preserves safe retries without retrying writes.
		if (response.status === 429 || response.status >= 500) {
			throw new NetworkError(`Odoo HTTP error: ${response.status} ${response.statusText}`);
		}

		if (response.ok) {
			const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
			const responseText = await response.clone().text();
			try {
				JSON.parse(responseText);
			} catch {
				const bodyPreview = this.toPreview(responseText);
				const kind =
					contentType && !contentType.includes("application/json")
						? `non-JSON response (content-type: ${contentType}, HTTP ${response.status})`
						: `invalid JSON response (HTTP ${response.status})`;
				return this.diagnosticErrorResponse(
					`Odoo returned ${kind}${bodyPreview ? `. Body starts with: ${bodyPreview}` : ""}`,
				);
			}
		}

		return response;
	};

	private diagnosticErrorResponse(message: string): Response {
		return Response.json({
			jsonrpc: "2.0",
			id: null,
			error: { code: -1, message, data: { message } },
		});
	}

	private toPreview(text: string, max = 140): string {
		const compact = text.replace(/\s+/g, " ").trim();
		if (!compact) return "";
		return compact.length > max ? `${compact.slice(0, max)}…` : compact;
	}

	async getTask(id: number): Promise<OdooTask | null> {
		const result = await this.client.searchRead("project.task", {
			domain: [["id", "=", id]],
			fields: ["id", "name", "stage_id"],
			limit: 1,
		});
		return result.length > 0 ? (result[0] as OdooTask) : null;
	}

	async getUserByEmail(email: string): Promise<OdooUser | null> {
		const result = await this.client.searchRead("res.users", {
			domain: ["|", ["email", "=", email], ["login", "=", email]],
			fields: ["id", "name", "login", "email", "partner_id"],
			limit: 1,
		});
		return result.length > 0 ? (result[0] as OdooUser) : null;
	}

	async getPartnerIdForUser(userId: number): Promise<number | null> {
		const result = await this.client.read("res.users", [userId], ["partner_id"]);
		const partner = result[0]?.partner_id;
		return Array.isArray(partner) && typeof partner[0] === "number" ? partner[0] : null;
	}

	private async getNoteSubtypeId(): Promise<number | null> {
		if (this.subtypeCache !== null) return this.subtypeCache;

		const result = await this.client.searchRead("mail.message.subtype", {
			domain: [["name", "=", "Note"]],
			fields: ["id", "name"],
			limit: 1,
		});
		const subtype = result[0] as OdooMessageSubtype | undefined;
		this.subtypeCache = subtype?.id ?? null;
		return this.subtypeCache;
	}

	async resolveAuthorLink(
		email?: string,
		githubUsername?: string,
		fallbackName?: string,
	): Promise<string> {
		if (email) {
			const odooEmail = this.config.userMapping?.[email] ?? email;
			const user = await this.getUserByEmail(odooEmail);
			if (user) {
				const userName = user.name || user.login;
				return `<a href="${this.config.url}/web#id=${user.id}&model=res.users">@${userName}</a>`;
			}
		}

		if (githubUsername) {
			return `<a href="https://github.com/${githubUsername}">@${githubUsername}</a>`;
		}
		return fallbackName || "unknown";
	}

	async resolveAuthorPartnerId(identifier?: string): Promise<number | null> {
		if (!identifier) {
			return this.config.defaultUserId ? this.getPartnerIdForUser(this.config.defaultUserId) : null;
		}

		if (this.partnerIdCache.has(identifier)) {
			return this.partnerIdCache.get(identifier) ?? null;
		}

		const odooEmail = this.config.userMapping?.[identifier] ?? identifier;
		const user = await this.getUserByEmail(odooEmail);
		if (user?.partner_id) {
			const partnerId = Array.isArray(user.partner_id) ? user.partner_id[0] : null;
			if (partnerId) {
				this.partnerIdCache.set(identifier, partnerId);
				return partnerId;
			}
		}

		if (this.config.defaultUserId) {
			const partnerId = await this.getPartnerIdForUser(this.config.defaultUserId);
			if (partnerId) {
				this.partnerIdCache.set(identifier, partnerId);
				return partnerId;
			}
		}

		return null;
	}

	async addMessage(taskId: number, body: string, authorIdentifier?: string): Promise<number> {
		const authorPartnerId = await this.resolveAuthorPartnerId(authorIdentifier);
		const subtypeId = await this.getNoteSubtypeId();
		const messageData: Record<string, unknown> = {
			model: "project.task",
			res_id: taskId,
			body,
			message_type: "notification",
			subtype_id: subtypeId || false,
		};
		if (authorPartnerId) messageData.author_id = authorPartnerId;
		return this.client.create("mail.message", messageData);
	}

	async resolveStage(ref: StageRef): Promise<number | null> {
		if (typeof ref === "number") return ref;

		const result = await this.client.searchRead("project.task.type", {
			domain: [["name", "=", ref]],
			fields: ["id", "name"],
			limit: 1,
		});
		const stage = result[0] as OdooStage | undefined;
		return stage?.id ?? null;
	}

	async setStage(taskId: number, stageRef?: StageRef): Promise<boolean> {
		const ref = stageRef ?? this.config.stages.done;
		const stageId = await this.resolveStage(ref);
		if (stageId === null) throw new Error(`Stage not found: ${ref}`);

		const updated = await this.client.tasks.set(taskId, { stage_id: stageId });
		if (!updated) {
			throw new Error(
				`Stage update returned false for task ${taskId} -> stage ${stageId} (ref: ${String(ref)})`,
			);
		}
		return updated;
	}

	get stages(): StageConfig {
		return this.config.stages;
	}
}
