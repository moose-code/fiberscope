import { mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import { parseArgs } from "node:util";

import { NETWORKS } from "@fiberscope/core";

import { attributionReport, termsReport } from "./checks.ts";
import { DEFAULT_DB_PATH, DEFAULT_SNAPSHOT_PATH, type Env, NETWORK, readEnv } from "./config.ts";
import { CowApi } from "./cow.ts";
import { HyperSync } from "./hypersync.ts";
import { duration, fmt, log } from "./log.ts";
import { OVERRIDES } from "./overrides.ts";
import { Registry } from "./registry.ts";
import { Rpc } from "./rpc.ts";
import { seedDatabase } from "./seed.ts";
import { buildSnapshot } from "./snapshot.ts";
import { Store } from "./store.ts";
import { resolveSymbols } from "./symbols.ts";
import { sync } from "./sync.ts";
import { uploadSnapshot } from "./upload.ts";
import { windowReport } from "./window.ts";

const USAGE = `Usage:
  node src/cli.ts sync [--chain-days N] [--auction-days M] [--budget-minutes B] [--prune]
                       [--snapshot <path>]
      Catch up with the network's safe block, then backfill at least N days of chain data and M
      days of auction data, with the auctions' scores and the quotes and fees of the orders
      traded. Resumable and idempotent: a re-run fetches only what is missing. With
      --budget-minutes the backfill stops B minutes after the start and the next run resumes it.
      With --prune, once the head is caught up, chain data older than N days (at least M, as for
      the backfill) is deleted with its auction data, and so is the auction data of settlements
      older than M days; with both at 0 nothing is deleted. With --snapshot the snapshot is
      written once the head is caught up, and again at the end if it would show more: a whole
      day more of history, or the details of the new blocks when they caught up after it (on an
      empty database, only after the backfill).
  node src/cli.ts snapshot [--out <path>]
      Write the snapshot JSON (default ${relative(process.cwd(), DEFAULT_SNAPSHOT_PATH)}).
  node src/cli.ts window --from <block> --to <block>
      Print totals and the per-solver table for a block range, from the database, with scores,
      quotes and protocol fees where the detail range covers it.
  node src/cli.ts attribution --from <block> --to <block>
      Compare, from the database, each batch's credited solver address in a block range with the
      solver address of the winning solution for its transaction in CoW's competition data.
  node src/cli.ts terms --from <block> --to <block> [--sample N]
      Count the trades with order terms decoded from settle() calldata, by route, then sample
      about N of them (default 90) across the range and the routes: reread and decode each
      transaction from the RPC, compare its executed fee with its Trade event's, and compare the
      signed order with CoW's order book.
  node src/cli.ts seed --url <url>
      Download a database from <url> when there is none yet, e.g. to move the indexer to a new
      host without indexing again. It is integrity-checked before it is used.

Every command takes --db <path> (default DB_PATH, else ${relative(process.cwd(), DEFAULT_DB_PATH)}).
Environment: NETWORK, the network to index (${Object.keys(NETWORKS).join(" or ")}, default base), and
its RPC endpoint and rate: BASE_RPC_URL and BASE_RPC_RPS, or BNB_RPC_URL (required) and
BNB_RPC_RPS. With ENVIO_API_TOKEN, sync reads the chain's logs, receipts and calldata from
HyperSync (HYPERSYNC_URL, default https://${NETWORK.chainId}.hypersync.xyz) instead of the RPC.
Also COW_API_RPS, REFRESH_MINUTES and GIT_COMMIT. With SNAPSHOT_R2_BUCKET (plus
CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and optionally SNAPSHOT_R2_KEY,
default ${NETWORK.id}/snapshot.json) every snapshot written is also uploaded to that R2 bucket.
`;

async function main(): Promise<void> {
	const { positionals, values } = parseArgs({
		allowPositionals: true,
		options: {
			"chain-days": { type: "string" },
			"auction-days": { type: "string" },
			"budget-minutes": { type: "string" },
			prune: { type: "boolean" },
			snapshot: { type: "string" },
			out: { type: "string" },
			from: { type: "string" },
			to: { type: "string" },
			sample: { type: "string" },
			db: { type: "string" },
			url: { type: "string" },
			help: { type: "boolean", short: "h" },
		},
	});
	const [command] = positionals;
	if (values.help || positionals.length !== 1) {
		process.stdout.write(USAGE);
		if (!values.help) process.exitCode = 2;
		return;
	}
	const env = readEnv();
	const dbPath = values.db ?? env.dbPath;
	if (command === "seed") {
		if (values.url === undefined) throw new Error("seed needs --url <url>");
		const started = performance.now();
		const bytes = await seedDatabase(values.url, dbPath);
		log(
			`seed: ${dbPath} (${fmt(bytes / 1e6, 1)} MB) in ${duration((performance.now() - started) / 1000)}`
		);
		return;
	}
	const store = new Store(dbPath);
	try {
		if (command === "sync") {
			const budget = values["budget-minutes"];
			const snapshotPath = values.snapshot;
			const rpc = new Rpc(env.rpcUrl, env.rpcRps);
			const cow = new CowApi(NETWORK.cowApi, env.cowApiRps);
			const hypersync =
				env.hypersync === null
					? null
					: new HyperSync(env.hypersync.url, env.hypersync.token);
			const options = {
				chainDays: wholeNumber(values["chain-days"], "chain-days", 0),
				auctionDays: wholeNumber(values["auction-days"], "auction-days", 0),
				budgetMinutes:
					budget === undefined ? null : wholeNumber(budget, "budget-minutes", null),
				prune: values.prune === true,
				hypersync,
				writeSnapshot:
					snapshotPath === undefined
						? null
						: () => writeSnapshot(store, rpc, env, snapshotPath),
			};
			const started = performance.now();
			const stats = await sync(store, rpc, cow, options);
			const chain = store.chainRange()!;
			const auctions = store.auctionRange();
			const details = store.detailRange();
			const { receipts, seconds: chainSeconds } = stats.chain;
			const { lookups, missing, seconds: auctionSeconds } = stats.auctions;
			log(`sync: done in ${duration((performance.now() - started) / 1000)}`);
			log(
				`  chain ${chain.from}..${chain.to}: ${fmt(receipts)} receipts in ${duration(chainSeconds)} ` +
					`(${rate(receipts, chainSeconds)}/s); ${fmt(rpc.stats.calls)} RPC calls, ` +
					`${fmt(rpc.stats.retries)} retried requests`
			);
			// By method too, as providers that price methods differently count them.
			const byMethod = Object.entries(rpc.stats.byMethod)
				.sort(([, a], [, b]) => b - a)
				.map(([method, calls]) => `${method} ${fmt(calls)}`);
			log(`  RPC calls by method: ${byMethod.join(", ") || "none"}`);
			if (hypersync !== null) {
				const { queries, retries, bytes } = hypersync.stats;
				log(
					`  HyperSync: ${fmt(queries)} queries, ${fmt(bytes / 1e6)} MB uncompressed, ` +
						`${fmt(retries)} retries`
				);
			}
			log(
				`  auctions ${auctions ? `${auctions.from}..${auctions.to}` : "none"}: ${fmt(lookups)} lookups ` +
					`(${fmt(missing)} not found) in ${duration(auctionSeconds)} ` +
					`(${rate(lookups, auctionSeconds)}/s), ${fmt(cow.stats.bytes / 1e6)} MB uncompressed, ` +
					`${fmt(cow.stats.retries)} retries`
			);
			log(
				`  details ${details ? `${details.from}..${details.to}` : "none"}: ` +
					`${fmt(stats.details.scores)} auctions scored, ${fmt(stats.details.orders)} orders, ` +
					`${fmt(stats.details.fees)} fee lookups in ${duration(stats.details.seconds)}`
			);
			store.checkpoint();
			log(`  database ${dbPath}: ${fmt(statSync(dbPath).size / 1e6, 1)} MB`);
		} else if (command === "snapshot") {
			const rpc = new Rpc(env.rpcUrl, env.rpcRps);
			await writeSnapshot(store, rpc, env, values.out ?? DEFAULT_SNAPSHOT_PATH);
		} else if (command === "window" || command === "attribution" || command === "terms") {
			const from = wholeNumber(values.from, "from", null);
			const to = wholeNumber(values.to, "to", null);
			if (from > to) throw new Error("--from must not be after --to");
			const registry = new Registry(store.cmsEntries(), OVERRIDES);
			const range = { from, to };
			if (command === "window") process.stdout.write(windowReport(store, registry, range));
			else if (command === "attribution") {
				process.stdout.write(attributionReport(store, registry, range));
			} else {
				const rpc = new Rpc(env.rpcUrl, env.rpcRps);
				const cow = new CowApi(NETWORK.cowApi, env.cowApiRps);
				const sample = wholeNumber(values.sample, "sample", 90);
				process.stdout.write(await termsReport(store, rpc, cow, range, sample));
			}
		} else {
			throw new Error(`unknown command "${command}"\n\n${USAGE}`);
		}
	} finally {
		store.close();
	}
}

/**
 * Builds the snapshot and writes it to `out` atomically: to a temporary file in the same
 * directory, then renamed over `out`, so a reader never sees half a file. Then uploads it, when
 * R2 is configured; a failed upload is logged and sets the exit code without stopping the run.
 */
async function writeSnapshot(store: Store, rpc: Rpc, env: Env, out: string): Promise<void> {
	const started = performance.now();
	const { snapshot, stats } = await buildSnapshot({
		store,
		registry: new Registry(store.cmsEntries(), OVERRIDES),
		refreshMinutes: env.refreshMinutes,
		commit: env.commit,
		symbols: (tokens) => resolveSymbols(rpc, store, tokens),
	});
	const json = JSON.stringify(snapshot);
	mkdirSync(dirname(out), { recursive: true });
	const temporary = `${out}.${process.pid}.tmp`;
	writeFileSync(temporary, json);
	renameSync(temporary, out);
	const { chainDays, auctionDays, surplusDays, detailDays } = snapshot.coverage;
	const seconds = (performance.now() - started) / 1000;
	log(
		`snapshot: ${out} (${fmt(json.length / 1024)} KB) in ${duration(seconds)}, ` +
			`end block ${snapshot.end.block}, ${chainDays} chain days, ${auctionDays} auction days, ` +
			`${surplusDays} surplus days, ${detailDays} detail days, ` +
			`${snapshot.solvers.length} solvers`
	);
	log(
		`  trades in the auction days: ${fmt(stats.trades)}, ${fmt(stats.unpriced)} unpriced, ` +
			`${fmt(stats.oneSided)} priced on one side only`
	);
	log(
		`  priced trades in the surplus days: ${fmt(stats.surplusPriced)}, ` +
			`${fmt(stats.noSurplus)} without order terms, ${fmt(stats.unusual)} with unusual ` +
			`surplus; batches without the ${NETWORK.native.symbol}/USD rate: ${fmt(stats.uncosted)}`
	);
	log(
		`  trades in the detail days: ${fmt(stats.detailTrades)}, ${fmt(stats.unknownFees)} ` +
			`without fee data, ${fmt(stats.unnamedQuotes)} with a quote that names no solver; ` +
			`fees not valued: ${fmt(stats.unvaluedFees)}, not marked CoW's or a partner's: ` +
			`${fmt(stats.unsplitFees)}`
	);
	if (env.upload) {
		const { bucket, key } = env.upload;
		const uploadStarted = performance.now();
		try {
			await uploadSnapshot(env.upload, json);
			log(
				`  uploaded to R2 ${bucket}/${key} in ${duration((performance.now() - uploadStarted) / 1000)}`
			);
		} catch (error) {
			process.exitCode = 1;
			process.stderr.write(
				`  upload to R2 ${bucket}/${key} failed: ${error instanceof Error ? error.message : error}\n`
			);
		}
	}
}

function wholeNumber(value: string | undefined, name: string, fallback: number | null): number {
	if (value === undefined) {
		if (fallback === null) throw new Error(`--${name} is required`);
		return fallback;
	}
	if (!/^\d+$/.test(value)) throw new Error(`--${name} must be a whole number, got "${value}"`);
	return Number(value);
}

function rate(count: number, seconds: number): string {
	return seconds > 0 ? (count / seconds).toFixed(2) : "0";
}

main().catch((error: unknown) => {
	process.stderr.write(
		`error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
	);
	process.exit(1);
});
