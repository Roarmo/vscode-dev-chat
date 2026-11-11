const assert = require("node:assert/strict");
const test = require("node:test");
const { parseOptions, dockerMemoryBytes, dockerCpuPercent, meetsResourceLimits } = require("../scripts/relayLoad.cjs");

const MIB = 1024 * 1024;

test("relay load options retain the approved targets and reject invalid inputs", () => {
	const options = parseOptions(["--mode", "hosted"]);
	assert.equal(options.clients, 25);
	assert.equal(options.rate, 5);
	assert.equal(options.durationSeconds, 600);
	assert.equal(options.payloadBytes, 1024);
	assert.equal(options.reconnectSeconds, 30);
	assert.equal(options.cpuLimit, 25);
	assert.equal(options.memoryLimitMiB, 256);
	const docker = parseOptions(["--mode", "docker", "--image", "test-image"]);
	assert.equal(docker.cpuLimit, 80);
	assert.equal(docker.memoryLimitMiB, 512);

	for (const args of [
		["--mode", "invalid"],
		["--mode", "hosted", "--clients", "0"],
		["--mode", "hosted", "--duration-seconds", "NaN"],
		["--mode", "hosted", "--rate", "20"],
		["--mode", "hosted", "--cpu-limit", "-1"],
		["--mode", "hosted", "--memory-limit-mib"],
		["--mode", "hosted", "--unknown", "1"],
	]) {
		assert.throws(() => parseOptions(args));
	}
});

test("relay load parses Docker memory units and rejects invalid samples", () => {
	assert.equal(dockerMemoryBytes("1B / 1GiB"), 1);
	assert.equal(dockerMemoryBytes("1.5MiB / 1GiB"), 1.5 * MIB);
	assert.equal(dockerMemoryBytes("2MB / 1GB"), 2_000_000);
	assert.equal(dockerMemoryBytes("1GiB / 2GiB"), 1024 * MIB);
	for (const value of ["unavailable", ".MiB / 1GiB", "1.2.3MiB / 1GiB"]) {
		assert.throws(() => dockerMemoryBytes(value), /Could not parse/);
	}
});

test("relay load rejects missing or malformed Docker CPU samples", () => {
	assert.equal(dockerCpuPercent(" 12.34% "), 12.34);
	for (const value of ["", "12", "-1%", "1.2.3%"]) {
		assert.throws(() => dockerCpuPercent(value), /Could not parse/);
	}
});

test("relay load requires valid measurements strictly below both resource limits", () => {
	const docker = { mode: "docker", cpuLimit: 80, memoryLimitMiB: 512 };
	assert.equal(meetsResourceLimits(docker, {
		averageCpuPercent: 79.999, peakMemoryBytes: 512 * MIB - 1,
	}), true);
	assert.equal(meetsResourceLimits(docker, {
		averageCpuPercent: 80, peakMemoryBytes: 512 * MIB - 1,
	}), false);
	assert.equal(meetsResourceLimits(docker, {
		averageCpuPercent: 79, peakMemoryBytes: 512 * MIB,
	}), false);

	const hosted = { mode: "hosted", cpuLimit: 25, memoryLimitMiB: 256 };
	assert.equal(meetsResourceLimits(hosted, {
		averageCpuPercent: 24.999, peakAdditionalRssBytes: 256 * MIB - 1,
	}), true);
	assert.equal(meetsResourceLimits(hosted, {
		averageCpuPercent: 25, peakAdditionalRssBytes: 256 * MIB - 1,
	}), false);
	assert.equal(meetsResourceLimits(hosted, {
		averageCpuPercent: 24, peakAdditionalRssBytes: 256 * MIB,
	}), false);
	for (const resources of [
		{ averageCpuPercent: NaN, peakAdditionalRssBytes: 1 },
		{ averageCpuPercent: Infinity, peakAdditionalRssBytes: 1 },
		{ averageCpuPercent: 1, peakAdditionalRssBytes: -1 },
		{ averageCpuPercent: 1 },
	]) {
		assert.throws(() => meetsResourceLimits(hosted, resources), /invalid/);
	}
});
