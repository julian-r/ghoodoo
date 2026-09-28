import type { OdooRecord } from "vodoo";

export type OdooTask = OdooRecord & {
	id: number;
	name: string;
	stage_id: [number, string] | null;
	github_pr_url: string | null;
};

export type OdooStage = OdooRecord & {
	id: number;
	name: string;
};

export type OdooUser = OdooRecord & {
	id: number;
	name?: string;
	login: string;
	email: string | null;
	partner_id: [number, string] | null;
};

export type OdooMessageSubtype = OdooRecord & {
	id: number;
	name: string;
};
