#!/usr/bin/env node
// BrowserForce CLI — starts relay server + MCP server in one process.

const { RelayServer } = await import('./relay/src/index.js');
const relay = new RelayServer();
relay.start();

// MCP server is ESM and self-starts on import (stdio mode)
await import('./mcp/src/index.js');
