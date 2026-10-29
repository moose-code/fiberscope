import { setTimeout as sleep } from "node:timers/promises";

import { backfillAuctions, catchUpAuctions, resolveRelaySenders } from "./auctions.ts";
import type { AuctionStats, ChainWatch } from "./auctions.ts";
import { Clock } from "./clock.ts";
import type { Anchor } from "./clock.ts";
import { NETWORK } from "./config.ts";
import type { CowApi } from "./cow.ts";
import { backfillDetails, catchUpDetails, detailCatchUpRequests } from "./details.ts";
import type { DetailStats, DetailWatch } from "./details.ts";
import type { HyperSync } from "./hypersync.ts";
import {
	backfillChain,
	catchUpChain,
	fillOrderUids,
	fillRelayVerdicts,
	seedNativeUsd,
} from "./ingest.ts";
import type { IngestStats } from "./ingest.ts";
import { duration, fmt, log } from "./log.ts";
import { OVERRIDES } from "./overrides.ts";
import { describeError } from "./pacer.ts";
import { fetchCmsEntries, Registry } from "./registry.ts";
import type { Rpc } from "./rpc.ts";
import { Days } from "./rules.ts";
import { coverage } from "./snapshot.ts";
import type { Store } from "./store.ts";

export interface SyncOptions {
	/** Days of chain history to hold at least. */
	chainDays: number;
	/** Days of auction history to hold at least; chain history is extended to match. */
	auctionDays: number;
	/** Minutes after the start of the sync at which the backfill stops; null for no limit. */
	budgetMinutes: number | null;
	/** Delete the data older than the requested depths once the head is caught up. */
	prune: boolean;
	/**
	 * Where the chain's logs, receipts and calldata come from instead of the RPC; null for the
	 * RPC. The RPC still gives the safe block and the contract calls.
	 */
	hypersync: HyperSync | null;
	/**
	 * Writes the snapshot: once the data is current, and again at the end of the run if it would
	 * show more by then (on an empty database, only after the backfill).
	 */
	writeSnapshot: (() => Promise<void>) | null;
}

export interface SyncStats {
	chain: IngestStats;
	auctions: AuctionStats;
	details: DetailStats;
}

/** Blocks the end may trail the head after a catch-up round before another round runs: 5 minutes. */
const CATCH_UP_SLACK = Math.ceil(300 / NETWORK.blockTime);
/** The longest the CMS may take before a run goes on with the cached registry (10 seconds). */
const CMS_TIMEOUT_MS = 10_000;
/**
 * The longest the details' lookups may take at the CoW API's rate and still hold up the snapshot
 * (8 minutes). After a longer outage, the snapshot goes without them at once.
 */
const DETAIL_CATCH_UP_FITS_MS = 480_000;
/** The least time the details' catch-up gets before the snapshot goes without it (2 minutes). */
const DETAIL_CATCH_UP_MIN_MS = 120_000;

/**
 * Brings the database up to date. Chain and auction data catch up with the network's safe block,
 * and the details (the auctions' scores, and the quotes and protocol fees of the orders traded)
 * with the auctions unless their lookups would hold up the snapshot too long; that makes the data
 * current (the last run time) and is when the snapshot is written. Then chain, auction and detail
 * history are backfilled to the requested depths, within the budget if there is one; the snapshot
 * is written again if it would show more by then. Every step resumes where an interrupted or
 * stopped run left off.
 */
export async function sync(
	store: Store,
	rpc: Rpc,
	cow: CowApi,
	options: SyncOptions
): Promise<SyncStats> {
	const { budgetMinutes, writeSnapshot, hypersync } = options;
	const budget = budgetMinutes === null ? null : AbortSignal.timeout(budgetMinutes * 60_000);
	const registry = await refreshRegistry(store, AbortSignal.timeout(CMS_TIMEOUT_MS));
	const chainDays = Math.max(options.chainDays, options.auctionDays);
	if (store.chainRange() === null && chainDays === 0) {
		throw new Error("The database is empty: pass --chain-days to backfill");
	}
	const stats: SyncStats = {
		chain: { receipts: 0, seconds: 0 },
		auctions: { lookups: 0, missing: 0, seconds: 0 },
		details: { scores: 0, orders: 0, fees: 0, seconds: 0 },
	};
	await seedNativeUsd(store, rpc);
	// Relay settlements stored before their relay was listed lack the AllowList verdicts that
	// attribution reads: they get them before anything reads them.
	await fillRelayVerdicts(store, rpc);

	// Catch up: chain data to the head, then the auctions of the new blocks. A long pause since
	// the last run leaves the head far behind, so this repeats, at most three times, until the end
	// is within CATCH_UP_SLACK blocks of the head. Then the days end at the end of the chain data.
	// An empty database has nothing to catch up: its backfill starts at the head, and the head's
	// own header places the days until the backfill brings the anchors of their blocks.
	const empty = store.chainRange() === null;
	let days: Days;
	// The coverage of the snapshot written once caught up, to tell whether the run adds to it.
	let shown: string | null = null;
	if (empty) {
		const head = await safeHead(rpc);
		days = new Days(new Clock([head], NETWORK.blockTime), head.block);
	} else {
		for (let round = 0; round < 3; round++) {
			await catchUpChain(store, rpc, hypersync, (await safeHead(rpc)).block, stats.chain);
			await catchUpAuctions(store, cow, stats.auctions);
			if ((await safeHead(rpc)).block - store.chainRange()!.to <= CATCH_UP_SLACK) break;
		}
		await resolveRelaySenders(store, cow, registry, stats.auctions);
		days = new Days(store.clock(), store.chainRange()!.to);
		if (options.prune && chainDays > 0) {
			store.prune(
				days.windowStart(chainDays),
				options.auctionDays > 0 ? days.windowStart(options.auctionDays) : null
			);
		}
		// The details of the new blocks, for the snapshot. Their lookups hold it up only while they
		// fit DETAIL_CATCH_UP_FITS_MS at the API's rate. If they would take longer, fail or run
		// past their time, the snapshot goes without them; the rest of the run catches them up
		// first, and the snapshot is written again once they have.
		const requests = detailCatchUpRequests(store);
		const wait = detailCatchUpWait(requests, cow.rate);
		if (wait === null) {
			log(
				`details catch-up: ${fmt(requests)} lookups, about ` +
					`${duration(requests / cow.rate)}; the snapshot goes first`
			);
		} else {
			try {
				await catchUpDetails(store, cow, stats.details, AbortSignal.timeout(wait));
			} catch (error) {
				log(`details catch-up failed: ${describeError(error)}; retried after the snapshot`);
			}
		}
		store.setLastRunAt(Date.now());
		await writeSnapshot?.();
		shown = JSON.stringify(coverage(store, days));
	}

	// Backfill. The chain runs newest first and the auction backfill trails it, so the RPC and
	// the CoW API rate limits are spent at the same time, and the chain reaches the auction depth
	// before it goes deeper: auction history never waits for the full chain depth. The details
	// trail the auction backfill. The trades stored before the schema held order uids get them
	// from the RPC.
	const chain: ChainWatch = { done: false };
	const details: DetailWatch = { auctionsDone: false, uidsDone: false };
	const abort = new AbortController();
	const stop = budget === null ? abort.signal : AbortSignal.any([abort.signal, budget]);
	const chainWork = (async () => {
		try {
			if (chainDays > 0) {
				const low = days.reach(chainDays);
				await backfillChain(
					store,
					rpc,
					hypersync,
					low,
					days.end,
					stats.chain,
					budget ?? undefined
				);
			}
		} catch (error) {
			abort.abort(error);
			throw error;
		} finally {
			chain.done = true;
		}
	})();
	const uidWork = (async () => {
		try {
			await fillOrderUids(store, rpc, stop);
		} catch (error) {
			abort.abort(error);
			throw error;
		} finally {
			details.uidsDone = true;
		}
	})();
	const auctionWork = (async () => {
		try {
			if (options.auctionDays > 0) {
				const low = days.reach(options.auctionDays);
				await backfillAuctions(store, cow, low, chain, stats.auctions, stop);
			}
		} finally {
			details.auctionsDone = true;
		}
		// Once the auction backfill is done, the CoW API's rate allowance is idle while the chain
		// backfill runs on: spend it on the relay settlements whose attribution needs the API's
		// winner, as their blocks arrive.
		while (!chain.done) {
			await resolveRelaySenders(store, cow, registry, stats.auctions, stop);
			for (let waited = 0; waited < 20 && !chain.done; waited++) await sleep(500);
		}
	})();
	const detailWork = (async () => {
		// What the catch-up before the snapshot left: all of it when it did not run.
		await catchUpDetails(store, cow, stats.details);
		if (options.auctionDays > 0) {
			const low = days.reach(options.auctionDays);
			await backfillDetails(store, cow, low, details, stats.details, stop);
		}
	})();
	const settled = await Promise.allSettled([chainWork, uidWork, auctionWork, detailWork]);
	for (const work of settled) if (work.status === "rejected") throw work.reason;
	if (budget?.aborted) {
		log(`sync: the ${budgetMinutes}-minute budget is spent; the next run resumes the backfill`);
	}
	await seedNativeUsd(store, rpc);

	if (empty && store.chainRange() !== null) store.setLastRunAt(Date.now());
	// The snapshot again only if it would show more: on an empty database, the first one; else a
	// whole day more of some data, or the details that caught up after the snapshot. A backfill
	// the budget stopped short of a whole day adds nothing it shows. `days` is the run's, so where
	// the chain backfill went below its clock's anchors, a new day may count a run early or late.
	const grown = shown !== null && JSON.stringify(coverage(store, days)) !== shown;
	if (grown || (shown === null && store.lastRunAt() !== null)) await writeSnapshot?.();
	return stats;
}

/**
 * CMS entries refreshed into the cache and merged with the overrides. The CMS gets one attempt,
 * which `signal` bounds, so it never holds up a run long: the cached copy covers its outages.
 */
export async function refreshRegistry(store: Store, signal: AbortSignal): Promise<Registry> {
	try {
		const entries = await fetchCmsEntries(NETWORK.chainId, signal);
		if (entries.length === 0) throw new Error(`no entries for chain ${NETWORK.chainId}`);
		store.replaceCmsEntries(entries);
		log(`registry: ${entries.length} CMS entries + ${OVERRIDES.length} overrides`);
	} catch (error) {
		log(`registry: CMS unavailable (${describeError(error)}); using the cached copy`);
	}
	return new Registry(store.cmsEntries(), OVERRIDES);
}

/**
 * How long the details' catch-up may hold up the snapshot, given the API requests it makes (see
 * detailCatchUpRequests) and the API's rate: twice the time they take at that rate, so a slower
 * API still fits, and at least DETAIL_CATCH_UP_MIN_MS, in whole milliseconds as
 * AbortSignal.timeout takes them. Null when they take longer than DETAIL_CATCH_UP_FITS_MS: the
 * snapshot then goes without them at once.
 */
export function detailCatchUpWait(requests: number, requestsPerSecond: number): number | null {
	const ms = (requests / requestsPerSecond) * 1000;
	if (ms > DETAIL_CATCH_UP_FITS_MS) return null;
	return Math.ceil(Math.max(DETAIL_CATCH_UP_MIN_MS, 2 * ms));
}

/**
 * The network's safe block, with its time. On Base, the newest block whose transactions Base has
 * posted to Ethereum: blocks up to it change only if Ethereum reorganizes the blocks holding that
 * data. On BNB Chain, the newest justified block, a block or two behind the head. The indexer
 * never stores a block past it, so never one the network itself might replace.
 */
async function safeHead(rpc: Rpc): Promise<Anchor> {
	const block = await rpc.call<{ number: string; timestamp: string } | null>(
		"eth_getBlockByNumber",
		["safe", false]
	);
	if (block === null) throw new Error("the RPC node has no safe block");
	return { block: Number(block.number), time: Number(block.timestamp) };
}
