import WebSocket from "ws";

// Force polyfill global WebSocket using the `ws` package for runtime consistency.
if (typeof globalThis !== "undefined") {
	(globalThis as any).WebSocket = WebSocket;
}
