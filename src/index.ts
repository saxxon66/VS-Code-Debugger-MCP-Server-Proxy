
/**
 * VS Code Debugger MCP Server Proxy
 *
 * This script acts as a stdio-to-WebSocket proxy for AI assistants (like Roo Code)
 * that require stdio communication. It connects to the VS Code Debugger MCP Server
 * extension via WebSocket and relays messages between the AI tool (stdio) and the
 * extension (WebSocket), enabling debugging features for stdio-based AI tools.
 *
 * Features:
 * - Reads WebSocket port from .vscode/settings.json if available.
 * - Logs all proxy activity to a file and stderr.
 * - Handles reconnection logic and graceful shutdown.
 * - Ensures real-time, unbuffered stdio communication.
 */

import WebSocket from 'ws';
import fs from 'fs';
import os from 'os';
import path from 'path';

const LOG_DIR = path.join(os.homedir(), '.vscode-debugger-mcp-server');
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}
const LOG_FILE_PATH = path.join(LOG_DIR, 'proxy.log');

/**
 * Logs a message to both a log file and stderr.
 * If file logging fails, logs the error to stderr.
 * @param message The message to log.
 * @param toFileOnly If true, logs only to file (default: false).
 */
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

/**
 * Determine the WebSocket port:
 * 1. If --port or -p argument is provided, use it.
 * 2. Else, read from .vscode/settings.json if available.
 * 3. Otherwise, use the default port 10101.
 */
const settingsPath = path.join(process.cwd(), '.vscode', 'settings.json');
let port = 10101; // fallback default

// Check for --port or -p argument
const portArgIndex = process.argv.findIndex(arg => arg === '--port' || arg === '-p');
if (portArgIndex !== -1 && process.argv[portArgIndex + 1]) {
  const argPort = parseInt(process.argv[portArgIndex + 1], 10);
  if (!isNaN(argPort)) {
    port = argPort;
  }
} else if (fs.existsSync(settingsPath)) {
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    if (settings.vscodeDebuggerMCP && typeof settings.vscodeDebuggerMCP.websocketPort === 'number') {
      port = settings.vscodeDebuggerMCP.websocketPort;
    }
  } catch (e) {
    logMessage(`[Proxy] Failed to parse .vscode/settings.json: ${e}`);
  }
}
const VSCODE_DEBUGGER_WS_URL = `ws://localhost:${port}`; // Dynamically set from CLI or project settings

// Disable stdout buffering to ensure real-time message delivery to the client.
// This is critical for interactive stdio-based communication.
if (process.stdout.isTTY) {
  process.stdout.setEncoding('utf8');
} else {
  // When not a TTY, it's likely a pipe, which is buffered by default.
  // Disabling buffering is essential for our use case.
  (process.stdout as any)._handle.setBlocking(true);
}
 
 let currentWs: WebSocket | null = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_INTERVAL_MS = 5000; // 5 seconds

// Flag to indicate if stdin listeners are active
let stdinListenersActive = false;

/**
 * Sets up listeners on stdin to forward incoming data to the WebSocket.
 * Ensures only one set of listeners is active at a time.
 * @param ws The active WebSocket connection.
 */
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

/**
 * Removes all stdin listeners to prevent duplicate handlers or memory leaks.
 */
function removeStdinListeners() {
  if (!stdinListenersActive) {
    return; // Listeners not active
  }
  process.stdin.removeAllListeners('data');
  process.stdin.removeAllListeners('end');
  process.stdin.removeAllListeners('error');
  stdinListenersActive = false;
}

/**
 * Schedules a reconnect attempt if the WebSocket connection is lost.
 * Exits the process if the maximum number of attempts is exceeded.
 */
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

/**
 * Establishes a WebSocket connection to the VS Code Debugger MCP Server extension.
 * Handles all WebSocket events, sets up stdin forwarding, and manages graceful shutdown.
 */
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

    // The MCP SDK's StdioServerTransport expects simple newline-delimited JSON messages.
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

  // Handle graceful shutdown on SIGINT/SIGTERM
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

/**
 * Entry point: Start the proxy by connecting to the WebSocket server.
 * Any unhandled errors are logged and cause the process to exit.
 */
try {
  connect();
} catch (error) {
  logMessage(`[Proxy] CRITICAL: Unhandled error in main execution block: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}