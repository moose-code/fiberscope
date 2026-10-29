import {
	ethCall,
	getInputs,
	getLogs,
	getReceipts,
	headerAnchors,
	orderUidOf,
	parseSettlementLogs,
	RELAYS,
	SELECTOR,
	SETTLEMENT,
	TOPIC,
} from "./chain.ts";
import type { Log, TradeRow } from "./chain.ts";
import type { Anchor } from "./clock.ts";
import { NETWORK } from "./config.ts";
import type { HyperSync } from "./hypersync.ts";
import { duration, fmt, log, throttledLog } from "./log.ts";
import { answerAt, feedSegments, pricePoints } from "./prices.ts";
import type { FeedSegment } from "./prices.ts";
import type { Rpc } from "./rpc.ts";
import type { BlockRange } from "./rules.ts";
import type { ChainChunk, Store, TxRow } from "./store.ts";
import { readOrderTerms } from "./terms.ts";

/** Block ranges in flight at once, the next one to commit included. */
const PIPELINE = 2;
/**
 * The same with HyperSync, whose queries wait on its reads rather than on a rate: a query took
 * from 0.1 to 12 seconds on Base, longest on blocks it had not read lately. With 8 in flight a day
 * of Base took 7–18 seconds; with 2, 22–62 seconds; 16 did no better than 8.
 */
const HYPERSYNC_PIPELINE = 8;
/** `eth_getLogs` requests in flight at once while order uids are filled in. */
const UID_LANES = 4;

/** Running totals of chain ingestion, for throughput reports. */
export interface IngestStats {
	/** Batch transactions, one receipt each. */
	receipts: number;
	/** Time spent ingesting. */
	seconds: number;
}

/**
 * AllowList `isSolver` verdicts on the senders and recipients of relay settlements (see
 * creditedAddress). Each address is checked once, at the block of the first relay settlement
 * seen with it, and the verdict is kept: `eth_call` is the scarcest RPC allowance (see
 * ETH_CALL_SHARE in rpc.ts), and an address does not switch between being a solver and being an
 * operator account.
 */
class AllowList {
	readonly #store: Store;
	readonly #rpc: Rpc;
	readonly #checks = new Map<string, Promise<boolean>>();

	constructor(store: Store, rpc: Rpc) {
		this.#store = store;
		this.#rpc = rpc;
	}

	async isSolver(address: string, block: number): Promise<boolean> {
		const known = this.#store.allowListVerdict(address);
		if (known !== null) return known;
		let check = this.#checks.get(address);
		if (!check) {
			check = this.#check(address, block);
			this.#checks.set(address, check);
		}
		return check;
	}

	async #check(address: string, block: number): Promise<boolean> {
		try {
			const data = SELECTOR.isSolver + address.slice(2).padStart(64, "0");
			const call = ethCall(NETWORK.contracts.allowList, data, block);
			const verdict = BigInt(await this.#rpc.call<string>(call.method, call.params)) === 1n;
			this.#store.saveAllowListVerdict(address, verdict);
			return verdict;
		} finally {
			this.#checks.delete(address);
		}
	}
}

/**
 * Fetches everything a block range adds: settlements and trades from the settlement contract's
 * logs, a receipt and the calldata of each batch transaction, with the order terms the calldata
 * gives its trades, the native token's USD answers of the aggregators that `feed` says the
 * Chainlink proxy used, and the clock's anchors. The senders and recipients of relay settlements
 * get an AllowList verdict on the way. With `hypersync`, the logs come with their transactions'
 * receipts and calldata in a query or two; without it, the RPC gives them in an `eth_getLogs`
 * and two calls per batch transaction.
 */
async function fetchChunk(
	rpc: Rpc,
	hypersync: HyperSync | null,
	range: BlockRange,
	feed: FeedSegment[],
	allowList: AllowList
): Promise<ChainChunk> {
	const aggregators = feed
		.filter((segment) => segment.from <= range.to && range.from <= segment.to)
		.map((segment) => segment.aggregator);
	const address = [SETTLEMENT, ...new Set(aggregators)];
	const topics = [[TOPIC.settlement, TOPIC.trade, TOPIC.interaction, TOPIC.answerUpdated]];
	const fetched =
		hypersync === null ? null : await hypersync.logs(range.from, range.to, address, topics);
	const logs = fetched?.logs ?? (await getLogs(rpc, range.from, range.to, address, topics));
	const { settlements, trades } = parseSettlementLogs(
		logs.filter((entry) => entry.address.toLowerCase() === SETTLEMENT)
	);
	const blockOf = new Map<string, number>();
	const relayed = new Set<string>();
	for (const settlement of settlements) {
		if (settlement.trades === 0) continue;
		blockOf.set(settlement.tx, settlement.block);
		if (RELAYS.includes(settlement.solver)) relayed.add(settlement.tx);
	}
	const hashes = [...blockOf.keys()];
	const [receipts, inputs] =
		fetched === null
			? await Promise.all([getReceipts(rpc, hashes), getInputs(rpc, hashes)])
			: [fetched.receipts, fetched.inputs];
	const txs: TxRow[] = hashes.map((tx) => {
		const receipt = receipts.get(tx);
		if (receipt === undefined) throw new Error(`no receipt for ${tx}`);
		const block = Number(receipt.blockNumber);
		if (block !== blockOf.get(tx)) {
			throw new Error(
				`receipt of ${tx} is in block ${block}, its logs in ${blockOf.get(tx)}`
			);
		}
		return {
			tx,
			block,
			sender: receipt.from.toLowerCase(),
			recipient: receipt.to?.toLowerCase() ?? null,
			gasUsed: Number(receipt.gasUsed),
			fee: (
				BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice) +
				BigInt(receipt.l1Fee ?? 0)
			).toString(),
		};
	});
	addTerms(trades, inputs);
	for (const { tx, block, sender, recipient } of txs) {
		if (relayed.has(tx)) await checkRelayParties(allowList, sender, recipient, block);
	}
	return {
		range,
		settlements,
		trades,
		txs,
		prices: pricePoints(feed, logs, range),
		anchors: await anchorsOf(rpc, range, logs),
	};
}

/**
 * The block times a range gives the clock: the block of every log, with the timestamp the node
 * gives it; or, when no log carries one (a range without logs, or a node that does not add it),
 * the timestamps of the range's first and last blocks from their headers.
 */
async function anchorsOf(rpc: Rpc, range: BlockRange, logs: Log[]): Promise<Anchor[]> {
	const times = new Map<number, number>();
	for (const entry of logs) {
		if (entry.blockTimestamp !== undefined) {
			times.set(Number(entry.blockNumber), Number(entry.blockTimestamp));
		}
	}
	if (times.size === 0) return headerAnchors(rpc, [...new Set([range.from, range.to])]);
	return [...times].map(([block, time]) => ({ block, time }));
}

/** Gives trades the order terms their transaction's calldata holds, and logs the ones it lacks. */
function addTerms(trades: TradeRow[], inputs: Map<string, string>): void {
	const byTx = new Map<string, TradeRow[]>();
	for (const trade of trades) {
		const list = byTx.get(trade.tx);
		if (list) list.push(trade);
		else byTx.set(trade.tx, [trade]);
	}
	const unread: string[] = [];
	for (const [tx, list] of byTx) {
		const terms = readOrderTerms(inputs.get(tx)!, list);
		for (const trade of list) trade.terms = terms.get(trade.logIndex);
		if (terms.size < list.length) unread.push(tx);
	}
	if (unread.length > 0) {
		log(
			`order terms: no settle() call in the calldata reproduces trades of ${unread.length} ` +
				`txs, e.g. ${unread[0]}`
		);
	}
}

/** AllowList verdicts on what attribution may credit a relay settlement to: never a relay. */
async function checkRelayParties(
	allowList: AllowList,
	sender: string,
	recipient: string | null,
	block: number
): Promise<void> {
	await allowList.isSolver(sender, block);
	if (recipient !== null && !RELAYS.includes(recipient)) {
		await allowList.isSolver(recipient, block);
	}
}

/**
 * Gives the senders and recipients of relay settlements the AllowList verdicts they lack.
 * Ingestion checks them, but not in the settlements stored before their relay was listed in
 * `NETWORKS`, such as an Atomic Bundle added later. One `isSolver` call per address, at the block
 * of its first relay settlement, as ingestion does.
 */
export async function fillRelayVerdicts(store: Store, rpc: Rpc): Promise<void> {
	const parties = store.uncheckedRelayParties();
	if (parties.length === 0) return;
	const allowList = new AllowList(store, rpc);
	for (const { address, block } of parties) await allowList.isSolver(address, block);
	log(`AllowList: ${fmt(parties.length)} parties of relay settlements checked`);
}

/**
 * Gives the first block of the chain data a price of the native token when it has none. Each
 * backfill pass stores the proxy's answer at the bottom of its range only when it gets there, so
 * a pass the budget stopped leaves the blocks below its lowest AnswerUpdated without a price.
 */
export async function seedNativeUsd(store: Store, rpc: Rpc): Promise<void> {
	const chain = store.chainRange();
	if (chain === null) return;
	const first = store.firstNativeUsdBlock();
	if (first !== null && first <= chain.from) return;
	store.saveNativeUsdPoint({ block: chain.from, answer: await answerAt(rpc, chain.from) });
	log(
		`${NETWORK.native.symbol}/USD: stored the answer at block ${chain.from}, the first of the ` +
			"chain data"
	);
}

/**
 * Extends chain data down to `low`, newest blocks first, so recent days complete first. When
 * `stop` aborts it commits the ranges already being fetched and stops; the next backfill resumes
 * below them.
 */
export async function backfillChain(
	store: Store,
	rpc: Rpc,
	hypersync: HyperSync | null,
	low: number,
	head: number,
	stats: IngestStats,
	stop?: AbortSignal
): Promise<void> {
	const top = (store.chainRange()?.from ?? head + 1) - 1;
	const ranges: BlockRange[] = [];
	for (let to = top; to >= low; to -= NETWORK.logRange) {
		ranges.push({ from: Math.max(low, to - NETWORK.logRange + 1), to });
	}
	await ingest(store, rpc, hypersync, ranges, "backfill", stats, stop);
}

/** Extends chain data up to `head`. */
export async function catchUpChain(
	store: Store,
	rpc: Rpc,
	hypersync: HyperSync | null,
	head: number,
	stats: IngestStats
): Promise<void> {
	const ranges: BlockRange[] = [];
	for (let from = store.chainRange()!.to + 1; from <= head; from += NETWORK.logRange) {
		ranges.push({ from, to: Math.min(head, from + NETWORK.logRange - 1) });
	}
	await ingest(store, rpc, hypersync, ranges, "catch-up", stats);
}

/**
 * Fetches ranges a few at a time and commits them strictly in order, each in one transaction
 * with the new chain range, so the ingested range stays contiguous and a crash loses nothing.
 * The aggregators behind the native token's feed are resolved once for the whole pass. Once
 * `stop` aborts, no further range is fetched.
 */
async function ingest(
	store: Store,
	rpc: Rpc,
	hypersync: HyperSync | null,
	ranges: BlockRange[],
	label: string,
	stats: IngestStats,
	stop?: AbortSignal
): Promise<void> {
	if (ranges.length === 0 || stop?.aborted) return;
	const started = performance.now();
	const callsBefore = rpc.stats.calls;
	const low = ranges.reduce((min, range) => Math.min(min, range.from), Infinity);
	const high = ranges.reduce((max, range) => Math.max(max, range.to), -Infinity);
	const source = hypersync === null ? "" : " from HyperSync";
	log(`chain ${label}: blocks ${low}..${high}, ${fmt(ranges.length)} ranges${source}`);
	const feed = await feedSegments(rpc, low, high);
	const allowList = new AllowList(store, rpc);
	let done = 0;
	let receipts = 0;
	const report = throttledLog();
	const depth = hypersync === null ? PIPELINE : HYPERSYNC_PIPELINE;
	const queue: Promise<ChainChunk>[] = [];
	let next = 0;
	const refill = () => {
		while (queue.length < depth && next < ranges.length && !stop?.aborted) {
			const pending = fetchChunk(rpc, hypersync, ranges[next++], feed, allowList);
			pending.catch(() => {}); // awaited in order below
			queue.push(pending);
		}
	};
	refill();
	while (queue.length > 0) {
		const chunk = await queue.shift()!;
		const current = store.chainRange();
		store.commitChunk(chunk, {
			from: Math.min(current?.from ?? chunk.range.from, chunk.range.from),
			to: Math.max(current?.to ?? chunk.range.to, chunk.range.to),
		});
		refill();
		done++;
		receipts += chunk.txs.length;
		stats.receipts += chunk.txs.length;
		report(() => {
			const seconds = (performance.now() - started) / 1000;
			const eta = (seconds / done) * (ranges.length - done);
			return (
				`chain ${label}: ${fmt(done)}/${fmt(ranges.length)} ranges · at block ${chunk.range.from} · ` +
				`${(receipts / seconds).toFixed(1)} receipts/s · ` +
				`${((rpc.stats.calls - callsBefore) / seconds).toFixed(1)} calls/s · eta ${duration(eta)}`
			);
		});
	}
	const seconds = (performance.now() - started) / 1000;
	stats.seconds += seconds;
	const outcome = done < ranges.length ? `stopped at block ${store.chainRange()?.from}` : "done";
	log(`chain ${label}: ${outcome}, ${fmt(receipts)} batch txs in ${duration(seconds)}`);
}

/**
 * Gives the trades stored before the schema held order uids their uids, read from the Trade
 * events of their block ranges, newest blocks first. When `stop` aborts it finishes the ranges in
 * flight and stops; the next run resumes with the trades still without a uid.
 */
export async function fillOrderUids(store: Store, rpc: Rpc, stop?: AbortSignal): Promise<void> {
	const gap = store.uidGap();
	if (gap === null || stop?.aborted) return;
	const ranges: BlockRange[] = [];
	for (let to = gap.to; to >= gap.from; to -= NETWORK.logRange) {
		ranges.push({ from: Math.max(gap.from, to - NETWORK.logRange + 1), to });
	}
	log(`order uids: blocks ${gap.from}..${gap.to}, ${fmt(ranges.length)} ranges`);
	const started = performance.now();
	const report = throttledLog();
	let next = 0;
	let done = 0;
	let filled = 0;
	const lane = async () => {
		while (next < ranges.length && !stop?.aborted) {
			const range = ranges[next++];
			const logs = await getLogs(rpc, range.from, range.to, [SETTLEMENT], [[TOPIC.trade]]);
			const uids = new Map(
				logs.map((entry) => [
					`${Number(entry.blockNumber)}:${Number(entry.logIndex)}`,
					orderUidOf(entry.data),
				])
			);
			filled += store.fillOrderUids(range, uids);
			done++;
			report(() => {
				const seconds = (performance.now() - started) / 1000;
				const eta = (seconds / done) * (ranges.length - done);
				return `order uids: ${fmt(done)}/${fmt(ranges.length)} ranges · ${fmt(filled)} trades · eta ${duration(eta)}`;
			});
		}
	};
	await Promise.all(Array.from({ length: Math.min(UID_LANES, ranges.length) }, lane));
	const seconds = (performance.now() - started) / 1000;
	const outcome = done < ranges.length ? "stopped" : "done";
	log(`order uids: ${outcome}, ${fmt(filled)} trades in ${duration(seconds)}`);
}
