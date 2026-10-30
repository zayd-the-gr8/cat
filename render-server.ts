import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import { dirname, extname, join, resolve, sep } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { TLSSocket } from "node:tls";
import { server as wisp } from "@mercuryworkshop/wisp-js/server";

const publicDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "packages/demo/dist");
const port = Number(process.env.PORT ?? 10000);
const wispPath = "/wisp/";
const maxWispConnections = 32;
const maxHttpConnections = 96;

if (!Number.isInteger(port) || port < 1 || port > 65535) {
	throw new RangeError(`Invalid PORT: ${process.env.PORT}`);
}

wisp.options.allow_direct_ip = false;
wisp.options.allow_private_ips = false;
wisp.options.allow_loopback_ips = false;
wisp.options.allow_udp_streams = false;
wisp.options.stream_limit_total = 32;
wisp.options.stream_limit_per_host = 8;

const wispSockets = new Set<Duplex>();

function respond(
	response: http.ServerResponse,
	status: number,
	message: string,
	headers: http.OutgoingHttpHeaders = {}
) {
	response.writeHead(status, {
		"Content-Type": "text/plain; charset=utf-8",
		"Content-Length": Buffer.byteLength(message),
		"X-Content-Type-Options": "nosniff",
		...headers,
	});
	response.end(message);
}

function contentType(filePath: string): string {
	switch (extname(filePath).toLowerCase()) {
		case ".css":
			return "text/css; charset=utf-8";
		case ".html":
			return "text/html; charset=utf-8";
		case ".js":
		case ".mjs":
			return "text/javascript; charset=utf-8";
		case ".json":
		case ".map":
			return "application/json; charset=utf-8";
		case ".png":
			return "image/png";
		case ".svg":
			return "image/svg+xml";
		case ".wasm":
			return "application/wasm";
		case ".woff":
			return "font/woff";
		case ".woff2":
			return "font/woff2";
		default:
			return "application/octet-stream";
	}
}

async function serveFile(request: http.IncomingMessage, response: http.ServerResponse) {
	if (request.method !== "GET" && request.method !== "HEAD") {
		respond(response, 405, "Method Not Allowed", { Allow: "GET, HEAD" });
		return;
	}

	let pathname: string;
	try {
		pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
	} catch {
		respond(response, 400, "Bad Request");
		return;
	}

	if (pathname.includes("\0")) {
		respond(response, 400, "Bad Request");
		return;
	}

	const filePath = resolve(publicDirectory, `.${pathname}`);
	if (filePath !== publicDirectory && !filePath.startsWith(`${publicDirectory}${sep}`)) {
		respond(response, 400, "Bad Request");
		return;
	}

	let targetPath = filePath;
	try {
		const fileInfo = await stat(targetPath);
		if (fileInfo.isDirectory()) targetPath = join(targetPath, "index.html");
	} catch (error) {
		if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
			throw error;
		}
		if (extname(targetPath)) {
			respond(response, 404, "Not Found");
			return;
		}
		targetPath = join(publicDirectory, "index.html");
	}

	const fileInfo = await stat(targetPath);
	if (!fileInfo.isFile()) {
		respond(response, 404, "Not Found");
		return;
	}

	response.writeHead(200, {
		"Content-Type": contentType(targetPath),
		"Content-Length": fileInfo.size,
		"Cache-Control": "no-cache",
		"X-Content-Type-Options": "nosniff",
	});
	if (request.method === "HEAD") {
		response.end();
		return;
	}

	const stream = createReadStream(targetPath);
	stream.on("error", (error) => {
		console.error(`Failed to stream ${targetPath}:`, error);
		response.destroy(error);
	});
	stream.pipe(response);
}

function expectedOrigin(request: http.IncomingMessage): string | null {
	const forwardedProto = request.headers["x-forwarded-proto"];
	const protocol =
		typeof forwardedProto === "string"
			? forwardedProto.split(",")[0].trim().toLowerCase()
			: request.socket instanceof TLSSocket
				? "https"
				: "http";

	if (protocol !== "http" && protocol !== "https") return null;
	if (!request.headers.host) return null;

	try {
		return new URL(`${protocol}://${request.headers.host}`).origin;
	} catch {
		return null;
	}
}

function isSameOriginWebSocket(request: http.IncomingMessage): boolean {
	const originHeader = request.headers.origin;
	const expected = expectedOrigin(request);
	if (!originHeader || !expected) return false;

	try {
		const origin = new URL(originHeader);
		return origin.origin === expected && originHeader === origin.origin;
	} catch {
		return false;
	}
}

function rejectUpgrade(socket: Duplex, status: string) {
	socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

const server = http.createServer((request, response) => {
	let pathname: string;
	try {
		pathname = new URL(request.url ?? "/", "http://localhost").pathname;
	} catch {
		respond(response, 400, "Bad Request");
		return;
	}

	if (pathname === "/healthz") {
		respond(response, 200, "ok");
		return;
	}
	if (pathname === wispPath || pathname.startsWith(wispPath)) {
		respond(response, 426, "WebSocket Upgrade Required", {
			Upgrade: "websocket",
		});
		return;
	}

	void serveFile(request, response).catch((error: unknown) => {
		console.error("Failed to serve demo request:", error);
		if (response.headersSent) {
			response.destroy(error instanceof Error ? error : undefined);
		} else {
			respond(response, 500, "Internal Server Error");
		}
	});
});

server.maxConnections = maxHttpConnections;
server.headersTimeout = 10_000;
server.requestTimeout = 30_000;

server.on("upgrade", (request, socket, head) => {
	if (request.url !== wispPath) {
		rejectUpgrade(socket, "404 Not Found");
		return;
	}
	if (!isSameOriginWebSocket(request)) {
		rejectUpgrade(socket, "403 Forbidden");
		return;
	}
	if (wispSockets.size >= maxWispConnections) {
		rejectUpgrade(socket, "429 Too Many Requests");
		return;
	}

	wispSockets.add(socket);
	socket.once("close", () => wispSockets.delete(socket));
	try {
		wisp.routeRequest(request, socket, head);
	} catch (error) {
		console.error("Failed to route Wisp WebSocket:", error);
		socket.destroy();
	}
});

await stat(join(publicDirectory, "index.html"));
server.listen(port, "0.0.0.0", () => {
	console.log(`Scramjet demo and Wisp listening on port ${port}`);
});
