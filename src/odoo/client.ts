import type {
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
	username: string; // Login email for the API user
	apiKey: string;
	stages: StageConfig;
	userMapping?: UserMapping; // Optional: GitHub email -> Odoo email
	defaultUserId?: number; // Optional: fallback user ID for posting messages
	accessClientId?: string; // Optional: Cloudflare Access service token client ID
	accessClientSecret?: string; // Optional: Cloudflare Access service token client secret
}

export class OdooClient {
	private config: OdooConfig;
	private requestId = 0;
	private partnerIdCache = new Map<string, number>(); // email -> partner_id
	private subtypeCache: number | null = null; // Note subtype ID
	private uidCache: number | null = null; // Authenticated user ID

	constructor(config: OdooConfig) {
		this.config = config;
	}

	private buildHeaders(includeApiAuth = true): Record<string, string> {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
		};

		if (includeApiAuth) {
			headers.Authorization = `Bearer ${this.config.apiKey}`;
		}

		if (this.config.accessClientId && this.config.accessClientSecret) {
			headers["CF-Access-Client-Id"] = this.config.accessClientId;
			headers["CF-Access-Client-Secret"] = this.config.accessClientSecret;
		}

		return headers;
	}

	private toPreview(text: string, max = 140): string {
		const compact = text.replace(/\s+/g, " ").trim();
		if (!compact) {
			return "";
		}
		return compact.length > max ? `${compact.slice(0, max)}…` : compact;
	}

	private async readResponsePreview(response: Response, max = 140): Promise<string> {
		const text = await response.text();
		return this.toPreview(text, max);
	}

	private getRedirectError(response: Response): Error {
		const location = response.headers.get("location") ?? "(unknown location)";
		const compactLocation = this.toPreview(location, 220);
		const isAccessLoginRedirect =
			location.includes("cloudflareaccess.com") || location.includes("/cdn-cgi/access/login");

		const hint = isAccessLoginRedirect
			? "Cloudflare Access login redirect detected. Configure ODOO_CF_ACCESS_CLIENT_ID and ODOO_CF_ACCESS_CLIENT_SECRET (service token), or allow this Worker in Access policy."
			: "Unexpected redirect from Odoo endpoint.";

		return new Error(
			`Odoo request redirected (HTTP ${response.status}) to ${compactLocation}. ${hint}`,
		);
	}

	private async parseJsonRpcResponse<T>(
		response: Response,
		context: "auth" | "rpc",
	): Promise<JsonRpcResponse<T>> {
		if (response.status >= 300 && response.status < 400) {
			throw this.getRedirectError(response);
		}

		if (!response.ok) {
			const detail = await this.readResponsePreview(response);
			throw new Error(
				`Odoo ${context} HTTP error: ${response.status} ${response.statusText}${
					detail ? ` - ${detail}` : ""
				}`,
			);
		}

		const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
		const bodyText = await response.text();
		const bodyPreview = this.toPreview(bodyText);

		try {
			return JSON.parse(bodyText) as JsonRpcResponse<T>;
		} catch {
			if (contentType && !contentType.includes("application/json")) {
				throw new Error(
					`Odoo ${context} returned non-JSON response (content-type: ${contentType || "unknown"}, HTTP ${response.status})${
						bodyPreview ? `. Body starts with: ${bodyPreview}` : ""
					}`,
				);
			}

			throw new Error(
				`Odoo ${context} returned invalid JSON (HTTP ${response.status})${
					bodyPreview ? `. Body starts with: ${bodyPreview}` : ""
				}`,
			);
		}
	}

	private async getUid(): Promise<number> {
		if (this.uidCache !== null) {
			return this.uidCache;
		}

		// Authenticate to get the user ID
		const request: JsonRpcRequest = {
			jsonrpc: "2.0",
			method: "call",
			params: {
				service: "common",
				method: "authenticate",
				args: [this.config.database, this.config.username, this.config.apiKey, {}],
			},
			id: ++this.requestId,
		};

		const response = await fetch(`${this.config.url}/jsonrpc`, {
			method: "POST",
			headers: this.buildHeaders(false),
			redirect: "manual",
			body: JSON.stringify(request),
		});

		const json = await this.parseJsonRpcResponse<number | false>(response, "auth");

		if (json.error) {
			const errorData = json.error.data;
			const detail = errorData?.message || errorData?.debug || "";
			throw new Error(`Odoo auth error: ${json.error.message}${detail ? ` - ${detail}` : ""}`);
		}

		if (!json.result) {
			throw new Error("Odoo authentication failed: invalid credentials");
		}

		this.uidCache = json.result;
		return json.result;
	}

	private async executeKw<T>(
		model: string,
		method: string,
		args: unknown[],
		kwargs?: Record<string, unknown>,
	): Promise<T> {
		const uid = await this.getUid();
		return this.rpc<T>("/jsonrpc", "call", {
			service: "object",
			method: "execute_kw",
			args: [this.config.database, uid, this.config.apiKey, model, method, args, kwargs ?? {}],
		});
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
					headers: this.buildHeaders(),
					redirect: "manual",
					body: JSON.stringify(request),
				});

				if (response.status >= 300 && response.status < 400) {
					throw this.getRedirectError(response);
				}

				// Retry on 5xx or 429 (rate limit)
				if (response.status >= 500 || response.status === 429) {
					lastError = new Error(`Odoo HTTP error: ${response.status} ${response.statusText}`);
					continue;
				}

				if (!response.ok) {
					const detail = await this.readResponsePreview(response);
					throw new Error(
						`Odoo HTTP error: ${response.status} ${response.statusText}${detail ? ` - ${detail}` : ""}`,
					);
				}

				const json = await this.parseJsonRpcResponse<T>(response, "rpc");

				if (json.error) {
					const errorData = json.error.data;
					const detail = errorData?.message || errorData?.debug || "";
					throw new Error(`Odoo RPC error: ${json.error.message}${detail ? ` - ${detail}` : ""}`);
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
		const result = await this.executeKw<OdooTask[]>(
			"project.task",
			"search_read",
			[[["id", "=", id]]],
			{ fields: ["id", "name", "stage_id"], limit: 1 },
		);
		return result.length > 0 ? result[0] : null;
	}

	async getUserByEmail(email: string): Promise<OdooUser | null> {
		// Search by email OR login (login is often an email address in Odoo)
		const result = await this.executeKw<OdooUser[]>(
			"res.users",
			"search_read",
			[["|", ["email", "=", email], ["login", "=", email]]],
			{ fields: ["id", "name", "login", "email", "partner_id"], limit: 1 },
		);
		return result.length > 0 ? result[0] : null;
	}

	async getPartnerIdForUser(userId: number): Promise<number | null> {
		const result = await this.executeKw<OdooUser[]>("res.users", "read", [
			[userId],
			["partner_id"],
		]);
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
		const result = await this.executeKw<OdooMessageSubtype[]>(
			"mail.message.subtype",
			"search_read",
			[[["name", "=", "Note"]]],
			{ fields: ["id", "name"], limit: 1 },
		);
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

	async resolveAuthorPartnerId(identifier?: string): Promise<number | null> {
		if (!identifier) {
			// Use default user if configured
			if (this.config.defaultUserId) {
				return this.getPartnerIdForUser(this.config.defaultUserId);
			}
			return null;
		}

		// Check cache first
		if (this.partnerIdCache.has(identifier)) {
			return this.partnerIdCache.get(identifier) ?? null;
		}

		// Use mapped email if configured, otherwise use original identifier
		const mapping = this.config.userMapping;
		const odooEmail = mapping?.[identifier] ?? identifier;

		// Look up user by email (searches both email and login fields)
		const user = await this.getUserByEmail(odooEmail);
		if (user?.partner_id) {
			const partnerId = Array.isArray(user.partner_id) ? user.partner_id[0] : null;
			if (partnerId) {
				this.partnerIdCache.set(identifier, partnerId);
				return partnerId;
			}
		}

		// Fallback to default user
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
		// Try to resolve author for posting as specific user
		// Note: author_id is set but may be ignored by Odoo if the API user is a share/portal user
		const authorPartnerId = await this.resolveAuthorPartnerId(authorIdentifier);
		const subtypeId = await this.getNoteSubtypeId();

		// Always create message directly in mail.message to preserve HTML formatting
		// (message_post escapes HTML content)
		// Use message_type='notification' to work with share/portal users
		// (Odoo blocks message_type='comment' for non-internal users)
		const messageData: Record<string, unknown> = {
			model: "project.task",
			res_id: taskId,
			body,
			message_type: "notification",
			subtype_id: subtypeId || false,
		};

		if (authorPartnerId) {
			messageData.author_id = authorPartnerId;
		}

		return this.executeKw<number>("mail.message", "create", [messageData]);
	}

	async resolveStage(ref: StageRef): Promise<number | null> {
		if (typeof ref === "number") {
			return ref;
		}
		// Search by name
		const result = await this.executeKw<OdooStage[]>(
			"project.task.type",
			"search_read",
			[[["name", "=", ref]]],
			{ fields: ["id", "name"], limit: 1 },
		);
		return result.length > 0 ? result[0].id : null;
	}

	async setStage(taskId: number, stageRef?: StageRef): Promise<boolean> {
		const ref = stageRef ?? this.config.stages.done;
		const stageId = await this.resolveStage(ref);
		if (stageId === null) {
			throw new Error(`Stage not found: ${ref}`);
		}
		return this.executeKw<boolean>("project.task", "write", [[taskId], { stage_id: stageId }]);
	}

	get stages(): StageConfig {
		return this.config.stages;
	}
}
