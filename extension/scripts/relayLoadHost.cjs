const net = require("node:net");
const path = require("node:path");
const { monitorEventLoopDelay } = require("node:perf_hooks");
const readline = require("node:readline");

const dist = path.join(__dirname, "..", "dist");
const { HostedRelay } = require(path.join(dist, "extension", "src", "relay", "hostedRelay.js"));
const { startRelayServer } = require(path.join(dist, "shared", "relayServer.js"));
const { generateRelayCertificate } = require(path.join(dist, "shared", "relayCertificate.js"));
const { accessOptions } = require(path.join(__dirname, "..", "..", "test-support", "relay.cjs"));

function createLogger() {
	if (process.versions.electron) {
		const { Logger } = require(path.join(dist, "extension", "src", "logger.js"));
		const output = new Logger("Dev Chat Relay Load Test");
		return {
			logger: {
				info: (message) => output.info(`[relay] ${message}`),
				error: (message) => output.error(`[relay] ${message}`),
			},
			dispose: () => output.dispose(),
		};
	}
	return {
		logger: {
			info: (message) => console.log(`[INFO ${new Date().toISOString()}] [relay] ${message}`),
			error: (message) => console.error(`[ERROR ${new Date().toISOString()}] [relay] ${message}`),
		},
		dispose() {},
	};
}

async function run() {
	const port = Number(process.env.DEVCHAT_LOAD_CONTROL_PORT);
	const token = process.env.DEVCHAT_LOAD_CONTROL_TOKEN;
	if (!Number.isInteger(port) || port < 1 || port > 65535 || !token) {
		throw new Error("Relay load control settings are missing.");
	}

	const control = net.createConnection(port, "127.0.0.1");
	const lines = readline.createInterface({ input: control, crlfDelay: Infinity });
	const send = (message) => control.write(`${JSON.stringify(message)}\n`);
	const output = createLogger();
	const hosted = new HostedRelay(
		output.logger,
		(options) => startRelayServer({ ...options, host: "127.0.0.1" }),
		() => []
	);
	const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
	let samplingTimer;
	let baselineRss = 0;
	let peakRss = 0;
	let startCpu;
	let startTime;
	const sampleMemory = () => { peakRss = Math.max(peakRss, process.memoryUsage().rss); };

	try {
		await new Promise((resolve, reject) => {
			control.once("connect", resolve);
			control.once("error", reject);
		});
		send({ type: "hello", token, pid: process.pid, electron: Boolean(process.versions.electron) });
		for await (const line of lines) {
			const message = JSON.parse(line);
			if (message.type === "start") {
				const certificate = await generateRelayCertificate();
				const access = accessOptions({ publicKey: message.adminPublicKey }, message.joinCode);
				const info = await hosted.start(0, certificate, access);
				send({ type: "started", url: info.localUrl, port: info.port });
			} else if (message.type === "baseline") {
				baselineRss = process.memoryUsage().rss;
				peakRss = baselineRss;
				samplingTimer = setInterval(sampleMemory, 500);
				samplingTimer.unref();
				send({ type: "baseline", rssBytes: baselineRss });
			} else if (message.type === "begin") {
				eventLoopDelay.reset();
				eventLoopDelay.enable();
				startCpu = process.cpuUsage();
				startTime = process.hrtime.bigint();
				send({ type: "began" });
			} else if (message.type === "end") {
				if (!startCpu || startTime === undefined) throw new Error("Resource measurement was not started.");
				const cpu = process.cpuUsage(startCpu);
				const seconds = Number(process.hrtime.bigint() - startTime) / 1e9;
				sampleMemory();
				eventLoopDelay.disable();
				send({
					type: "resources",
					seconds,
					averageCpuPercent: (cpu.user + cpu.system) / 1e6 / seconds * 100,
					baselineRssBytes: baselineRss,
					peakRssBytes: peakRss,
					peakAdditionalRssBytes: Math.max(0, peakRss - baselineRss),
					eventLoopP99Ms: eventLoopDelay.percentile(99) / 1e6,
					eventLoopMaxMs: eventLoopDelay.max / 1e6,
				});
			} else if (message.type === "finish") {
				if (!samplingTimer) throw new Error("Memory measurement was not started.");
				clearInterval(samplingTimer);
				samplingTimer = undefined;
				sampleMemory();
				send({
					type: "final_resources",
					peakRssBytes: peakRss,
					peakAdditionalRssBytes: Math.max(0, peakRss - baselineRss),
				});
			} else if (message.type === "stop") {
				await hosted.stop();
				send({ type: "stopped" });
				break;
			} else {
				throw new Error("Unknown relay load control command.");
			}
		}
	} catch (error) {
		if (!control.destroyed) send({ type: "error", message: error instanceof Error ? error.message : String(error) });
		throw error;
	} finally {
		clearInterval(samplingTimer);
		eventLoopDelay.disable();
		await hosted.stop();
		output.dispose();
		lines.close();
		control.end();
	}
}

module.exports = { run };

if (require.main === module) {
	run().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
