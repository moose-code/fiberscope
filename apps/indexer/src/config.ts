import { fileURLToPath } from "node:url";

import { NETWORKS } from "@fiberscope/core";
import type { Network, NetworkId } from "@fiberscope/core";

/** The network this indexer covers: NETWORK names it, Base by default. */
export const NETWORK = network(process.env.NETWORK || "base");

/** Calls per JSON-RPC batch request, kept small for the public Base RPC. */
export const RPC_BATCH_SIZE = 10;

/** CoW's placeholder address for the native token as a buy token, the same on every network. */
export const NATIVE_TOKEN = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

/** The network's database in apps/indexer/.data, which the Docker image links to its volume. */
export const DEFAULT_DB_PATH = fileURLToPath(new URL(`../.data/${NETWORK.id}.db`, import.meta.url));
/** The network's snapshot where the site reads it locally: apps/web/data/<network>/snapshot.json. */
export const DEFAULT_SNAPSHOT_PATH = fileURLToPath(
	new URL(`../../web/data/${NETWORK.id}/snapshot.json`, import.meta.url)
);

/** HyperSync, for the chain's logs, receipts and calldata (see hypersync.ts). */
export interface HyperSyncTarget {
	/** HYPERSYNC_URL, default the network's endpoint, https://<chain id>.hypersync.xyz. */
	url: string;
	/** ENVIO_API_TOKEN: an Envio API token. */
	token: string;
}

/** The R2 object every snapshot is uploaded to, through R2's S3 API. */
export interface R2Target {
	accountId: string;
	bucket: string;
	key: string;
	/** The S3 credentials of an R2 API token that can write objects to the bucket. */
	accessKeyId: string;
	secretAccessKey: string;
}

export interface Env {
	/** The SQLite database (DB_PATH, default `apps/indexer/.data/<network>.db`). */
	dbPath: string;
	/** The network's RPC endpoint: BASE_RPC_URL or BNB_RPC_URL. */
	rpcUrl: string;
	/** Most RPC calls per second (BASE_RPC_RPS or BNB_RPC_RPS); every call in a batch counts. */
	rpcRps: number;
	/**
	 * Where the chain's logs, receipts and calldata come from instead of the RPC; null without
	 * ENVIO_API_TOKEN.
	 */
	hypersync: HyperSyncTarget | null;
	/** Most CoW API requests per second. */
	cowApiRps: number;
	/**
	 * REFRESH_MINUTES: written into the snapshot as the page's refetch interval. `loop.sh` reads
	 * the same variable, in whole minutes, from its own environment for its schedule.
	 */
	refreshMinutes: number;
	/** Where snapshots are uploaded besides the local file; null without SNAPSHOT_R2_BUCKET. */
	upload: R2Target | null;
	/**
	 * GIT_COMMIT: the full hash of the commit the indexer was built from, written into every
	 * snapshot; null when unset. The Docker image sets it from its GIT_COMMIT build argument.
	 */
	commit: string | null;
}

/**
 * The RPC endpoint used when the network's RPC_URL is unset. BNB Chain has none: its public nodes
 * refuse old logs or archive calls, or rate-limit them far below what a backfill needs.
 */
const PUBLIC_RPC: Partial<Record<NetworkId, string>> = { base: "https://mainnet.base.org" };

export function readEnv(env: NodeJS.ProcessEnv = process.env): Env {
	// The RPC's variables are named after the network.
	const rpc = `${NETWORK.id.toUpperCase()}_RPC`;
	const rpcUrl = env[`${rpc}_URL`] || PUBLIC_RPC[NETWORK.id];
	if (!rpcUrl) {
		throw new Error(
			`${rpc}_URL must be set: the indexer has no default RPC for ${NETWORK.name}`
		);
	}
	return {
		dbPath: env.DB_PATH || DEFAULT_DB_PATH,
		rpcUrl,
		rpcRps: positive(env, `${rpc}_RPS`, 15),
		hypersync: hypersyncTarget(env),
		cowApiRps: positive(env, "COW_API_RPS", 3),
		refreshMinutes: positive(env, "REFRESH_MINUTES", 10),
		upload: r2Target(env),
		commit: commit(env),
	};
}

function hypersyncTarget(env: NodeJS.ProcessEnv): HyperSyncTarget | null {
	const token = env.ENVIO_API_TOKEN;
	if (!token) return null;
	return { url: env.HYPERSYNC_URL || `https://${NETWORK.chainId}.hypersync.xyz`, token };
}

function r2Target(env: NodeJS.ProcessEnv): R2Target | null {
	const bucket = env.SNAPSHOT_R2_BUCKET;
	if (!bucket) return null;
	const accountId = env.CLOUDFLARE_ACCOUNT_ID;
	const accessKeyId = env.R2_ACCESS_KEY_ID;
	const secretAccessKey = env.R2_SECRET_ACCESS_KEY;
	if (!accountId || !accessKeyId || !secretAccessKey) {
		throw new Error(
			"SNAPSHOT_R2_BUCKET needs CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY"
		);
	}
	const key = env.SNAPSHOT_R2_KEY || `${NETWORK.id}/snapshot.json`;
	return { accountId, bucket, key, accessKeyId, secretAccessKey };
}

function commit(env: NodeJS.ProcessEnv): string | null {
	const value = env.GIT_COMMIT;
	if (!value) return null;
	if (!/^[0-9a-f]{40}$/.test(value)) {
		throw new Error(`GIT_COMMIT must be a full lowercase commit hash, got "${value}"`);
	}
	return value;
}

function positive(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
	const raw = env[name];
	if (raw === undefined || raw === "") return fallback;
	const value = Number(raw);
	if (!Number.isFinite(value) || value <= 0) {
		throw new Error(`${name} must be a positive number, got "${raw}"`);
	}
	return value;
}

function network(id: string): Network {
	if (!Object.hasOwn(NETWORKS, id)) {
		const ids = Object.keys(NETWORKS);
		const list = ids.length > 1 ? `${ids.slice(0, -1).join(", ")} or ${ids.at(-1)}` : ids[0];
		throw new Error(`NETWORK must be ${list}; got "${id}"`);
	}
	return NETWORKS[id as NetworkId];
}
