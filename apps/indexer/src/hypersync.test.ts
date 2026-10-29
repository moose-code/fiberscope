import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, test } from "node:test";
import type { TestContext } from "node:test";

import { HyperSync } from "./hypersync.ts";

/** The fake server's token; no message may show it. */
const TOKEN = "0123456789abcdef0123456789abcdef";
const SETTLEMENT = "0x9008d19f58aabd9ed0d60971565aa8510560ab41";
const TOPIC = "0x40338ce1a7c49204f0099533b1e9a7ee0a3d261f84974ab7af36105b8c4e9db4";
const SOLVER_TOPIC = "0x0000000000000000000000005050505050505050505050505050505050505050";
const SOLVER = "0x5050505050505050505050505050505050505050";

interface Query {
	from_block: number;
	to_block: number;
	logs: { address: string[]; topics: string[][] }[];
	field_selection: Record<string, string[]>;
}

/** An HTTP response of the fake server; `body` is sent as JSON unless it is a string. */
interface Answer {
	status?: number;
	headers?: Record<string, string>;
	body: unknown;
}

/**
 * A HyperSync server on localhost that answers query `n` (from 0) as `answer` says. Returns a
 * client of it, and the queries and authorization headers it got.
 */
async function server(
	t: TestContext,
	answer: (query: Query, n: number) => Answer
): Promise<{ hypersync: HyperSync; queries: Query[]; tokens: string[] }> {
	const queries: Query[] = [];
	const tokens: string[] = [];
	const http = createServer(async (request, response) => {
		let body = "";
		for await (const chunk of request) body += chunk;
		const query = JSON.parse(body) as Query;
		const { status = 200, headers = {}, body: reply } = answer(query, queries.length);
		queries.push(query);
		tokens.push(request.headers.authorization ?? "");
		response.writeHead(status, { "content-type": "application/json", ...headers });
		response.end(typeof reply === "string" ? reply : JSON.stringify(reply));
	});
	await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
	t.after(() => {
		http.close();
		http.closeAllConnections();
	});
	const { port } = http.address() as AddressInfo;
	return { hypersync: new HyperSync(`http://127.0.0.1:${port}/`, TOKEN), queries, tokens };
}

/** A Settlement log of the solver in a transaction spelled from a readable label. */
function settlementLog(block: number, logIndex: number, label: string) {
	return {
		block_number: block,
		log_index: logIndex,
		transaction_hash: hash(label),
		address: SETTLEMENT,
		data: "0x",
		topic0: TOPIC,
		topic1: SOLVER_TOPIC,
		topic2: null,
		topic3: null,
	};
}

/** A transaction hash spelled from a readable label. */
function hash(label: string): string {
	return `0x${Buffer.from(label).toString("hex").padStart(64, "0")}`;
}

/** A reply with these logs, up to `next` (excluded), HyperSync being at block 1,000. */
function reply(next: number, logs: unknown[] = []): Answer {
	return { body: { data: [{ logs }], next_block: next, archive_height: 1_000 } };
}

/**
 * The lines `log` writes while `run` runs, without their time of day. Anything else written to
 * stdout, such as the test runner's own output, goes through.
 */
async function logged(t: TestContext, run: () => Promise<void>): Promise<string[]> {
	const lines: string[] = [];
	const write = process.stdout.write;
	const mocked = t.mock.method(process.stdout, "write", (chunk: unknown, ...rest: unknown[]) => {
		const line = typeof chunk === "string" ? /^\d\d:\d\d:\d\d (.*)\n$/s.exec(chunk) : null;
		if (line === null) return Reflect.apply(write, process.stdout, [chunk, ...rest]);
		lines.push(line[1]);
		return true;
	});
	try {
		await run();
	} finally {
		mocked.mock.restore();
	}
	return lines;
}

describe("HyperSync", () => {
	test("gives a range's logs as eth_getLogs does, with block times, receipts and calldata", async (t) => {
		const { hypersync, queries, tokens } = await server(t, () => ({
			body: {
				data: [
					{
						logs: [settlementLog(100, 5, "z"), settlementLog(150, 2, "b")],
						transactions: [
							{
								block_number: 100,
								hash: hash("z").toUpperCase().replace("0X", "0x"),
								from: SOLVER,
								to: SETTLEMENT,
								gas_used: "0x0a",
								effective_gas_price: "0x02",
								l1_fee: "0x03",
								input: "0x13d79a0b",
							},
						],
						blocks: [{ number: 100, timestamp: "0x6ae1e611" }],
					},
					// A batch leaves out the tables it has no rows of. This transaction pays no L1
					// data fee, as on BNB Chain.
					{
						transactions: [
							{
								block_number: 150,
								hash: hash("b"),
								from: SOLVER,
								to: SETTLEMENT,
								gas_used: "0x0b",
								effective_gas_price: "0x02",
								l1_fee: null,
								input: "0x13d79a0b",
							},
						],
					},
				],
				next_block: 201,
				archive_height: 1_000,
			},
		}));
		const found = await hypersync.logs(100, 200, [SETTLEMENT], [[TOPIC]]);
		assert.equal(queries.length, 1);
		assert.deepEqual(tokens, [`Bearer ${TOKEN}`]);
		const [query] = queries;
		// The end block is excluded from HyperSync's range, included in the indexer's.
		assert.equal(query.from_block, 100);
		assert.equal(query.to_block, 201);
		assert.deepEqual(query.logs, [{ address: [SETTLEMENT], topics: [[TOPIC]] }]);
		assert.deepEqual(found.logs, [
			{
				address: SETTLEMENT,
				topics: [TOPIC, SOLVER_TOPIC],
				data: "0x",
				blockNumber: "0x64",
				transactionHash: hash("z"),
				logIndex: "0x5",
				blockTimestamp: "0x6ae1e611",
			},
			// Its block's time did not come with it: the clock reads the range's headers instead.
			{
				address: SETTLEMENT,
				topics: [TOPIC, SOLVER_TOPIC],
				data: "0x",
				blockNumber: "0x96",
				transactionHash: hash("b"),
				logIndex: "0x2",
			},
		]);
		assert.deepEqual(
			found.receipts,
			new Map([
				[
					hash("z"),
					{
						blockNumber: "0x64",
						from: SOLVER,
						to: SETTLEMENT,
						gasUsed: "0x0a",
						effectiveGasPrice: "0x02",
						l1Fee: "0x03",
					},
				],
				[
					hash("b"),
					{
						blockNumber: "0x96",
						from: SOLVER,
						to: SETTLEMENT,
						gasUsed: "0x0b",
						effectiveGasPrice: "0x02",
					},
				],
			])
		);
		assert.deepEqual(
			found.inputs,
			new Map([
				[hash("z"), "0x13d79a0b"],
				[hash("b"), "0x13d79a0b"],
			])
		);
	});

	test("asks again from where a response stopped until the range ends", async (t) => {
		const { hypersync, queries } = await server(t, (_query, n) =>
			n === 0
				? reply(150, [settlementLog(120, 1, "a")])
				: reply(201, [settlementLog(180, 1, "b")])
		);
		const found = await hypersync.logs(100, 200, [SETTLEMENT], [[TOPIC]]);
		assert.deepEqual(
			queries.map((query) => [query.from_block, query.to_block]),
			[
				[100, 201],
				[150, 201],
			]
		);
		assert.deepEqual(
			found.logs.map((entry) => entry.blockNumber),
			["0x78", "0xb4"]
		);
		assert.equal(hypersync.stats.queries, 2);
		assert.equal(hypersync.stats.retries, 0);
	});

	test("waits for HyperSync to reach the range, and logs it", async (t) => {
		const { hypersync, queries } = await server(t, (_query, n) =>
			n === 0
				? { body: { data: [], next_block: 100, archive_height: 99 } }
				: reply(201, [settlementLog(150, 1, "a")])
		);
		let found: Awaited<ReturnType<HyperSync["logs"]>> | undefined;
		const lines = await logged(t, async () => {
			found = await hypersync.logs(100, 200, [SETTLEMENT], [[TOPIC]]);
		});
		assert.equal(queries.length, 2);
		assert.equal(found!.logs.length, 1);
		assert.equal(lines.length, 1);
		assert.match(
			lines[0],
			/^hypersync: at block 99, behind block 100; asking again in \d\.\ds \(attempt 2 of 5\)$/
		);
	});

	test("retries a server error and waits out a rate limit, logging why", async (t) => {
		const { hypersync, queries } = await server(t, (_query, n) => {
			if (n === 0) return { status: 502, body: "<html>Bad Gateway</html>" };
			if (n === 1) {
				return {
					status: 429,
					headers: { "retry-after": "1" },
					body: { error: "Too many requests" },
				};
			}
			return reply(201);
		});
		const started = performance.now();
		const lines = await logged(t, async () => {
			await hypersync.logs(100, 200, [SETTLEMENT], [[TOPIC]]);
		});
		assert.equal(queries.length, 3);
		// The third query after the rate limit's pause.
		assert.ok(performance.now() - started >= 990);
		assert.deepEqual(hypersync.stats, {
			queries: 3,
			retries: 2,
			bytes: hypersync.stats.bytes,
		});
		assert.equal(lines.length, 2);
		assert.match(
			lines[0],
			/^hypersync: retrying a query in .* \(attempt 2 of 12\): HTTP 502: Bad Gateway$/
		);
		assert.match(
			lines[1],
			/^hypersync: retrying a query in 1\.0s \(attempt 3 of 12\): HTTP 429: Too many requests$/
		);
	});

	test("fails at once, without the token, when HyperSync refuses it", async (t) => {
		const { hypersync, queries } = await server(t, () => ({
			status: 401,
			body: { error: `Your token ${TOKEN} is malformed.` },
		}));
		await assert.rejects(hypersync.logs(100, 200, [SETTLEMENT], [[TOPIC]]), {
			name: "EndpointError",
			message: "HyperSync refuses the token (HTTP 401: Your token <redacted> is malformed.)",
		});
		assert.equal(queries.length, 1);
	});

	test("fails at once on a query HyperSync refuses, or a wait over a minute", async (t) => {
		const refusals: [Answer, string][] = [
			[
				{ status: 400, body: { error: "unknown field `blok`" } },
				"HyperSync refuses the query (HTTP 400: unknown field `blok`)",
			],
			[
				{ status: 429, headers: { "retry-after": "120" }, body: { error: "quota" } },
				"HyperSync asks to wait 120s (HTTP 429: quota)",
			],
		];
		for (const [answer, message] of refusals) {
			const { hypersync, queries } = await server(t, () => answer);
			await assert.rejects(hypersync.logs(100, 200, [SETTLEMENT], [[TOPIC]]), {
				name: "EndpointError",
				message,
			});
			assert.equal(queries.length, 1);
		}
	});
});
