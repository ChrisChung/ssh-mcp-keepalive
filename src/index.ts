#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { Client, ClientChannel } from 'ssh2';
import { z } from 'zod';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const LOG_DIR = 'D:/logs';
const LOG_FILE = join(LOG_DIR, 'ssh-mcp.log');
const ENABLE_LOG = false;  // Set to true to enable file logging

function writeLog(level: string, message: string): void {
  if (!ENABLE_LOG) return;
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [${level}] ${message}\n`;
  try { mkdirSync(LOG_DIR, { recursive: true }); } catch { /* ignore */ }
  try { appendFileSync(LOG_FILE, line); } catch { /* ignore write failures */ }
}

const log = {
  info: (msg: string) => writeLog('INFO', msg),
  warn: (msg: string) => writeLog('WARN', msg),
  error: (msg: string) => writeLog('ERROR', msg),
};

log.info('========== SSH MCP Server session started ==========');

// Example usage: node build/index.js --host=1.2.3.4 --port=22 --user=root --password=pass --key=path/to/key --timeout=5000 --disableSudo
function parseArgv() {
  const args = process.argv.slice(2);
  const config: Record<string, string | null> = {};
  for (const arg of args) {
    if (arg.startsWith('--')) {
      const equalIndex = arg.indexOf('=');
      if (equalIndex === -1) {
        // Flag without value
        config[arg.slice(2)] = null;
      } else {
        // Key=value pair
        config[arg.slice(2, equalIndex)] = arg.slice(equalIndex + 1);
      }
    }
  }
  return config;
}
const isTestMode = process.env.SSH_MCP_TEST === '1';
const isCliEnabled = process.env.SSH_MCP_DISABLE_MAIN !== '1';
const argvConfig = (isCliEnabled || isTestMode) ? parseArgv() : {} as Record<string, string>;

const HOST = argvConfig.host;
const PORT = argvConfig.port ? parseInt(argvConfig.port) : 22;
const USER = argvConfig.user;
const PASSWORD = argvConfig.password;
const SUPASSWORD = argvConfig.suPassword;
const SUDOPASSWORD = argvConfig.sudoPassword;
const DISABLE_SUDO = argvConfig.disableSudo !== undefined;
const KEY = argvConfig.key;
const DEFAULT_TIMEOUT = argvConfig.timeout ? parseInt(argvConfig.timeout) : 60000; // 60 seconds default timeout
// Max characters configuration:
// - Default: 1000 characters
// - When set via --maxChars:
//   * a positive integer enforces that limit
//   * 0 or a negative value disables the limit (no max)
//   * the string "none" (case-insensitive) disables the limit (no max)
const MAX_CHARS_RAW = argvConfig.maxChars;
const MAX_CHARS = (() => {
  if (typeof MAX_CHARS_RAW === 'string') {
    const lowered = MAX_CHARS_RAW.toLowerCase();
    if (lowered === 'none') return Infinity;
    const parsed = parseInt(MAX_CHARS_RAW);
    if (isNaN(parsed)) return 1000;
    if (parsed <= 0) return Infinity;
    return parsed;
  }
  return 1000;
})();

function validateConfig(config: Record<string, string | null>) {
  const errors = [];
  if (!config.host) errors.push('Missing required --host');
  if (!config.user) errors.push('Missing required --user');
  if (config.port && isNaN(Number(config.port))) errors.push('Invalid --port');
  if (errors.length > 0) {
    throw new Error('Configuration error:\n' + errors.join('\n'));
  }
}

if (isCliEnabled) {
  validateConfig(argvConfig);
}

// Command sanitization and validation
export function sanitizeCommand(command: string): string {
  if (typeof command !== 'string') {
    throw new McpError(ErrorCode.InvalidParams, 'Command must be a string');
  }

  const trimmedCommand = command.trim();
  if (!trimmedCommand) {
    throw new McpError(ErrorCode.InvalidParams, 'Command cannot be empty');
  }

  // Length check
  if (Number.isFinite(MAX_CHARS) && trimmedCommand.length > (MAX_CHARS as number)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Command is too long (max ${MAX_CHARS} characters)`
    );
  }

  return trimmedCommand;
}

function sanitizePassword(password: string | undefined): string | undefined {
  if (typeof password !== 'string') return undefined;
  // minimal check, do not log or modify content
  if (password.length === 0) return undefined;
  return password;
}

// Escape command for use in shell contexts (like pkill)
export function escapeCommandForShell(command: string): string {
  // Replace single quotes with escaped single quotes
  return command.replace(/'/g, "'\"'\"'");
}

// SSH Connection Manager to maintain persistent connection
export interface SSHConfig {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  suPassword?: string;
  sudoPassword?: string;  // Password for sudo commands specifically (if different from suPassword)
}

export class SSHConnectionManager {
  private conn: Client | null = null;
  private sshConfig: SSHConfig;
  private isConnecting = false;
  private connectionPromise: Promise<void> | null = null;
  private suShell: any = null;  // Store the elevated shell session
  private suPromise: Promise<void> | null = null;
  private isElevated = false;  // Track if we're in su mode
  private connected = false;  // Track connection state via events
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(config: SSHConfig) {
    this.sshConfig = config;
  }

  async connect(): Promise<void> {
    if (this.conn && this.isConnected()) {
      return; // Already connected
    }

    if (this.isConnecting && this.connectionPromise) {
      return this.connectionPromise; // Wait for ongoing connection
    }

    // Clear any pending reconnect timer
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const connectStart = Date.now();
    log.info(`Connecting to ${this.sshConfig.host}:${this.sshConfig.port}...`);

    this.isConnecting = true;
    this.connectionPromise = new Promise((resolve, reject) => {
      this.conn = new Client();

      const timeoutId = setTimeout(() => {
        this.conn?.end();
        this.conn = null;
        this.isConnecting = false;
        this.connectionPromise = null;
        this.connected = false;
        log.error('SSH connection timeout after 30s');
        reject(new McpError(ErrorCode.InternalError, 'SSH connection timeout'));
      }, 30000); // 30 seconds connection timeout

      this.conn.on('ready', async () => {
        clearTimeout(timeoutId);
        this.isConnecting = false;
        this.connected = true;
        this.reconnectAttempts = 0;
        const elapsed = Date.now() - connectStart;
        log.info(`Connected to ${this.sshConfig.host}:${this.sshConfig.port} (${elapsed}ms)`);

        // In test mode, don't wait for su elevation during connection setup, as it
        // may cause JSON-RPC server initialization to hang. Instead, elevation will
        // be triggered on-demand when a command is executed.
        // In production, elevation during connection is desirable for robustness.
        if (this.sshConfig.suPassword && !process.env.SSH_MCP_TEST) {
          try {
            await this.ensureElevated();
          } catch (err) {
            log.warn(`su elevation during connect failed: ${err instanceof Error ? err.message : err}`);
          }
        }

        resolve();
      });

      this.conn.on('error', (err: Error) => {
        clearTimeout(timeoutId);
        this.conn = null;
        this.isConnecting = false;
        this.connectionPromise = null;
        this.connected = false;
        log.error(`SSH connection error: ${err.message}`);
        reject(new McpError(ErrorCode.InternalError, `SSH connection error: ${err.message}`));
      });

      this.conn.on('end', () => {
        console.error('SSH connection ended');
        log.warn('SSH connection ended (end event)');
        this.connected = false;
        this.handleDisconnect();
      });

      this.conn.on('close', () => {
        console.error('SSH connection closed');
        log.warn('SSH connection closed (close event)');
        this.connected = false;
        this.handleDisconnect();
      });

      this.conn.connect({
        ...this.sshConfig,
        keepaliveInterval: 15000,   // Send keepalive every 15 seconds
        keepaliveCountMax: 3,       // Disconnect after 3 consecutive failed keepalives
      });
    });

    return this.connectionPromise;
  }

  private handleDisconnect(): void {
    this.conn = null;
    this.isConnecting = false;
    this.connectionPromise = null;
    log.warn('SSH connection lost, resetting su state and scheduling reconnect');
    this.resetSuState();
    this.scheduleReconnect();
  }

  private resetSuState(): void {
    if (this.suShell) {
      try { this.suShell.end(); } catch (e) { /* ignore */ }
    }
    this.suShell = null;
    this.isElevated = false;
    this.suPromise = null;
    log.info('su shell state reset (suShell=null, isElevated=false)');
  }

  /**
   * Attempt to recover the su shell after a command timeout.
   * Sends Ctrl+C to abort any running process and waits for the prompt to
   * reappear. If the shell does not recover within the timeout, tears it
   * down completely and re-establishes elevation so the next command can
   * proceed normally.
   */
  async recoverSuShell(): Promise<void> {
    const shell = this.suShell;
    if (!shell) return;

    return new Promise<void>((resolve) => {
      const RECOVERY_TIMEOUT = 5000;
      let recovered = false;

      const cleanup = (timerHandle: NodeJS.Timeout) => {
        clearTimeout(timerHandle);
        try { shell.removeAllListeners('data'); } catch (e) { /* ignore */ }
      };

      const timer = setTimeout(async () => {
        if (!recovered) {
          console.error('su shell recovery timed out — rebuilding elevated session');
          log.warn('su shell recovery timed out — rebuilding elevated session');
          cleanup(timer);
          this.resetSuState();
          try {
            await this.ensureConnected();
            await (this as any).ensureElevated();
          } catch (e) {
            console.error('su shell re-elevation failed after recovery timeout:', e);
            log.error(`su shell re-elevation failed after recovery timeout: ${e instanceof Error ? e.message : e}`);
          }
          resolve();
        }
      }, RECOVERY_TIMEOUT);

      const onData = (data: Buffer) => {
        if (/SSH_MCP_READY>/.test(data.toString())) {
          if (!recovered) {
            recovered = true;
            cleanup(timer);
            console.error('su shell recovered successfully');
            log.info('su shell recovered successfully after Ctrl+C');
            resolve();
          }
        }
      };

      shell.on('data', onData);
      // Send Ctrl+C to interrupt the running process, then a newline so the
      // shell re-displays its prompt.
      try {
        shell.write('\x03');
        setTimeout(() => {
          try { shell.write('\n'); } catch (e) { /* ignore */ }
        }, 100);
      } catch (e) {
        cleanup(timer);
        this.resetSuState();
        resolve();
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error(`SSH reconnect: max attempts (${this.maxReconnectAttempts}) reached, giving up`);
      log.error(`Reconnect abandoned: max attempts (${this.maxReconnectAttempts}) reached`);
      return;
    }
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    console.error(`SSH reconnect: scheduling attempt ${this.reconnectAttempts + 1}/${this.maxReconnectAttempts} in ${delay}ms`);
    log.info(`Scheduling reconnect attempt ${this.reconnectAttempts + 1}/${this.maxReconnectAttempts} in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectAttempts++;
      this.connect()
        .then(() => {
          console.error('SSH reconnect: succeeded');
          log.info('Reconnect succeeded');
        })
        .catch((err) => {
          console.error(`SSH reconnect: attempt ${this.reconnectAttempts} failed:`, err instanceof Error ? err.message : err);
          log.warn(`Reconnect attempt ${this.reconnectAttempts} failed: ${err instanceof Error ? err.message : err}`);
          this.scheduleReconnect();
        });
    }, delay);
  }

  isConnected(): boolean {
    return this.conn !== null && this.connected;
  }

  getSudoPassword(): string | undefined {
    return this.sshConfig.sudoPassword;
  }

  getSuPassword(): string | undefined {
    return this.sshConfig.suPassword;
  }

  async setSuPassword(pwd?: string): Promise<void> {
    this.sshConfig.suPassword = pwd;
    if (pwd) {
      try {
        await this.ensureElevated();
      } catch (err) {
        console.error('setSuPassword: failed to elevate to su shell:', err);
        log.error(`setSuPassword: failed to elevate: ${err instanceof Error ? err.message : err}`);
      }
    } else {
      // If clearing suPassword, drop any existing suShell
      if (this.suShell) {
        try { this.suShell.end(); } catch (e) { /* ignore */ }
        this.suShell = null;
        this.isElevated = false;
      }
    }
  }

  setSudoPassword(pwd?: string): void {
    this.sshConfig.sudoPassword = pwd;
  }

  private async ensureElevated(): Promise<void> {
    if (this.isElevated && this.suShell) return;
    if (!this.sshConfig.suPassword) return;

    if (this.suPromise) return this.suPromise;
    log.info('Starting su elevation...');

    let elevationStream: ClientChannel | null = null;

    this.suPromise = new Promise((resolve, reject) => {
      const conn = this.getConnection();

      // Add a safety timeout so elevation doesn't hang forever
      const timeoutId = setTimeout(() => {
        this.suPromise = null;
        // Close leaked stream to free SSH channel
        if (elevationStream) {
          log.warn('Closing leaked su shell stream on timeout');
          try { elevationStream.end(); } catch (e) { /* ignore */ }
          elevationStream = null;
        }
        log.error('su elevation timed out after 15s');
        reject(new McpError(ErrorCode.InternalError, 'su elevation timed out'));
      }, 15000);  // 15 second timeout for elevation

      conn.shell({ term: 'xterm', cols: 80, rows: 24 }, (err: Error | undefined, stream: ClientChannel) => {
        if (err) {
          clearTimeout(timeoutId);
          this.suPromise = null;
          log.error(`Failed to start interactive shell for su: ${err.message}`);
          // Channel failure means the SSH session is broken — force reconnect
          if (err.message.includes('Channel open failure') || err.message.includes('open failed')) {
            log.warn('Channel failure detected during su elevation, triggering reconnect');
            this.forceReconnect();
          }
          reject(new McpError(ErrorCode.InternalError, `Failed to start interactive shell for su: ${err.message}`));
          return;
        }

        elevationStream = stream;
        log.info('Interactive shell opened for su elevation');

        let buffer = '';
        let passwordSent = false;
        let ps1Set = false;
        const cleanup = () => {
          try { stream.removeAllListeners('data'); } catch (e) { /* ignore */ }
          elevationStream = null;
        };

        const onData = (data: Buffer) => {
          const text = data.toString();
          buffer += text;
          log.info(`su shell data (${text.length}b): ${text.slice(0, 60).replace(/\n/g, '\\n').replace(/\r/g, '\\r')}`);

          // If we haven't sent the password yet, look for the password prompt
          if (!passwordSent && /(password|密码)[:：\s]/i.test(buffer)) {
            passwordSent = true;
            log.info('su password prompt detected, sending password');
            stream.write(this.sshConfig.suPassword + '\n');
            // Don't return; keep looking for root prompt
          }

          // After password is sent, look for any root indicator
          // First detect '#' as an intermediate signal that su succeeded,
          // then set a unique prompt marker for reliable subsequent detection.
          if (passwordSent) {
            if (!ps1Set && /#/.test(buffer)) {
              ps1Set = true;
              log.info('Root prompt detected (#), setting unique PS1 marker');
              // Set a unique prompt that won't appear in normal command output
              stream.write("export PS1='SSH_MCP_READY> '\n");
              buffer = '';
              return;
            }
            if (ps1Set && /SSH_MCP_READY>/.test(buffer)) {
              clearTimeout(timeoutId);
              cleanup();
              this.suShell = stream;
              this.isElevated = true;
              this.suPromise = null;
              log.info('su elevation successful');
              resolve();
              return;
            }
          }

          // Detect authentication failure messages
          if (/authentication failure|incorrect password|su: .*failed|su: failure|认证失败|密码错误/i.test(buffer)) {
            clearTimeout(timeoutId);
            cleanup();
            this.suPromise = null;
            log.error(`su authentication failed: ${buffer.trim()}`);
            reject(new McpError(ErrorCode.InternalError, `su authentication failed: ${buffer}`));
            return;
          }
        };

        stream.on('data', onData);

        stream.on('close', () => {
          clearTimeout(timeoutId);
          elevationStream = null;
          if (!this.isElevated) {
            this.suPromise = null;
            reject(new McpError(ErrorCode.InternalError, 'su shell closed before elevation completed'));
          }
        });

        // Kick off the su command
        stream.write('su -\n');
      });
    });

    return this.suPromise;
  }

  forceReconnect(): void {
    log.warn('Force reconnect triggered — SSH session is broken at channel level');
    if (this.conn) {
      try { this.conn.end(); } catch (e) { /* ignore */ }
    }
    this.connected = false;
    this.handleDisconnect();
  }

  async ensureConnected(): Promise<void> {
    if (!this.isConnected()) {
      await this.connectWithRetry();
    }
  }

  async connectWithRetry(maxRetries = 3, baseDelay = 1000): Promise<void> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this.connect();
      } catch (err) {
        if (attempt === maxRetries) throw err;
        const delay = baseDelay * Math.pow(2, attempt);
        console.error(`SSH connection attempt ${attempt + 1} failed, retrying in ${delay}ms...`);
        log.warn(`Connection attempt ${attempt + 1} failed, retrying in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
    // Unreachable, but TypeScript needs it
    throw new McpError(ErrorCode.InternalError, 'SSH connection failed after retries');
  }

  getConnection(): Client {
    if (!this.conn) {
      throw new McpError(ErrorCode.InternalError, 'SSH connection not established');
    }
    return this.conn;
  }

  close(): void {
    if (this.conn) {
      if (this.suShell) {
        try { this.suShell.end(); } catch (e) { /* ignore */ }
        this.suShell = null;
        this.isElevated = false;
      }
      this.conn.end();
      this.conn = null;
    }
  }
}

let connectionManager: SSHConnectionManager | null = null;

const server = new McpServer({
  name: 'SSH MCP Server',
  version: '1.5.0',
  capabilities: {
    resources: {},
    tools: {},
  },
});

server.tool(
  "exec",
  "Execute a shell command on the remote SSH server and return the output.",
  {
    command: z.string().describe("Shell command to execute on the remote SSH server"),
    description: z.string().optional().describe("Optional description of what this command will do"),
  },
  async ({ command, description }) => {
    // Sanitize command input
    const sanitizedCommand = sanitizeCommand(command);

    try {
      // Initialize connection manager if not already done
      if (!connectionManager) {
        if (!HOST || !USER) {
          throw new McpError(ErrorCode.InvalidParams, 'Missing required host or username');
        }
        const sshConfig: SSHConfig = {
          host: HOST,
          port: PORT,
          username: USER,
        };

        if (PASSWORD) {
          sshConfig.password = PASSWORD;
        } else if (KEY) {
          const fs = await import('fs/promises');
          sshConfig.privateKey = await fs.readFile(KEY, 'utf8');
        }

        if (SUPASSWORD !== null && SUPASSWORD !== undefined) {
          sshConfig.suPassword = sanitizePassword(SUPASSWORD);
        }
        connectionManager = new SSHConnectionManager(sshConfig);
      }

      // Ensure connection is active (reconnect if needed)
      await connectionManager.ensureConnected();

      // If a suPassword was provided, explicitly wait for elevation before executing.
      // This is critical: ensureElevated is idempotent and will return immediately if
      // already elevated, so this ensures we have a su shell before we try to use it.
      if (connectionManager.getSuPassword()) {
        try {
          const elevationPromise = (connectionManager as any).ensureElevated();
          // Add a short timeout for elevation to complete
          await Promise.race([
            elevationPromise,
            new Promise((_, reject) => setTimeout(() => reject(new Error('Elevation timeout')), 5000))
          ]);
        } catch (err) {
          // Log but don't fail; fall back to non-elevated execution if elevation times out
        }
      }

      // Append description as comment if provided
      const commandWithDescription = description
        ? `${sanitizedCommand} # ${description.replace(/#/g, '\\#')}`
        : sanitizedCommand;

      const result = await execSshCommandWithConnection(connectionManager, commandWithDescription);
      return result;
    } catch (err: any) {
      // Wrap unexpected errors
      if (err instanceof McpError) throw err;
      throw new McpError(ErrorCode.InternalError, `Unexpected error: ${err?.message || err}`);
    }
  }
);

// Expose sudo-exec tool unless explicitly disabled
if (!DISABLE_SUDO) {
  server.tool(
    "sudo-exec",
    "Execute a shell command on the remote SSH server using sudo. Will use sudo password if provided, otherwise assumes passwordless sudo.",
    {
      command: z.string().describe("Shell command to execute with sudo on the remote SSH server"),
      description: z.string().optional().describe("Optional description of what this command will do"),
    },
    async ({ command, description }) => {
      const sanitizedCommand = sanitizeCommand(command);

      try {
        if (!connectionManager) {
          if (!HOST || !USER) {
            throw new McpError(ErrorCode.InvalidParams, 'Missing required host or username');
          }

          const sshConfig: SSHConfig = {
            host: HOST,
            port: PORT || 22,
            username: USER,
          };
          if (PASSWORD) {
            sshConfig.password = PASSWORD;
          } else if (KEY) {
            const fs = await import('fs/promises');
            sshConfig.privateKey = await fs.readFile(KEY, 'utf8');
          }
          if (SUPASSWORD !== null && SUPASSWORD !== undefined) {
            sshConfig.suPassword = sanitizePassword(SUPASSWORD);
          }
          if (SUDOPASSWORD !== null && SUDOPASSWORD !== undefined) {
            sshConfig.sudoPassword = sanitizePassword(SUDOPASSWORD);
          }
          connectionManager = new SSHConnectionManager(sshConfig);
        }

        await connectionManager.ensureConnected();

        // If suPassword or sudoPassword were provided on this call but the
        // existing connection manager was created earlier without them,
        // update the manager's values so the subsequent sudo-exec call uses
        // the latest passwords.
        if (SUPASSWORD !== null && SUPASSWORD !== undefined) {
          await connectionManager.setSuPassword(sanitizePassword(SUPASSWORD));
        }
        if (SUDOPASSWORD !== null && SUDOPASSWORD !== undefined) {
          connectionManager.setSudoPassword(sanitizePassword(SUDOPASSWORD));
        }

        let wrapped: string;
        const sudoPassword = connectionManager.getSudoPassword();

        // Append description as comment if provided
        const commandWithDescription = description
          ? `${sanitizedCommand} # ${description.replace(/#/g, '\\#')}`
          : sanitizedCommand;

        if (!sudoPassword) {
          // No password provided, use -n to fail if sudo requires a password
          wrapped = `sudo -n sh -c '${commandWithDescription.replace(/'/g, "'\\''")}'`;
        } else {
          // Password provided — pipe it into sudo using printf. This avoids complex
          // PTY/stdin handling on the SSH channel and is simpler and more reliable.
          const pwdEscaped = sudoPassword.replace(/'/g, "'\\''");
          wrapped = `printf '%s\\n' '${pwdEscaped}' | sudo -p "" -S sh -c '${commandWithDescription.replace(/'/g, "'\\''")}'`;
        }

        return await execSshCommandWithConnection(connectionManager, wrapped);
      } catch (err: any) {
        if (err instanceof McpError) throw err;
        throw new McpError(ErrorCode.InternalError, `Unexpected error: ${err?.message || err}`);
      }
    }
  );
}

// New function that uses persistent connection
export async function execSshCommandWithConnection(manager: SSHConnectionManager, command: string, stdin?: string): Promise<{ [x: string]: unknown; content: ({ [x: string]: unknown; type: "text"; text: string; } | { [x: string]: unknown; type: "image"; data: string; mimeType: string; } | { [x: string]: unknown; type: "audio"; data: string; mimeType: string; } | { [x: string]: unknown; type: "resource"; resource: any; })[] }> {
  return new Promise((resolve, reject) => {
    let timeoutId: NodeJS.Timeout;
    let isResolved = false;

    const conn = manager.getConnection();
    const shell = (manager as any).suShell;  // Use su shell if available

    // Declared here so the timeout handler can reference it even though it is
    // only assigned inside the `if (shell)` branch below.
    let dataHandler: ((data: Buffer) => void) | null = null;

    const cmdStart = Date.now();
    const cmdPreview = command.length > 80 ? command.slice(0, 80) + '...' : command;
    log.info(`Executing command via ${shell ? 'su shell' : 'exec'}: ${cmdPreview}`);

    // Set up timeout
    timeoutId = setTimeout(() => {
      if (!isResolved) {
        isResolved = true;
        log.error(`Command timed out after ${DEFAULT_TIMEOUT}ms: ${cmdPreview}`);

        if (shell) {
          // su shell path: remove the stale listener immediately so it cannot
          // consume output belonging to the next command, then try to recover
          // the shell so subsequent commands can run normally.
          if (dataHandler) shell.removeListener('data', dataHandler);
          manager.recoverSuShell().catch((e) => {
            console.error('recoverSuShell error:', e);
          });
        } else {
          // exec path: attempt to kill the timed-out process on the remote side
          try {
            conn.exec(
              `timeout 3s pkill -f '${escapeCommandForShell(command)}' 2>/dev/null || true`,
              (_err, abortStream) => {
                if (abortStream) {
                  abortStream.on('close', () => { /* nothing to do */ });
                }
              }
            );
          } catch (e) {
            console.error('pkill exec error during timeout handling:', e);
          }
        }

        reject(new McpError(ErrorCode.InternalError, `Command execution timed out after ${DEFAULT_TIMEOUT}ms`));
      }
    }, DEFAULT_TIMEOUT);

    // If we have an active su shell, use it directly (commands run as root in session)
    if (shell) {
      let buffer = '';

      dataHandler = (data: Buffer) => {
        const text = data.toString();
        buffer += text;

        // Wait for the unique prompt marker to know command is complete
        // Using SSH_MCP_READY> instead of # to avoid false matches on
        // comments, hex colors, config files, etc.
        if (/SSH_MCP_READY>/.test(buffer)) {
          if (!isResolved) {
            isResolved = true;
            clearTimeout(timeoutId);
            log.info(`Command completed via su shell (${Date.now() - cmdStart}ms): ${cmdPreview}`);

            // Extract output: remove the command echo and final prompt
            const lines = buffer.split('\n');
            // First line is often the echoed command; last line is the prompt
            let output = lines.slice(1, -1).join('\n');

            resolve({
              content: [{
                type: 'text',
                text: output + (output ? '\n' : ''),
              }],
            });
          }
          shell.removeListener('data', dataHandler);
        }
      };

      shell.on('data', dataHandler);
      // Send command immediately; shell is ready after elevation
      shell.write(command + '\n');
      return;
    }

    // No persistent su shell; use normal exec with optional password piping
    conn.exec(command, (err: Error | undefined, stream: ClientChannel) => {
      if (err) {
        if (!isResolved) {
          isResolved = true;
          clearTimeout(timeoutId);
          log.error(`SSH exec error: ${err.message}`);
          // Channel failure means the SSH session is broken — force reconnect
          if (err.message.includes('Channel open failure') || err.message.includes('open failed')) {
            log.warn('Channel failure detected during exec, triggering reconnect');
            manager.forceReconnect();
          }
          reject(new McpError(ErrorCode.InternalError, `SSH exec error: ${err.message}`));
        }
        return;
      }

      let stdout = '';
      let stderr = '';

      // If stdin provided (e.g., sudo password), write it
      if (stdin && stdin.length > 0) {
        try {
          stream.write(stdin);
        } catch (e) {
          console.error('Error writing to stdin:', e);
        }
      }
      try { stream.end(); } catch (e) { /* ignore */ }

      stream.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      stream.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      stream.on('close', (code: number, signal: string) => {
        if (!isResolved) {
          isResolved = true;
          clearTimeout(timeoutId);
          if (stderr) {
            log.error(`Command failed (code ${code}) (${Date.now() - cmdStart}ms): ${cmdPreview} — ${stderr.slice(0, 100)}`);
            reject(new McpError(ErrorCode.InternalError, `Error (code ${code}):\n${stderr}`));
          } else {
            log.info(`Command completed via exec (code ${code}, ${Date.now() - cmdStart}ms): ${cmdPreview}`);
            resolve({
              content: [{
                type: 'text',
                text: stdout,
              }],
            });
          }
        }
        // Always clean up stream listeners to prevent resource leaks
        try { stream.removeAllListeners(); } catch (e) { /* ignore */ }
      });
    });
  });
}

// Keep the old function for backward compatibility (used in tests)
export async function execSshCommand(sshConfig: any, command: string, stdin?: string): Promise<{ [x: string]: unknown; content: ({ [x: string]: unknown; type: "text"; text: string; } | { [x: string]: unknown; type: "image"; data: string; mimeType: string; } | { [x: string]: unknown; type: "audio"; data: string; mimeType: string; } | { [x: string]: unknown; type: "resource"; resource: any; })[] }> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let timeoutId: NodeJS.Timeout;
    let isResolved = false;

    // Set up timeout
    timeoutId = setTimeout(() => {
      if (!isResolved) {
        isResolved = true;
        // Try to abort the running command before closing connection
        const abortTimeout = setTimeout(() => {
          // If abort command itself times out, force close connection
          conn.end();
        }, 5000); // 5 second timeout for abort command

        conn.exec('timeout 3s pkill -f \'' + escapeCommandForShell(command) + '\' 2>/dev/null || true', (err: Error | undefined, abortStream: ClientChannel | undefined) => {
          if (abortStream) {
            abortStream.on('close', () => {
              clearTimeout(abortTimeout);
              conn.end();
            });
          } else {
            clearTimeout(abortTimeout);
            conn.end();
          }
        });
        reject(new McpError(ErrorCode.InternalError, `Command execution timed out after ${DEFAULT_TIMEOUT}ms`));
      }
    }, DEFAULT_TIMEOUT);

    conn.on('ready', () => {
      conn.exec(command, (err: Error | undefined, stream: ClientChannel) => {
        if (err) {
          if (!isResolved) {
            isResolved = true;
            clearTimeout(timeoutId);
            reject(new McpError(ErrorCode.InternalError, `SSH exec error: ${err.message}`));
          }
          conn.end();
          return;
        }
        // If stdin provided, write it to the stream and end stdin
        if (stdin && stdin.length > 0) {
          try {
            stream.write(stdin);
          } catch (e) {
            // ignore
          }
        }
        try { stream.end(); } catch (e) { /* ignore */ }
        let stdout = '';
        let stderr = '';
        stream.on('close', (code: number, signal: string) => {
          if (!isResolved) {
            isResolved = true;
            clearTimeout(timeoutId);
            conn.end();
            if (stderr) {
              reject(new McpError(ErrorCode.InternalError, `Error (code ${code}):\n${stderr}`));
            } else {
              resolve({
                content: [{
                  type: 'text',
                  text: stdout,
                }],
              });
            }
          }
        });
        stream.on('data', (data: Buffer) => {
          stdout += data.toString();
        });
        stream.stderr.on('data', (data: Buffer) => {
          stderr += data.toString();
        });
      });
    });
    conn.on('error', (err: Error) => {
      if (!isResolved) {
        isResolved = true;
        clearTimeout(timeoutId);
        reject(new McpError(ErrorCode.InternalError, `SSH connection error: ${err.message}`));
      }
    });
    conn.connect(sshConfig);
  });
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("SSH MCP Server running on stdio");
  log.info(`Server started — host=${HOST}, port=${PORT}, user=${USER}, keepalive=15s/3, timeout=${DEFAULT_TIMEOUT}ms`);

  // Handle graceful shutdown
  const cleanup = () => {
    console.error("Shutting down SSH MCP Server...");
    log.info('Server shutting down');
    if (connectionManager) {
      connectionManager.close();
      connectionManager = null;
    }
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('exit', () => {
    if (connectionManager) {
      connectionManager.close();
    }
  });
}

// Initialize server in test mode for automated tests
if (isTestMode) {
  const transport = new StdioServerTransport();
  server.connect(transport).catch(error => {
    console.error("Fatal error connecting server:", error);
    process.exit(1);
  });
}
// Start server in CLI mode
else if (isCliEnabled) {
  main().catch((error) => {
    console.error("Fatal error in main():", error);
    if (connectionManager) {
      connectionManager.close();
    }
    process.exit(1);
  });
}

export { parseArgv, validateConfig };