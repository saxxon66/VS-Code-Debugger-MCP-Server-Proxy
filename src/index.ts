import WebSocket from 'ws';
import fs from 'fs';
import path from 'path';
import { JSONRPCMessage, JSONRPCRequest, JSONRPCResponse, ListToolsResult, Tool } from '@modelcontextprotocol/sdk/types.js';
// @ts-ignore
import { serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';

const LOG_FILE_PATH = 'D:/Projekte/MCP/vscode-debugger-mcp-server-proxy/proxy.log';

function logMessage(message: string, toFileOnly: boolean = false): void {
  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] ${message}\n`;
  try {
    fs.appendFileSync(LOG_FILE_PATH, logEntry);
  } catch (err) {
    // Fallback to stderr if file logging fails for the actual message
    const fileLogErrorMsg = `[${timestamp}] FILE_LOG_ERROR: ${err instanceof Error ? err.message : String(err)} for original message: "${message}"\n`;
    process.stderr.write(fileLogErrorMsg);
  }
  if (!toFileOnly) {
    process.stderr.write(logEntry); // Also write to stderr for Roo to potentially pick up
  }
}

logMessage(`[Proxy] Script started. PID: ${process.pid}. Logging to: ${LOG_FILE_PATH}`);

const VSCODE_DEBUGGER_WS_URL = 'ws://localhost:12345'; // Updated to match MCP server's actual port

let currentWs: WebSocket | null = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_INTERVAL_MS = 5000; // 5 seconds

// Flag to indicate if stdin listeners are active
let stdinListenersActive = false;

function setupStdinListeners(ws: WebSocket) {
  if (stdinListenersActive) {
    return; // Listeners already active
  }

  process.stdin.on('data', (data: Buffer) => {
    const message = data.toString().trim();
    if (message) {
      logMessage(`[Proxy] stdin -> ws: ${message.substring(0, 200)}${message.length > 200 ? '...' : ''}`);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(message);
      } else {
        logMessage('[Proxy] WebSocket not open, cannot send message from stdin.');
      }
    }
  });

  process.stdin.on('end', () => {
    logMessage('[Proxy] stdin pipe ended. WebSocket will be closed if open.');
    // if (ws.readyState === WebSocket.OPEN) { ws.close(1000, "stdin ended"); } // Removed to prevent WebSocket from closing
  });

  process.stdin.on('error', (err: Error) => {
    logMessage(`[Proxy] stdin error: ${err.message}. Closing WebSocket if open.`);
    if (ws.readyState === WebSocket.OPEN) {
      ws.close(1011, "stdin error"); // 1011: Internal Error indicates server is terminating due to an unexpected condition
    }
    // The 'close' event on ws should handle the process.exit.
  });
  stdinListenersActive = true;
}

function removeStdinListeners() {
  if (!stdinListenersActive) {
    return; // Listeners not active
  }
  process.stdin.removeAllListeners('data');
  process.stdin.removeAllListeners('end');
  process.stdin.removeAllListeners('error');
  stdinListenersActive = false;
}

function scheduleReconnect() {
  removeStdinListeners(); // Ensure stdin listeners are removed before attempting reconnect

  if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
    reconnectAttempts++;
    logMessage(`[Proxy] Attempting to reconnect in ${RECONNECT_INTERVAL_MS / 1000} seconds (Attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}).`);
    setTimeout(connect, RECONNECT_INTERVAL_MS);
  } else {
    logMessage(`[Proxy] Exceeded maximum reconnect attempts (${MAX_RECONNECT_ATTEMPTS}). Exiting proxy.`);
    process.exit(1);
  }
}

async function connect() {
  logMessage(`[Proxy] connect() called. Attempting to connect to WebSocket server at ${VSCODE_DEBUGGER_WS_URL}`);
  currentWs = new WebSocket(VSCODE_DEBUGGER_WS_URL);

  currentWs.on('open', () => {
    logMessage('[Proxy] WebSocket connection opened.');
    reconnectAttempts = 0; // Reset reconnect attempts on successful connection
    setupStdinListeners(currentWs!); // Pass the current WebSocket instance
  });

  currentWs.on('message', (data: WebSocket.RawData) => {
    const messageString = data.toString();
    logMessage(`[Proxy] ws -> stdout: ${messageString.substring(0, 200)}${messageString.length > 200 ? '...' : ''}`);

    try {
      const parsedMessage: JSONRPCMessage = JSON.parse(messageString);

      // Check if it's a tools/call request for list_tools
      // Type guard to check if it's a JSON-RPC request
      // Type guard to check if it's a JSON-RPC request
      // Type guard to check if it's a JSON-RPC request
      // Type guard to check if it's a JSON-RPC request
      if ('method' in parsedMessage && (parsedMessage as JSONRPCRequest).method === 'tools/call' && (parsedMessage as JSONRPCRequest).params && ((parsedMessage as JSONRPCRequest).params as any).name === 'list_tools') {
        logMessage('[Proxy] Intercepted tools/call for list_tools. Sending dummy response.');

        const dummyTools: Tool[] = [
          {
            name: "dummyTool",
            description: "A test tool from the proxy.",
            inputSchema: { type: "object", properties: {} },
          },
        ];

        const listToolsResponse: JSONRPCResponse = {
          jsonrpc: '2.0',
          id: (parsedMessage as JSONRPCRequest).id, // Ensure the ID matches the request
          result: {
            description: "Tools available from the proxy.",
            tools: dummyTools
          } as ListToolsResult
        };

        const serializedResponse = serializeMessage(listToolsResponse);
        logMessage(`[Proxy] Sending serialized list_tools response: ${serializedResponse.substring(0, 200)}${serializedResponse.length > 200 ? '...' : ''}`);
        process.stdout.write(serializedResponse + '\n');
        return; // Do not fall through to original forwarding logic
      }
    } catch (e) {
      logMessage(`[Proxy] Error parsing WebSocket message as JSON or handling list_tools: ${e instanceof Error ? e.message : String(e)}`, true);
      // If parsing fails, or it's not a list_tools call, fall through to original forwarding
    }

    // The MCP SDK's StdioServerTransport expects simple newline-delimited JSON messages.
    // Remove LSP-like headers and ensure only JSON + newline is sent.
    process.stdout.write(messageString + '\n');
  });

  currentWs.on('close', (code: number, reason: Buffer) => {
    const reasonString = reason ? reason.toString() : 'N/A';
    logMessage(`[Proxy] WebSocket connection closed by remote or self. Code: ${code}, Reason: ${reasonString}.`);
    scheduleReconnect(); // Attempt to reconnect
  });

  currentWs.on('error', (error: Error) => {
    let errorMessage = error.message;
    if (!errorMessage && error.toString) {
      errorMessage = error.toString();
    }
    if (error && (error as any).code) {
      errorMessage += ` (code: ${(error as any).code})`;
    }
    logMessage(`[Proxy] WebSocket error: ${errorMessage || 'Unknown WebSocket error'}.`);
    scheduleReconnect(); // Attempt to reconnect
  });

  const gracefulShutdown = (signal: string) => {
    logMessage(`[Proxy] Received ${signal}. Attempting graceful shutdown.`);
    if (currentWs && (currentWs.readyState === WebSocket.OPEN || currentWs.readyState === WebSocket.CONNECTING)) {
      logMessage(`[Proxy] Closing WebSocket due to ${signal}.`);
      currentWs.close(1000, `Proxy shutting down due to ${signal}`);
    } else {
      logMessage(`[Proxy] WebSocket not open or connecting during ${signal} shutdown. Exiting directly.`);
      process.exit(0);
    }
  };

  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

  process.on('exit', (code) => {
    logMessage(`[Proxy] Exiting with code: ${code}. PID: ${process.pid}.`);
  });
}

try {
  connect();
} catch (error) {
  logMessage(`[Proxy] CRITICAL: Unhandled error in main execution block: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}