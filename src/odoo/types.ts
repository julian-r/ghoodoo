export interface OdooTask {
	id: number;
	name: string;
	stage_id: [number, string] | false;
}

export interface OdooStage {
	id: number;
	name: string;
}

export interface OdooUser {
	id: number;
	name?: string;
	login: string;
	email: string | false;
	partner_id: [number, string] | false;
}

export interface AuthorInfo {
	displayName: string;
	odooUserId?: number;
	githubUsername?: string;
}

export interface OdooMessageSubtype {
	id: number;
	name: string;
}

export interface JsonRpcRequest {
	jsonrpc: "2.0";
	method: string;
	params: Record<string, unknown>;
	id: number;
}

export interface JsonRpcResponse<T = unknown> {
	jsonrpc: "2.0";
	id: number;
	result?: T;
	error?: {
		code: number;
		message: string;
		data?: unknown;
	};
}
