import { setTimeout as sleep } from "node:timers/promises";

import type { Log, Receipt } from "./chain.ts";
import { isInteger, isOptionalString, isRecord } from "./guards.ts";
import { log } from "./log.ts";
import { backoff, describeError, retryAfterMs } from "./pacer.ts";
import { EndpointError } from "./rpc.ts";

/**
 * A block range's logs, with the receipt and calldata of every transaction that emitted one: what
 * the RPC gives in an `eth_getLogs` per range and two calls per transaction.
 */
export interface RangeLogs {
	/** The logs as `eth_getLogs` gives them, each with its block's `blockTimestamp`. */
	logs: Log[];
	/** The receipt of each log's transaction, by lowercase hash. */
	receipts: Map<string, Receipt>;
	/** The calldata of each log's transaction, by lowercase hash. */
	inputs: Map<string, string>;
}

export interface HyperSyncStats {
	/** Queries sent, retries included. */
	queries: number;
	/** Queries sent again after a failure. */
	retries: number;
	/** Response bodies, uncompressed. */
	bytes: number;
}

/** A log as HyperSync returns it: numbers for its block and index, and its topics one by one. */
interface HyperSyncLog {
	block_number: number;
	log_index: number;
	transaction_hash: string;
	address: string;
	data: string;
	topic0?: string | null;
	topic1?: string | null;
	topic2?: string | null;
	topic3?: string | null;
}

/** A transaction with its receipt's fields, as HyperSync returns it. */
interface HyperSyncTransaction {
	block_number: number;
	hash: string;
	from: string;
	to?: string | null;
	gas_used: string;
	effective_gas_price: string;
	/** The L1 data fee of an OP stack chain such as Base; null elsewhere. */
	l1_fee?: string | null;
	input: string;
}

/** A query's answer: its data up to `next_block`, where the next query of the range starts. */
interface Reply {
	/** Batches of the answer; a batch leaves out a table it has no rows of. */
	data: {
		logs?: HyperSyncLog[];
		transactions?: HyperSyncTransaction[];
		blocks?: { number: number; timestamp: string }[];
	}[];
	next_block: number;
	/** The newest block HyperSync holds. */
	archive_height: number | null;
}

/**
 * The fields a query asks for. HyperSync joins in the transactions that emitted the logs and the
 * blocks that hold them.
 */
const FIELDS = {
	log: [
		"block_number",
		"log_index",
		"transaction_hash",
		"address",
		"data",
		"topic0",
		"topic1",
		"topic2",
		"topic3",
	],
	transaction: [
		"block_number",
		"hash",
		"from",
		"to",
		"gas_used",
		"effective_gas_price",
		"l1_fee",
		"input",
	],
	block: ["number", "timestamp"],
};

const ATTEMPTS = 12;
/** A query reads up to a few MB of calldata; on Base one took up to 12 s. */
const TIMEOUT_MS = 60_000;
/** The longest Retry-After the client waits out; a longer one fails at once, as in rpc.ts. */
const RETRY_AFTER_CAP_MS = 60_000;
/** Times a query may find HyperSync behind the range before the range fails. */
const LAG_ATTEMPTS = 5;
/** The longest excerpt of a response body that a reason keeps, in characters. */
const EXCERPT_LENGTH = 200;

/**
 * A client of HyperSync (https://docs.envio.dev/docs/HyperSync/overview), Envio's indexed copy of
 * a chain, through its JSON API. One query returns a block range's logs together with the
 * transactions that emitted them, their receipts' fields and calldata included, and their blocks'
 * timestamps. A response holds a few MB at most and says where it stopped (`next_block`), so a
 * busy range takes a few queries. It retries rate limits, failed requests and server errors,
 * logging one line for each retry, and gives up at once when HyperSync refuses the token.
 */
export class HyperSync {
	readonly stats: HyperSyncStats = { queries: 0, retries: 0, bytes: 0 };
	readonly #url: string;
	readonly #token: string;

	/** `url` is the network's HyperSync endpoint; `token` an Envio API token. */
	constructor(url: string, token: string) {
		this.#url = url.replace(/\/+$/, "");
		this.#token = token;
	}

	/**
	 * The logs of `address` with a first topic in `topics[0]` from block `from` to `to`, both
	 * included as in `eth_getLogs`, with their transactions' receipts and calldata.
	 */
	async logs(
		from: number,
		to: number,
		address: string[],
		topics: string[][]
	): Promise<RangeLogs> {
		const found: RangeLogs = { logs: [], receipts: new Map(), inputs: new Map() };
		const times = new Map<number, string>();
		let behind = 0;
		for (let next = from; next <= to;) {
			const reply = await this.#query({
				from_block: next,
				// HyperSync's end block is excluded.
				to_block: to + 1,
				logs: [{ address, topics }],
				field_selection: FIELDS,
			});
			for (const batch of reply.data) {
				for (const entry of batch.logs ?? []) found.logs.push(logOf(entry));
				for (const tx of batch.transactions ?? []) {
					const hash = tx.hash.toLowerCase();
					found.receipts.set(hash, receiptOf(tx));
					found.inputs.set(hash, tx.input);
				}
				for (const block of batch.blocks ?? []) times.set(block.number, block.timestamp);
			}
			if (reply.next_block > next) {
				behind = 0;
				next = reply.next_block;
				continue;
			}
			// HyperSync has not reached the range yet: it trails the head by a block or two.
			if (++behind === LAG_ATTEMPTS) {
				throw new Error(
					`HyperSync is at block ${reply.archive_height ?? "none"}, behind block ${next}`
				);
			}
			const delay = backoff(behind);
			log(
				`hypersync: at block ${reply.archive_height ?? "none"}, behind block ${next}; ` +
					`asking again in ${(delay / 1000).toFixed(1)}s (attempt ${behind + 1} of ${LAG_ATTEMPTS})`
			);
			await sleep(delay);
		}
		// Each log gets its block's time, as from a node that adds `blockTimestamp`.
		for (const entry of found.logs) {
			const time = times.get(Number(entry.blockNumber));
			if (time !== undefined) entry.blockTimestamp = time;
		}
		return found;
	}

	/** Sends a query until it gets an answer; throws when HyperSync will not serve it. */
	async #query(query: object): Promise<Reply> {
		const body = JSON.stringify(query);
		let reason = "";
		let pause = 0;
		for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
			if (attempt > 0) {
				this.stats.retries++;
				const delay = Math.max(backoff(attempt - 1), pause);
				log(
					`hypersync: retrying a query in ${(delay / 1000).toFixed(1)}s ` +
						`(attempt ${attempt + 1} of ${ATTEMPTS}): ${reason}`
				);
				await sleep(delay);
			}
			pause = 0;
			this.stats.queries++;
			let response: Response;
			let text: string;
			try {
				response = await fetch(`${this.#url}/query`, {
					method: "POST",
					headers: {
						authorization: `Bearer ${this.#token}`,
						"content-type": "application/json",
					},
					body,
					signal: AbortSignal.timeout(TIMEOUT_MS),
				});
				text = await response.text();
			} catch (error) {
				reason = this.#redact(describeError(error));
				continue;
			}
			this.stats.bytes += text.length;
			let json: unknown;
			try {
				json = JSON.parse(text);
			} catch {
				json = undefined;
			}
			if (response.ok) {
				if (isReply(json)) return json;
				reason = `unexpected reply: ${this.#excerpt(text)}`;
				continue;
			}
			const said = isRecord(json) && typeof json.error === "string" ? json.error : text;
			reason = `HTTP ${response.status}: ${this.#excerpt(said)}`;
			if (response.status === 401 || response.status === 403) {
				throw new EndpointError(`HyperSync refuses the token (${reason})`);
			}
			if (response.status === 429) {
				pause = retryAfterMs(response.headers.get("retry-after")) ?? 2_000;
				if (pause > RETRY_AFTER_CAP_MS) {
					throw new EndpointError(
						`HyperSync asks to wait ${Math.round(pause / 1000)}s (${reason})`
					);
				}
				continue;
			}
			// Any other refusal is about the query itself: sending it again changes nothing.
			if (response.status < 500 && response.status !== 408) {
				throw new EndpointError(`HyperSync refuses the query (${reason})`);
			}
		}
		throw new Error(`a HyperSync query failed ${ATTEMPTS} times: ${reason}`);
	}

	/**
	 * The start of a response body, on one line, without markup or the token. The markup goes
	 * before the redaction, whose placeholder it would remove, and the cut after it.
	 */
	#excerpt(text: string): string {
		const line = this.#redact(
			text
				.replace(/<[^>]*>/g, " ")
				.replace(/\s+/g, " ")
				.trim()
		);
		return line.length > EXCERPT_LENGTH ? `${line.slice(0, EXCERPT_LENGTH)}…` : line;
	}

	/** Text without the token, which a server might echo. */
	#redact(text: string): string {
		return this.#token === "" ? text : text.replaceAll(this.#token, "<redacted>");
	}
}

/** A log in the form `eth_getLogs` gives it. */
function logOf(entry: HyperSyncLog): Log {
	return {
		address: entry.address,
		topics: [entry.topic0, entry.topic1, entry.topic2, entry.topic3].filter(
			(topic): topic is string => typeof topic === "string"
		),
		data: entry.data,
		blockNumber: quantity(entry.block_number),
		transactionHash: entry.transaction_hash,
		logIndex: quantity(entry.log_index),
	};
}

/** A transaction's receipt fields in the form `eth_getTransactionReceipt` gives them. */
function receiptOf(tx: HyperSyncTransaction): Receipt {
	const receipt: Receipt = {
		blockNumber: quantity(tx.block_number),
		from: tx.from,
		to: tx.to ?? null,
		gasUsed: tx.gas_used,
		effectiveGasPrice: tx.effective_gas_price,
	};
	if (typeof tx.l1_fee === "string") receipt.l1Fee = tx.l1_fee;
	return receipt;
}

/** A number as an RPC quantity. */
function quantity(value: number): string {
	return `0x${value.toString(16)}`;
}

/** Whether a response body is a query's answer with every field the indexer reads. */
function isReply(json: unknown): json is Reply {
	if (!isRecord(json) || !isInteger(json.next_block) || !Array.isArray(json.data)) return false;
	return json.data.every(
		(batch) =>
			isRecord(batch) &&
			isList(batch.logs, isLog) &&
			isList(batch.transactions, isTransaction) &&
			isList(batch.blocks, isBlock)
	);
}

/** An array whose every item passes `check`, or absent (see Reply). */
function isList(value: unknown, check: (item: unknown) => boolean): boolean {
	if (value === undefined) return true;
	return Array.isArray(value) && value.every(check);
}

function isLog(value: unknown): boolean {
	return (
		isRecord(value) &&
		isInteger(value.block_number) &&
		isInteger(value.log_index) &&
		typeof value.transaction_hash === "string" &&
		typeof value.address === "string" &&
		typeof value.data === "string" &&
		[value.topic0, value.topic1, value.topic2, value.topic3].every(isOptionalString)
	);
}

function isTransaction(value: unknown): boolean {
	return (
		isRecord(value) &&
		isInteger(value.block_number) &&
		typeof value.hash === "string" &&
		typeof value.from === "string" &&
		isOptionalString(value.to) &&
		typeof value.gas_used === "string" &&
		typeof value.effective_gas_price === "string" &&
		isOptionalString(value.l1_fee) &&
		typeof value.input === "string"
	);
}

function isBlock(value: unknown): boolean {
	return isRecord(value) && isInteger(value.number) && typeof value.timestamp === "string";
}
