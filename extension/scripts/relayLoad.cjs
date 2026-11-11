const assert = require("node:assert/strict");
const { spawn, execFile } = require("node:child_process");
const { randomBytes, randomUUID } = require("node:crypto");
const fs = require("node:fs/promises");
const https = require("node:https");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const tls = require("node:tls");
const { promisify } = require("node:util");
const WebSocket = require("ws");

const dist = path.join(__dirname, "..", "dist");
const { RelayClient } = require(path.join(dist, "extension", "src", "relay", "relayClient.js"));
const { formatPinnedRelayUrl } = require(path.join(dist, "extension", "src", "relay", "relaySettings.js"));
const authentication = require(path.join(dist, "shared", "relayAuthentication.js"));
const { createIdentity } = require(path.join(__dirname, "..", "..", "test-support", "relay.cjs"));
const execFileAsync = promisify(execFile);
const MIB = 1024 * 1024;
const RATE_LIMIT = 20;
const BURST_EXTRA = 5;

function parseOptions(args) {
	const values = {};
	const names = new Set([
		"mode", "image", "code-path", "clients", "rate", "duration-seconds", "payload-bytes",
		"cpu-limit", "memory-limit-mib", "reconnect-seconds",
	]);
	for (let index = 0; index < args.length; index += 2) {
		const key = args[index];
		if (!key?.startsWith("--") || !names.has(key.slice(2)) || args[index + 1] === undefined) {
			throw new Error(`Unknown or incomplete argument: ${key ?? "(missing)"}`);
		}
		if (Object.hasOwn(values, key)) throw new Error(`Duplicate argument: ${key}`);
		values[key] = args[index + 1];
	}
	const mode = values["--mode"] ?? "hosted";
	if (!["hosted", "vscode", "docker"].includes(mode)) throw new Error("Mode must be hosted, vscode, or docker.");
	if (mode === "docker" && !values["--image"]) throw new Error("Docker mode requires --image.");

	function number(name, fallback, min, max, integer = true) {
		const value = values[`--${name}`] === undefined ? fallback : Number(values[`--${name}`]);
		if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
			throw new Error(`--${name} must be ${integer ? "an integer" : "a number"} between ${min} and ${max}.`);
		}
		return value;
	}
	return {
		mode,
		image: values["--image"],
		codePath: values["--code-path"],
		clients: number("clients", 25, 1, 1000),
		rate: number("rate", 5, 1, RATE_LIMIT - 1),
		durationSeconds: number("duration-seconds", 600, 1, 86400),
		payloadBytes: number("payload-bytes", 1024, 1, 6000),
		cpuLimit: number("cpu-limit", mode === "docker" ? 80 : 25, 0.01, 10000, false),
		memoryLimitMiB: number("memory-limit-mib", mode === "docker" ? 512 : 256, 1, 1048576, false),
		reconnectSeconds: number("reconnect-seconds", 30, 1, 600),
	};
}

function delay(milliseconds) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function withTimeout(promise, milliseconds, message) {
	let timer;
	return Promise.race([
		promise,
		new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); }),
	]).finally(() => clearTimeout(timer));
}

function messageChannel(socket) {
	const queued = [];
	let buffer = "";
	let waiter;
	let failure;
	socket.setEncoding("utf8");
	const fail = (error) => {
		failure = error;
		if (waiter) {
			const current = waiter;
			waiter = undefined;
			current.reject(error);
		}
	};
	socket.on("data", (chunk) => {
		buffer += chunk;
		if (buffer.length > 65536) {
			fail(new Error("Relay load control message is too large."));
			socket.destroy();
			return;
		}
		let newline;
		while ((newline = buffer.indexOf("\n")) !== -1) {
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			let message;
			try {
				message = JSON.parse(line);
			} catch {
				fail(new Error("Relay load control sent invalid JSON."));
				socket.destroy();
				return;
			}
			if (waiter) {
				const current = waiter;
				waiter = undefined;
				current.resolve(message);
			} else {
				queued.push(message);
			}
		}
	});
	socket.on("error", fail);
	socket.on("close", () => fail(new Error("Relay load control disconnected.")));
	return {
		send: (message) => socket.write(`${JSON.stringify(message)}\n`),
		next: () => {
			if (queued.length) return Promise.resolve(queued.shift());
			if (failure) return Promise.reject(failure);
			if (waiter) return Promise.reject(new Error("Concurrent relay load control reads are not supported."));
			return new Promise((resolve, reject) => { waiter = { resolve, reject }; });
		},
		close: () => socket.destroy(),
	};
}

function captureOutput(child) {
	let tail = "";
	const append = (chunk) => { tail = (tail + chunk.toString()).slice(-8000); };
	child.stdout?.on("data", append);
	child.stderr?.on("data", append);
	return () => tail;
}

async function waitForExit(child, timeout) {
	if (child.exitCode !== null || child.signalCode !== null) return;
	await withTimeout(new Promise((resolve) => child.once("exit", resolve)), timeout, "The test process did not exit.");
}

async function stopChild(child) {
	if (!child || child.exitCode !== null || child.signalCode !== null) return;
	if (!child.kill()) throw new Error("Could not stop the test process.");
	await waitForExit(child, 10_000);
}

async function startHosted(options, admin, joinCode) {
	const token = randomBytes(32).toString("hex");
	const listener = net.createServer();
	await new Promise((resolve, reject) => {
		listener.once("error", reject);
		listener.listen(0, "127.0.0.1", resolve);
	});
	const controlPort = listener.address().port;
	const accepted = new Promise((resolve) => {
		listener.on("connection", (socket) => {
			const channel = messageChannel(socket);
			withTimeout(channel.next(), 3000, "Relay load control did not identify itself.").then((message) => {
				if (message.type !== "hello" || message.token !== token) {
					channel.close();
					return;
				}
				resolve({ channel, hello: message });
			}).catch(() => channel.close());
		});
	});
	const worker = path.join(__dirname, "relayLoadHost.cjs");
	const env = {
		...process.env,
		DEVCHAT_LOAD_CONTROL_PORT: String(controlPort),
		DEVCHAT_LOAD_CONTROL_TOKEN: token,
	};
	let tempDir;
	let child;
	let output = () => "";
	let channel;
	try {
		if (options.mode === "vscode") {
			tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "devchat-vscode-load-"));
			const userData = path.join(tempDir, "user-data");
			const settings = path.join(userData, "User");
			await fs.mkdir(settings, { recursive: true });
			await fs.writeFile(path.join(settings, "settings.json"), JSON.stringify({
				"telemetry.telemetryLevel": "off",
				"update.mode": "none",
				"extensions.autoUpdate": false,
			}));
			const codePath = options.codePath ?? (process.platform === "win32"
				? path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Microsoft VS Code", "Code.exe")
				: "code");
			child = spawn(codePath, [
				`--user-data-dir=${userData}`,
				`--extensions-dir=${path.join(tempDir, "extensions")}`,
				"--disable-extensions",
				"--disable-telemetry",
				"--skip-welcome",
				"--skip-release-notes",
				"--disable-workspace-trust",
				"--new-window",
				"--wait",
				`--extensionDevelopmentPath=${path.join(__dirname, "..")}`,
				`--extensionTestsPath=${worker}`,
			], { env, stdio: ["ignore", "pipe", "pipe"] });
		} else {
			child = spawn(process.execPath, [worker], { env, stdio: ["ignore", "pipe", "pipe"] });
		}
		output = captureOutput(child);
		const spawnError = new Promise((_, reject) => child.once("error", reject));
		const result = await withTimeout(
			Promise.race([accepted, spawnError]),
			25_000,
			"Hosted relay test process did not connect."
		);
		channel = result.channel;
		listener.close();
		if (options.mode === "vscode" && !result.hello.electron) {
			throw new Error("The VS Code test did not run in an Electron extension host.");
		}
		async function command(type, fields = {}, responseType = type) {
			channel.send({ type, ...fields });
			const response = await withTimeout(channel.next(), 30_000, `Relay load command ${type} timed out.`);
			if (response.type === "error") throw new Error(response.message);
			if (response.type !== responseType) throw new Error(`Unexpected relay load response: ${response.type}`);
			return response;
		}
		const started = await command("start", { adminPublicKey: admin.publicKey, joinCode }, "started");
		return {
			url: started.url,
			runtime: result.hello.electron ? "VS Code extension host" : "Node.js hosted relay process",
			baseline: () => command("baseline"),
			begin: () => command("begin", {}, "began"),
			end: () => command("end", {}, "resources"),
			finish: () => command("finish", {}, "final_resources"),
			stop: async () => {
				try {
					await command("stop", {}, "stopped");
					await waitForExit(child, 15_000);
				} finally {
					channel.close();
					await stopChild(child);
					if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
				}
			},
		};
	} catch (error) {
		listener.close();
		channel?.close();
		await stopChild(child);
		if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
		throw new Error(`${error instanceof Error ? error.message : String(error)}\n${output()}`);
	}
}

async function docker(args, timeout = 20_000) {
	try {
		const result = await execFileAsync("docker", args, { timeout, maxBuffer: 1024 * 1024 });
		return result.stdout.trim();
	} catch (error) {
		throw new Error(`Docker ${args[0]} failed: ${error.stderr?.trim() || error.message}`);
	}
}

function dockerMemoryBytes(value) {
	const match = value.match(/^\s*(\d+(?:\.\d+)?)\s*([KMGT]?i?B)\s*\//i);
	if (!match) throw new Error(`Could not parse Docker memory usage: ${value}`);
	const unit = match[2].toUpperCase();
	const power = { B: 0, KB: 1, KIB: 1, MB: 2, MIB: 2, GB: 3, GIB: 3, TB: 4, TIB: 4 }[unit];
	if (power === undefined) throw new Error(`Unknown Docker memory unit: ${unit}`);
	const bytes = Number(match[1]) * (unit.includes("I") ? 1024 : 1000) ** power;
	if (!Number.isFinite(bytes)) throw new Error(`Could not parse Docker memory usage: ${value}`);
	return bytes;
}

function dockerCpuPercent(value) {
	const match = value.match(/^\s*(\d+(?:\.\d+)?)%\s*$/);
	if (!match || !Number.isFinite(Number(match[1]))) {
		throw new Error(`Could not parse Docker CPU usage: ${value}`);
	}
	return Number(match[1]);
}

function meetsResourceLimits(options, resources) {
	const memoryBytes = options.mode === "docker" ? resources.peakMemoryBytes : resources.peakAdditionalRssBytes;
	if (!Number.isFinite(resources.averageCpuPercent) || resources.averageCpuPercent < 0 ||
		!Number.isFinite(memoryBytes) || memoryBytes < 0) {
		throw new Error("Relay resource measurements are invalid.");
	}
	return resources.averageCpuPercent < options.cpuLimit && memoryBytes < options.memoryLimitMiB * MIB;
}

function dockerSampler(name) {
	let timer;
	let inFlight;
	let failure;
	let measuring = false;
	let peakMemoryBytes = 0;
	const cpuSamples = [];
	async function sample() {
		const line = await docker(["stats", "--no-stream", "--format", "{{.CPUPerc}};{{.MemUsage}}", name]);
		const separator = line.indexOf(";");
		if (separator < 0) throw new Error(`Could not parse Docker resource sample: ${line}`);
		const cpu = dockerCpuPercent(line.slice(0, separator));
		peakMemoryBytes = Math.max(peakMemoryBytes, dockerMemoryBytes(line.slice(separator + 1)));
		if (measuring) cpuSamples.push(cpu);
	}
	function schedule() {
		if (inFlight) return;
		inFlight = sample().catch((error) => { failure = error; }).finally(() => { inFlight = undefined; });
	}
	return {
		start: async () => {
			await sample();
			timer = setInterval(schedule, 5000);
			timer.unref();
		},
		begin: async () => {
			if (inFlight) await inFlight;
			if (failure) throw failure;
			cpuSamples.length = 0;
			measuring = true;
		},
		end: async () => {
			if (inFlight) await inFlight;
			if (failure) throw failure;
			await sample();
			measuring = false;
			if (!cpuSamples.length) throw new Error("No Docker CPU samples were collected.");
			return {
				averageCpuPercent: cpuSamples.reduce((sum, value) => sum + value, 0) / cpuSamples.length,
				cpuSampleCount: cpuSamples.length,
			};
		},
		finish: async () => {
			clearInterval(timer);
			if (inFlight) await inFlight;
			if (failure) throw failure;
			await sample();
			return { peakMemoryBytes };
		},
		stop: () => clearInterval(timer),
	};
}

async function certificateFingerprint(port) {
	return new Promise((resolve, reject) => {
		const socket = tls.connect({ host: "127.0.0.1", port, rejectUnauthorized: false }, () => {
			const fingerprint = socket.getPeerCertificate().fingerprint256;
			socket.end();
			if (fingerprint) resolve(fingerprint);
			else reject(new Error("The Docker relay did not provide a certificate fingerprint."));
		});
		socket.once("error", reject);
	});
}

async function startDocker(options, admin, joinCode) {
	const name = `devchat-load-${randomUUID().replace(/-/g, "")}`;
	let started = false;
	let sampler;
	async function stop() {
		sampler?.stop();
		if (!started) return;
		const existing = await docker(["ps", "-a", "--filter", `name=^/${name}$`, "--format", "{{.Names}}"]);
		if (existing) await docker(["stop", "--time", "5", name]);
		started = false;
	}
	try {
		await docker([
			"run", "--detach", "--rm", "--name", name,
			"--publish", "127.0.0.1::8787",
			"--health-interval", "2s", "--health-timeout", "3s", "--health-start-period", "5s", "--health-retries", "3",
			"-e", `RELAY_ADMIN_PUBLIC_KEY=${admin.publicKey}`,
			"-e", `RELAY_JOIN_CODE=${joinCode}`,
			"-e", "HEALTH_LOG_INTERVAL_MS=60000",
			options.image,
		]);
		started = true;
		const deadline = Date.now() + 30_000;
		let status = "";
		while (Date.now() < deadline) {
			status = await docker(["inspect", "--format", "{{.State.Health.Status}}", name]);
			if (status === "healthy") break;
			if (status === "unhealthy") throw new Error("The Docker relay became unhealthy.");
			await delay(500);
		}
		if (status !== "healthy") throw new Error("The Docker relay did not become healthy.");
		const published = await docker(["port", name, "8787/tcp"]);
		const match = published.match(/^127\.0\.0\.1:(\d+)$/);
		if (!match) throw new Error(`Unexpected Docker port mapping: ${published}`);
		const port = Number(match[1]);
		const fingerprint = await certificateFingerprint(port);
		sampler = dockerSampler(name);
		return {
			url: formatPinnedRelayUrl("127.0.0.1", port, fingerprint),
			runtime: "Docker standalone relay",
			baseline: () => sampler.start(),
			begin: () => sampler.begin(),
			end: () => sampler.end(),
			finish: () => sampler.finish(),
			stop,
		};
	} catch (error) {
		await stop();
		throw error;
	}
}

function health(url) {
	const target = new URL(url);
	return new Promise((resolve, reject) => {
		const request = https.get({
			hostname: target.hostname,
			port: Number(target.port),
			path: "/health",
			rejectUnauthorized: false,
			timeout: 5000,
		}, (response) => {
			let body = "";
			response.on("data", (chunk) => { body += chunk; });
			response.on("end", () => {
				try {
					const parsed = JSON.parse(body);
					if (response.statusCode !== 200 || parsed.readiness !== "ready") {
						throw new Error(`Relay health reported HTTP ${response.statusCode}.`);
					}
					resolve(parsed);
				} catch (error) {
					reject(error);
				}
			});
		});
		request.on("timeout", () => request.destroy(new Error("Relay health check timed out.")));
		request.on("error", reject);
	});
}

function waitForState(client, expected, timeout = 30_000) {
	if (client.state === expected) return Promise.resolve();
	return withTimeout(new Promise((resolve, reject) => {
		const stop = client.onStatusChange((state) => {
			if (state !== expected && state !== "error") return;
			stop();
			if (state === expected) resolve();
			else reject(new Error(`Relay client failed: ${client.lastError?.message}`));
		});
	}), timeout, `Timed out waiting for client state ${expected}.`);
}

function waitForRawMessage(socket, predicate) {
	return withTimeout(new Promise((resolve) => {
		const onMessage = (data) => {
			const message = JSON.parse(data.toString());
			if (!predicate(message)) return;
			socket.off("message", onMessage);
			resolve(message);
		};
		socket.on("message", onMessage);
	}), 10_000, "Timed out waiting for a raw relay response.");
}

async function checkMalformedInputs(url) {
	const socket = new WebSocket(url.split("#")[0], { rejectUnauthorized: false });
	try {
		await withTimeout(new Promise((resolve, reject) => {
			socket.once("open", resolve);
			socket.once("error", reject);
		}), 10_000, "Could not open the malformed-input connection.");
		for (const [payload, code] of [
			["not valid JSON", "INVALID_JSON"],
			[JSON.stringify({ type: "invalid", requestId: randomUUID() }), "INVALID_SHAPE"],
			["x".repeat(8193), "PAYLOAD_TOO_LARGE"],
		]) {
			const response = waitForRawMessage(socket, (message) => message.type === "error");
			socket.send(payload);
			assert.equal((await response).code, code);
		}
		const closed = withTimeout(new Promise((resolve) => socket.once("close", resolve)), 10_000, "Oversized frame was not closed.");
		socket.send("x".repeat(16385));
		assert.equal(await closed, 1009);
	} finally {
		socket.terminate();
	}
}

async function run(options) {
	const admin = createIdentity(authentication);
	const joinCode = authentication.generateJoinCode();
	const relay = options.mode === "docker"
		? await startDocker(options, admin, joinCode)
		: await startHosted(options, admin, joinCode);
	const clients = [];
	const identities = [];
	const pending = new Map();
	const failures = [];
	const payload = "x".repeat(options.payloadBytes);
	const counts = {
		sustained: { sent: 0, acknowledged: 0, received: 0, latenciesMs: [] },
		burst: { sent: 0, acknowledged: 0, received: 0, throttled: 0 },
		recovery: { sent: 0, acknowledged: 0, received: 0 },
	};
	let phase = "setup";
	let healthTimer;
	let healthCheck;
	const fail = (message) => { if (failures.length < 10) failures.push(message); };
	const assertHealthy = () => {
		if (failures.length) throw new Error(`Load scenario failed: ${failures.join("; ")}`);
	};

	function observe(index, message) {
		if (message.type !== "direct_message" &&
			!(message.type === "ack" && message.status === "delivered") &&
			message.type !== "error") return;
		const requestId = message.type === "direct_message" ? message.requestId : message.correlationId;
		const item = pending.get(requestId);
		if (!item) {
			fail(`Unexpected ${message.type} response.`);
			return;
		}
		const stats = counts[item.phase];
		if (message.type === "direct_message") {
			if (index !== item.recipient || item.received || item.throttled || message.payload !== payload) {
				fail("A message was duplicated, misrouted, or altered.");
				return;
			}
			item.received = true;
			stats.received += 1;
		} else if (message.type === "ack") {
			if (index !== item.sender || item.acknowledged || item.throttled) {
				fail("A delivery acknowledgement was duplicated or unexpected.");
				return;
			}
			item.acknowledged = true;
			stats.acknowledged += 1;
			if (item.phase === "sustained") stats.latenciesMs.push(performance.now() - item.sentAt);
		} else if (item.throttled && message.code === "RATE_LIMITED" && index === item.sender) {
			stats.throttled += 1;
			pending.delete(requestId);
			return;
		} else {
			fail(`Unexpected relay error: ${message.code}`);
			pending.delete(requestId);
			return;
		}
		if (item.acknowledged && item.received) pending.delete(requestId);
	}

	function send(sender, testPhase, throttled = false) {
		const recipient = (sender + 1) % clients.length;
		const requestId = randomUUID();
		pending.set(requestId, {
			sender, recipient, phase: testPhase, throttled, acknowledged: false, received: false, sentAt: performance.now(),
		});
		if (!clients[sender].sendDirectMessage(identities[recipient].publicKey, payload, requestId)) {
			pending.delete(requestId);
			throw new Error("An authenticated client could not send a test message.");
		}
		counts[testPhase].sent += 1;
	}

	async function drain() {
		const deadline = Date.now() + 30_000;
		while (pending.size && Date.now() < deadline) {
			assertHealthy();
			await delay(20);
		}
		assertHealthy();
		if (pending.size) throw new Error(`${pending.size} messages did not reach a terminal result.`);
	}

	try {
		await relay.baseline();
		for (let index = 0; index < options.clients; index++) {
			const identity = createIdentity(authentication);
			const client = new RelayClient(relay.url);
			client.setJoinCode(relay.url, joinCode);
			client.onMessage((message) => observe(index, message));
			client.onStatusChange((state) => {
				if ((phase === "sustained" || phase === "burst") && (state === "error" || state === "disconnected")) {
					fail(`A client disconnected during ${phase}.`);
				}
			});
			identities.push(identity);
			clients.push(client);
		}
		const connected = clients.map((client) => waitForState(client, "connected", 60_000));
		clients.forEach((client, index) => client.connect(identities[index]));
		await Promise.all(connected);
		let metrics = await health(relay.url);
		assert.equal(metrics.activeConnections, options.clients);
		assert.equal(metrics.presenceEntries, options.clients);
		await delay(1200);

		await relay.begin();
		phase = "sustained";
		const interval = 1000 / options.rate;
		const ticks = options.durationSeconds * options.rate;
		const start = performance.now();
		let maxScheduleLagMs = 0;
		healthTimer = setInterval(() => {
			if (healthCheck) return;
			healthCheck = health(relay.url).catch((error) => fail(`Health check failed: ${error.message}`))
				.finally(() => { healthCheck = undefined; });
		}, 5000);
		healthTimer.unref();
		for (let tick = 1; tick <= ticks; tick++) {
			const scheduled = start + tick * interval;
			const remaining = scheduled - performance.now();
			if (remaining > 0) await delay(remaining);
			const lag = Math.max(0, performance.now() - scheduled);
			maxScheduleLagMs = Math.max(maxScheduleLagMs, lag);
			if (lag > 1000) throw new Error("The load generator fell more than one second behind schedule.");
			assertHealthy();
			if (pending.size > options.clients * options.rate * 30) throw new Error("Too many test messages remain pending.");
			for (let index = 0; index < clients.length; index++) send(index, "sustained");
		}
		await drain();
		const elapsedSeconds = (performance.now() - start) / 1000;
		clearInterval(healthTimer);
		if (healthCheck) await healthCheck;
		assertHealthy();
		const resources = await relay.end();
		const expectedSustained = options.clients * options.rate * options.durationSeconds;
		assert.equal(counts.sustained.sent, expectedSustained);
		assert.equal(counts.sustained.acknowledged, expectedSustained);
		assert.equal(counts.sustained.received, expectedSustained);
		assert.ok(elapsedSeconds >= options.durationSeconds);

		phase = "idle";
		await delay(1200);
		phase = "burst";
		for (let index = 0; index < clients.length; index++) {
			for (let message = 0; message < RATE_LIMIT + BURST_EXTRA; message++) {
				send(index, "burst", message >= RATE_LIMIT);
			}
		}
		await drain();
		assert.equal(counts.burst.acknowledged, options.clients * RATE_LIMIT);
		assert.equal(counts.burst.received, options.clients * RATE_LIMIT);
		assert.equal(counts.burst.throttled, options.clients * BURST_EXTRA);

		phase = "reconnect";
		const reconnectStart = performance.now();
		clients.forEach((client) => client.close());
		const reconnected = clients.map((client) => waitForState(client, "connected", options.reconnectSeconds * 1000));
		clients.forEach((client, index) => client.connect(identities[index]));
		await Promise.all(reconnected);
		const reconnectSeconds = (performance.now() - reconnectStart) / 1000;
		assert.ok(reconnectSeconds < options.reconnectSeconds);

		phase = "abuse";
		await checkMalformedInputs(relay.url);
		send(0, "recovery");
		await drain();
		assert.equal(counts.recovery.acknowledged, 1);
		assert.equal(counts.recovery.received, 1);
		const healthDeadline = Date.now() + 5000;
		do {
			metrics = await health(relay.url);
			if (metrics.activeConnections === options.clients && metrics.presenceEntries === options.clients) break;
			await delay(20);
		} while (Date.now() < healthDeadline);
		assert.equal(metrics.activeConnections, options.clients);
		assert.equal(metrics.presenceEntries, options.clients);
		assert.equal(metrics.messagesForwarded, expectedSustained + options.clients * RATE_LIMIT + 1);
		assert.equal(metrics.throttledMessages, options.clients * BURST_EXTRA);
		assert.equal(metrics.payloadRejections, 4);
		assert.equal(metrics.forwardingFailures, 0);

		const { type: _responseType, ...finalMemory } = await relay.finish();
		Object.assign(resources, finalMemory);
		const latencies = counts.sustained.latenciesMs.sort((a, b) => a - b);
		const passed = meetsResourceLimits(options, resources);
		return {
			passed,
			runtime: relay.runtime,
			targets: {
				clients: options.clients,
				messagesPerSecondPerClient: options.rate,
				durationSeconds: options.durationSeconds,
				payloadBytes: options.payloadBytes,
				burstLimitPerClient: RATE_LIMIT,
				excessBurstMessagesPerClient: BURST_EXTRA,
				reconnectSeconds: options.reconnectSeconds,
				averageCpuPercentBelow: options.cpuLimit,
				memoryMiBBelow: options.memoryLimitMiB,
				memoryMeasure: options.mode === "docker" ? "container peak" : "host process peak increase from idle",
			},
			observed: {
				sustained: {
					sent: counts.sustained.sent,
					acknowledged: counts.sustained.acknowledged,
					received: counts.sustained.received,
					elapsedSeconds,
					maxScheduleLagMs,
					acknowledgementP95Ms: latencies[Math.floor((latencies.length - 1) * 0.95)],
				},
				burst: counts.burst,
				reconnectSeconds,
				malformedAndOversizedRejections: metrics.payloadRejections,
				resources,
			},
			limitations: [
				"Payloads and identities are synthetic; the load generator is separate from the relay process.",
				`Peak memory is sampled throughout the run, approximately every ${options.mode === "docker" ? "5 seconds" : "500 milliseconds"}; brief spikes may be missed.`,
				...(options.mode === "hosted" ? ["This run does not measure a real VS Code extension host."] : []),
				...(options.mode === "vscode" ? ["The extension host uses an isolated profile, not a representative user workspace."] : []),
				...(options.mode === "docker" ? ["Docker CPU is the mean of periodic samples, not a continuous CPU trace."] : []),
			],
		};
	} finally {
		clearInterval(healthTimer);
		phase = "cleanup";
		for (const client of clients) client.close();
		await relay.stop();
	}
}

if (require.main === module) {
	let options;
	try {
		options = parseOptions(process.argv.slice(2));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
	if (options) {
		run(options).then((result) => {
			console.log(JSON.stringify(result, null, 2));
			if (!result.passed) process.exitCode = 1;
		}).catch((error) => {
			console.error(error instanceof Error ? error.stack : String(error));
			process.exitCode = 1;
		});
	}
}

module.exports = { parseOptions, dockerMemoryBytes, dockerCpuPercent, meetsResourceLimits };
