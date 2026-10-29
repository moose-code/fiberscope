import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { NETWORK } from "./config.ts";
import type { CowApi, OrderDetail, OrderTrade } from "./cow.ts";
import type { RegistryEntry } from "./registry.ts";
import type { Rpc } from "./rpc.ts";
import type { BlockRange } from "./rules.ts";
import { Store } from "./store.ts";
import { detailCatchUpWait, refreshRegistry, sync } from "./sync.ts";
import type { SyncOptions } from "./sync.ts";

const SOLVER = "0x5050505050505050505050505050505050505050";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const WETH = "0x4200000000000000000000000000000000000006";
/** Base's blocks in a day, one every 2 seconds. */
const DAY = 43_200;
/** The end of the chain data: four days of blocks from block 1, which comes at T0. */
const END = 4 * DAY;
const T0 = 1_790_000_000;
const ORDER: OrderDetail = { kind: "sell", appClass: "market", partnerFees: [], quote: null };

interface Batch {
	label: string;
	block: number;
}

/** A transaction hash spelled from a readable label. */
function hash(label: string): string {
	return `0x${Buffer.from(label).toString("hex").padStart(64, "0")}`;
}

/** An order uid spelled from a readable label. */
function uid(label: string): string {
	return `0x${Buffer.from(label).toString("hex").padStart(112, "0")}`;
}

/**
 * Four days of chain data, all of it with auction data and details, holding one-trade batches
 * that each fill the order of their label.
 */
function chainStore(batches: Batch[]): Store {
	const store = new Store(":memory:");
	const range = { from: 1, to: END };
	store.commitChunk(
		{
			range,
			settlements: batches.map(({ label, block }) => ({
				tx: hash(label),
				logIndex: 2,
				block,
				solver: SOLVER,
				trades: 1,
				swaps: 1,
			})),
			trades: batches.map(({ label, block }) => ({
				tx: hash(label),
				logIndex: 1,
				block,
				settlementLogIndex: 2,
				sellToken: USDC,
				buyToken: WETH,
				sellAmount: "1000000000",
				buyAmount: "500000000000000000",
				orderUid: uid(label),
			})),
			txs: batches.map(({ label, block }) => ({
				tx: hash(label),
				block,
				sender: SOLVER,
				recipient: NETWORK.contracts.settlement,
				gasUsed: 500_000,
				fee: "500001",
			})),
			prices: [{ block: 1, answer: 2_000e8 }],
			anchors: [
				{ block: 1, time: T0 },
				{ block: END, time: T0 + 2 * (END - 1) },
			],
		},
		range
	);
	store.setAuctionRange(range);
	store.setDetailRange(range);
	return store;
}

/**
 * CoW's API at `rate` requests per second, as far as these runs ask it: it has no competition for
 * any batch, its order book has every order, and it lists each order's trade, without fees. It
 * answers for the competitions of the `slow` transactions after a pause.
 */
function cowApi(batches: Batch[], rate: number, slow: string[] = []): CowApi {
	return {
		rate,
		async competitionByTx(tx: string) {
			if (slow.includes(tx)) await sleep(5);
			return null;
		},
		async orders(uids: string[]) {
			return new Map(uids.map((orderUid) => [orderUid, ORDER]));
		},
		async trades(orderUid: string): Promise<OrderTrade[]> {
			return batches
				.filter(({ label }) => uid(label) === orderUid)
				.map(({ block }) => ({ block, logIndex: 1, fees: [] }));
		},
	} as unknown as CowApi;
}

/** The CMS out of reach: runs go on with the cached registry. */
function offline(t: TestContext): void {
	t.mock.method(globalThis, "fetch", async () => {
		throw new TypeError("fetch failed");
	});
}

/**
 * Runs a sync against a node whose safe block is the end of the chain data, so there is no chain
 * to catch up, and returns the detail range at each snapshot it writes.
 */
async function snapshots(
	store: Store,
	cow: CowApi,
	options: Partial<SyncOptions> = {}
): Promise<(BlockRange | null)[]> {
	const rpc = {
		async call(method: string, params: unknown[]) {
			assert.deepEqual([method, params], ["eth_getBlockByNumber", ["safe", false]]);
			const block = store.chainRange()!.to;
			return {
				number: `0x${block.toString(16)}`,
				timestamp: `0x${store.timeOf(block).toString(16)}`,
			};
		},
	} as unknown as Rpc;
	const written: (BlockRange | null)[] = [];
	await sync(store, rpc, cow, {
		chainDays: 0,
		auctionDays: 0,
		budgetMinutes: null,
		prune: false,
		hypersync: null,
		...options,
		writeSnapshot: async () => {
			written.push(store.detailRange());
		},
	});
	return written;
}

describe("the details' wait before the snapshot", () => {
	test("is twice the lookups' time when it fits 8 minutes, and at least 2 minutes", () => {
		// About the lookups after BNB Chain's 2.5 hours without an RPC node on 15 Oct 2026.
		assert.equal(detailCatchUpWait(1_650, 5), 660_000);
		assert.equal(detailCatchUpWait(2_400, 5), 960_000);
		assert.equal(detailCatchUpWait(150, 5), 120_000);
		assert.equal(detailCatchUpWait(0, 5), 120_000);
	});

	test("is none for lookups that take longer", () => {
		assert.equal(detailCatchUpWait(2_401, 5), null);
		assert.equal(detailCatchUpWait(10, 0.01), null);
	});

	test("is whole milliseconds, rounded up", () => {
		// At COW_API_RPS=3 a request takes a third of a second: 200 take 66,666.67 ms.
		assert.equal(detailCatchUpWait(200, 3), 133_334);
	});

	test("is a delay AbortSignal.timeout takes, at every count of lookups that fits", () => {
		for (const rate of [3, 5]) {
			// The counts that take at most 8 minutes at the rate.
			for (let requests = 0; requests <= rate * 480; requests++) {
				const wait = detailCatchUpWait(requests, rate);
				assert.notEqual(wait, null);
				assert.doesNotThrow(() => AbortSignal.timeout(wait!));
			}
		}
	});
});

describe("a run's snapshots", () => {
	/** Batches in the last 3,000 blocks (100 minutes), which lack their details. */
	const recent = [
		{ label: "a", block: END - 2_500 },
		{ label: "b", block: END - 1_500 },
		{ label: "c", block: END - 500 },
	];
	/** Auction data and details 2.5 days deep: two whole days. */
	const auctionsFrom = END - 108_000;
	/** A batch in each of the first two block ranges of the backfill. */
	const older = [
		{ label: "first", block: auctionsFrom - 1_000 },
		{ label: "second", block: auctionsFrom - 3_000 },
	];

	test("wait for the details of the new blocks when their lookups fit", async (t) => {
		offline(t);
		const store = chainStore(recent);
		store.setDetailRange({ from: 1, to: END - 3_000 });
		// One request for the three orders and one for each one's trade: under a second at 5/s.
		assert.deepEqual(await snapshots(store, cowApi(recent, 5)), [{ from: 1, to: END }]);
	});

	test("go first when the lookups do not fit, and again once they are done", async (t) => {
		offline(t);
		const store = chainStore(recent);
		store.setDetailRange({ from: 1, to: END - 3_000 });
		// The same four requests take 40 minutes at one every 10 minutes.
		assert.deepEqual(await snapshots(store, cowApi(recent, 1 / 600)), [
			{ from: 1, to: END - 3_000 },
			{ from: 1, to: END },
		]);
	});

	test("are not written again for history short of a whole day", async (t) => {
		offline(t);
		const store = chainStore(older);
		store.setAuctionRange({ from: auctionsFrom, to: END });
		store.setDetailRange({ from: auctionsFrom, to: END });
		// The budget runs out at once, so the backfill stops in its second block range, whose
		// lookup answers after a pause.
		const cow = cowApi(older, 5, [hash("second")]);
		const written = await snapshots(store, cow, { auctionDays: 3, budgetMinutes: 0 });
		assert.deepEqual(store.auctionRange(), { from: auctionsFrom - 2_000, to: END });
		assert.deepEqual(written, [{ from: auctionsFrom, to: END }]);
	});

	test("are written again for a whole day more", async (t) => {
		offline(t);
		const store = chainStore(older);
		store.setAuctionRange({ from: auctionsFrom, to: END });
		store.setDetailRange({ from: auctionsFrom, to: END });
		const written = await snapshots(store, cowApi(older, 5), { auctionDays: 3 });
		assert.deepEqual(written, [
			{ from: auctionsFrom, to: END },
			{ from: END - 3 * DAY + 1, to: END },
		]);
	});
});

describe("the registry", () => {
	const cached: RegistryEntry = {
		address: "0x7070707070707070707070707070707070707070",
		env: "prod",
		active: true,
		solverId: "cached",
		name: "Cached",
	};

	test("is the cached copy when the CMS does not answer in time", async (t) => {
		const store = new Store(":memory:");
		store.replaceCmsEntries([cached]);
		// The CMS never answers: its request ends only when the signal aborts it.
		const fetch = t.mock.method(globalThis, "fetch", (_url: string, init: RequestInit) => {
			const { promise, reject } = Promise.withResolvers<Response>();
			init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
			return promise;
		});
		const registry = await refreshRegistry(store, AbortSignal.timeout(10));
		assert.equal(fetch.mock.callCount(), 1);
		assert.deepEqual(registry.identify(cached.address), { id: "cached", name: "Cached" });
		assert.deepEqual(store.cmsEntries(), [cached]);
	});

	test("is the cached copy when the CMS fails, after one attempt", async (t) => {
		const store = new Store(":memory:");
		store.replaceCmsEntries([cached]);
		const fetch = t.mock.method(
			globalThis,
			"fetch",
			async () => new Response(null, { status: 502 })
		);
		const registry = await refreshRegistry(store, new AbortController().signal);
		assert.equal(fetch.mock.callCount(), 1);
		assert.equal(registry.has(cached.address), true);
	});
});
