import type {
	AuthorInfo,
	JsonRpcRequest,
	JsonRpcResponse,
	OdooMessageSubtype,
	OdooStage,
	OdooTask,
	OdooUser,
} from "./types.js";

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
	apiKey: string;
	stages: StageConfig;
	userMapping?: UserMapping; // Optional: GitHub email -> Odoo email
	defaultUserId?: number; // Optional: fallback user ID for posting messages
}

export class OdooClient {
	private config: OdooConfig;
	private requestId = 0;
	private partnerIdCache = new Map<string, number>(); // email -> partner_id
	private subtypeCache: number | null = null; // Note subtype ID

	constructor(config: OdooConfig) {
		this.config = config;
	}

	private async rpc<T>(
		endpoint: string,
		method: string,
		params: Record<string, unknown>,
		retries = 5,
	): Promise<T> {
		const request: JsonRpcRequest = {
			jsonrpc: "2.0",
			method,
			params,
			id: ++this.requestId,
		};

		let lastError: Error | null = null;

		for (let attempt = 0; attempt <= retries; attempt++) {
			try {
				if (attempt > 0) {
					// Exponential backoff: 500ms, 1000ms, 2000ms
					const delay = 500 * 2 ** (attempt - 1);
					await new Promise((resolve) => setTimeout(resolve, delay));
				}

				const response = await fetch(`${this.config.url}${endpoint}`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${this.config.apiKey}`,
					},
					body: JSON.stringify(request),
				});

				// Retry on 5xx or 429 (rate limit)
				if (response.status >= 500 || response.status === 429) {
					lastError = new Error(`Odoo HTTP error: ${response.status} ${response.statusText}`);
					continue;
				}

				if (!response.ok) {
					throw new Error(`Odoo HTTP error: ${response.status} ${response.statusText}`);
				}

				const json = (await response.json()) as JsonRpcResponse<T>;

				if (json.error) {
					throw new Error(`Odoo RPC error: ${json.error.message}`);
				}

				return json.result as T;
			} catch (error) {
				// Retry on network errors
				if (error instanceof TypeError && error.message.includes("fetch")) {
					lastError = error;
					continue;
				}
				throw error;
			}
		}

		throw lastError ?? new Error("Odoo RPC failed after retries");
	}

	async getTask(id: number): Promise<OdooTask | null> {
		const result = await this.rpc<OdooTask[]>("/jsonrpc", "call", {
			service: "object",
			method: "execute_kw",
			args: [
				this.config.database,
				2, // uid placeholder - API key auth handles this
				this.config.apiKey,
				"project.task",
				"search_read",
				[[["id", "=", id]]],
				{ fields: ["id", "name", "stage_id"], limit: 1 },
			],
		});

		return result.length > 0 ? result[0] : null;
	}

	async getUserByEmail(email: string): Promise<OdooUser | null> {
		// Search by email OR login (login is often an email address in Odoo)
		const result = await this.rpc<OdooUser[]>("/jsonrpc", "call", {
			service: "object",
			method: "execute_kw",
			args: [
				this.config.database,
				2,
				this.config.apiKey,
				"res.users",
				"search_read",
				[["|", ["email", "=", email], ["login", "=", email]]],
				{ fields: ["id", "name", "login", "email", "partner_id"], limit: 1 },
			],
		});

		return result.length > 0 ? result[0] : null;
	}

	async getPartnerIdForUser(userId: number): Promise<number | null> {
		const result = await this.rpc<OdooUser[]>("/jsonrpc", "call", {
			service: "object",
			method: "execute_kw",
			args: [
				this.config.database,
				2,
				this.config.apiKey,
				"res.users",
				"read",
				[[userId], ["partner_id"]],
			],
		});

		if (result.length === 0 || !result[0].partner_id) {
			return null;
		}

		// partner_id is returned as [id, name] tuple
		return Array.isArray(result[0].partner_id) ? result[0].partner_id[0] : null;
	}

	private async getNoteSubtypeId(): Promise<number | null> {
		if (this.subtypeCache !== null) {
			return this.subtypeCache;
		}

		const result = await this.rpc<OdooMessageSubtype[]>("/jsonrpc", "call", {
			service: "object",
			method: "execute_kw",
			args: [
				this.config.database,
				2,
				this.config.apiKey,
				"mail.message.subtype",
				"search_read",
				[[["name", "=", "Note"]]],
				{ fields: ["id", "name"], limit: 1 },
			],
		});

		this.subtypeCache = result.length > 0 ? result[0].id : null;
		return this.subtypeCache;
	}

	async resolveAuthorLink(
		email?: string,
		githubUsername?: string,
		fallbackName?: string,
	): Promise<string> {
		// Try to find Odoo user by email
		if (email) {
			const mapping = this.config.userMapping;
			const odooEmail = mapping?.[email] ?? email;
			const user = await this.getUserByEmail(odooEmail);

			if (user) {
				const userName = user.name || user.login;
				// Link to Odoo user profile
				return `<a href="${this.config.url}/web#id=${user.id}&model=res.users">@${userName}</a>`;
			}
		}

		// Fallback to GitHub link if username available
		if (githubUsername) {
			return `<a href="https://github.com/${githubUsername}">@${githubUsername}</a>`;
		}

		// Last resort: just show the name
		return fallbackName || "unknown";
	}

	async resolveAuthorPartnerId(email?: string): Promise<number | null> {
		if (!email) {
			// Use default user if configured
			if (this.config.defaultUserId) {
				return this.getPartnerIdForUser(this.config.defaultUserId);
			}
			return null;
		}

		// Check cache first
		if (this.partnerIdCache.has(email)) {
			return this.partnerIdCache.get(email) ?? null;
		}

		// Use mapped email if configured, otherwise use original email
		const mapping = this.config.userMapping;
		const odooEmail = mapping?.[email] ?? email;

		// Look up user by email (searches both email and login fields)
		const user = await this.getUserByEmail(odooEmail);
		if (user?.partner_id) {
			const partnerId = Array.isArray(user.partner_id) ? user.partner_id[0] : null;
			if (partnerId) {
				this.partnerIdCache.set(email, partnerId);
				return partnerId;
			}
		}

		// Fallback to default user
		if (this.config.defaultUserId) {
			const partnerId = await this.getPartnerIdForUser(this.config.defaultUserId);
			if (partnerId) {
				this.partnerIdCache.set(email, partnerId);
				return partnerId;
			}
		}

		return null;
	}

	async addMessage(taskId: number, body: string, authorEmail?: string): Promise<number> {
		// Try to resolve author for posting as specific user
		const authorPartnerId = await this.resolveAuthorPartnerId(authorEmail);
		const subtypeId = await this.getNoteSubtypeId();

		// Always create message directly in mail.message to preserve HTML formatting
		// (message_post escapes HTML content)
		const messageData: Record<string, unknown> = {
			model: "project.task",
			res_id: taskId,
			body,
			message_type: "comment",
			subtype_id: subtypeId || false,
		};

		if (authorPartnerId) {
			messageData.author_id = authorPartnerId;
		}

		return this.rpc<number>("/jsonrpc", "call", {
			service: "object",
			method: "execute_kw",
			args: [
				this.config.database,
				2,
				this.config.apiKey,
				"mail.message",
				"create",
				[messageData],
			],
		});
	}

	async resolveStage(ref: StageRef): Promise<number | null> {
		if (typeof ref === "number") {
			return ref;
		}

		// Search by name
		const result = await this.rpc<OdooStage[]>("/jsonrpc", "call", {
			service: "object",
			method: "execute_kw",
			args: [
				this.config.database,
				2,
				this.config.apiKey,
				"project.task.type",
				"search_read",
				[[["name", "=", ref]]],
				{ fields: ["id", "name"], limit: 1 },
			],
		});

		return result.length > 0 ? result[0].id : null;
	}

	async setStage(taskId: number, stageRef?: StageRef): Promise<boolean> {
		const ref = stageRef ?? this.config.stages.done;
		const stageId = await this.resolveStage(ref);

		if (stageId === null) {
			throw new Error(`Stage not found: ${ref}`);
		}

		return this.rpc<boolean>("/jsonrpc", "call", {
			service: "object",
			method: "execute_kw",
			args: [
				this.config.database,
				2,
				this.config.apiKey,
				"project.task",
				"write",
				[[taskId], { stage_id: stageId }],
			],
		});
	}

	get stages(): StageConfig {
		return this.config.stages;
	}
}
