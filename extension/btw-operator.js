import { createHash, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as net from "node:net";
import {
	writeAccountControlsDescriptor,
	removeAccountControlsDescriptor,
} from "./account-controls-operator.js";

// Reuse the audited private descriptor writer in an isolated BTW directory.
export function btwSocketPath(bridgeSocket) {
	return `${bridgeSocket}.btw`;
}
export function writeBtwDescriptor(baseDir, descriptor) {
	return writeAccountControlsDescriptor(path.join(baseDir, "btw"), descriptor);
}
export function removeBtwDescriptor(baseDir, agentId, runtimeEpoch) {
	return removeAccountControlsDescriptor(
		path.join(baseDir, "btw"),
		agentId,
		runtimeEpoch,
	);
}
export function btwDescriptorPath(baseDir, agentId) {
	return path.join(
		baseDir,
		"btw",
		"operators",
		`${createHash("sha256").update(agentId).digest("hex")}.accounts.json`,
	);
}
export function createBtwEndpoint(pipePath, callbacks, wireType = "btw", suffix = ".btw") {
	const socketPath = `${pipePath}${suffix}`,
		sockets = new Set();
	try {
		fs.unlinkSync(socketPath);
	} catch {}
	const server = net.createServer((socket) => {
		if (sockets.size >= 8) {
			socket.destroy();
			return;
		}
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		socket.on("error", () => {});
		socket.setTimeout(5000, () => socket.destroy());
		let buffer = Buffer.alloc(0),
			received = false;
		socket.on("data", (chunk) => {
			if (received || buffer.length + chunk.length > 64 * 1024) {
				socket.destroy();
				return;
			}
			buffer = Buffer.concat([buffer, chunk]);
			const nl = buffer.indexOf(10);
			if (nl < 0) return;
			received = true;
			void (async () => {
				let id = "invalid";
				try {
					if (nl !== buffer.length - 1) throw new Error("Invalid frame");
					const frame = JSON.parse(
						new TextDecoder("utf-8", { fatal: true }).decode(
							buffer.subarray(0, nl),
						),
					);
					const active = callbacks(),
						identity = active?.btwIdentity?.();
					if (
						!identity ||
						!active?.btw ||
						!validateBtwEnvelope(frame, identity, wireType)
					)
						throw new Error("Invalid identity");
					id = frame.id;
					const data = await active.btw(frame.request);
					const current = callbacks()?.btwIdentity?.();
					if (
						!current ||
						[
							"agentId",
							"sessionId",
							"runtimeEpoch",
							"serviceEpoch",
							"capability",
						].some((k) => current[k] !== identity[k])
					)
						throw new Error("Stale identity");
					const output = JSON.stringify({
						v: 1,
						type: wireType,
						id,
						success: true,
						agentId: identity.agentId,
						sessionId: identity.sessionId,
						runtimeEpoch: identity.runtimeEpoch,
						serviceEpoch: identity.serviceEpoch,
						data,
					});
					if (Buffer.byteLength(output) > 2 * 1024 * 1024 - 1)
						throw new Error("Oversized response");
					socket.end(`${output}\n`);
				} catch {
					socket.end(
						`${JSON.stringify({ v: 1, type: wireType, id, success: false, error: "Control operation failed; refresh before retrying" })}\n`,
					);
				}
			})().catch(() => socket.destroy());
		});
	});
	server.on("error", (error) => callbacks()?.error?.(error));
	server.listen(socketPath, () => {
		try {
			fs.chmodSync(socketPath, 0o600);
		} catch {}
	});
	return {
		close() {
			for (const socket of sockets) socket.destroy();
			sockets.clear();
			server.close();
			try {
				fs.unlinkSync(socketPath);
			} catch {}
		},
	};
}
export function validateBtwEnvelope(value, identity, wireType = "btw") {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).sort().join(",") !==
			"agentId,capability,id,request,runtimeEpoch,serviceEpoch,sessionId,type,v"
	)
		return false;
	if (
		value.v !== 1 ||
		value.type !== wireType ||
		typeof value.id !== "string" ||
		!/^[\w.:-]{1,128}$/.test(value.id) ||
		typeof value.capability !== "string" ||
		!/^[a-f0-9]{64}$/.test(value.capability)
	)
		return false;
	const a = Buffer.from(value.capability, "hex"),
		b = Buffer.from(identity.capability, "hex");
	if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
	return (
		value.agentId === identity.agentId &&
		value.sessionId === identity.sessionId &&
		value.runtimeEpoch === identity.runtimeEpoch &&
		value.serviceEpoch === identity.serviceEpoch &&
		value.request?.sessionId === identity.sessionId &&
		value.request?.serviceEpoch === identity.serviceEpoch &&
		["snapshot", "start", "send", "cancel", "remove", ...(wireType === "workflows" ? ["review"] : [])].includes(
			value.request?.operation,
		)
	);
}
