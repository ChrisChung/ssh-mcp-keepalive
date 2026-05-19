# SSH MCP Keepalive Server

> **Notice:** This project is forked from [tufantunc/ssh-mcp](https://github.com/tufantunc/ssh-mcp): *MCP server exposing SSH control for Linux servers via Model Context Protocol*. Building upon the original repository, this project introduces SSH connection keepalive capabilities and fixes bugs related to long-term connection interruptions.

[![NPM Version](https://img.shields.io/npm/v/ssh-mcp-keepalive)](https://www.npmjs.com/package/ssh-mcp-keepalive)
[![Downloads](https://img.shields.io/npm/dm/ssh-mcp-keepalive)](https://www.npmjs.com/package/ssh-mcp-keepalive)
[![Node Version](https://img.shields.io/node/v/ssh-mcp-keepalive)](https://nodejs.org/)
[![License](https://img.shields.io/github/license/tufantunc/ssh-mcp-keepalive)](./LICENSE)
[![GitHub Stars](https://img.shields.io/github/stars/tufantunc/ssh-mcp-keepalive?style=social)](https://github.com/ChrisChung/ssh-mcp-keepalive/stargazers)
[![GitHub Forks](https://img.shields.io/github/forks/tufantunc/ssh-mcp-keepalive?style=social)](https://github.com/ChrisChung/ssh-mcp-keepalive/forks)
[![Build Status](https://github.com/ChrisChung/ssh-mcp-keepalive/actions/workflows/publish.yml/badge.svg)](https://github.com/ChrisChung/ssh-mcp-keepalive/actions)
[![GitHub issues](https://img.shields.io/github/issues/tufantunc/ssh-mcp-keepalive)](https://github.com/ChrisChung/ssh-mcp-keepalive/issues)

[![Trust Score](https://archestra.ai/mcp-catalog/api/badge/quality/tufantunc/ssh-mcp-keepalive)](https://archestra.ai/mcp-catalog/tufantunc__ssh-mcp-keepalive)

**SSH MCP Keepalive Server** is a local Model Context Protocol (MCP) server that exposes SSH control for Linux and Windows systems, enabling LLMs and other MCP clients to execute shell commands securely via SSH.

## Contents

- [Quick Start](#quick-start)
- [Features](#features)
- [Installation](#installation)
- [Client Setup](#client-setup)
- [Testing](#testing)
- [Disclaimer](#disclaimer)
- [Support](#support)

---

## Quick Start

- [Install](#installation) SSH MCP Keepalive Server
- [Configure](#client-setup) SSH MCP Keepalive Server
- [Set up](#client-setup) your MCP Client (e.g. Claude Desktop, Cursor, etc.)
- Execute remote shell commands on your Linux or Windows server via natural language

---

## Features

- MCP-compliant server exposing SSH capabilities
- Execute shell commands on remote Linux and Windows systems
- Secure authentication via password or SSH key
- Built with TypeScript and the official MCP SDK
- **Configurable timeout protection** with automatic process abortion
- **Graceful timeout handling** - attempts to kill hanging processes before closing connections
- **Persistent SSH connection** with automatic keepalive (15s interval) to prevent idle disconnects
- **Automatic reconnection** with exponential backoff when connection drops
- **Robust su shell management** - properly resets elevated shell state on disconnect, uses unique prompt markers to avoid false output detection

### Tools

- `exec`: Execute a shell command on the remote server
  - **Parameters:**
    - `command` (required): Shell command to execute on the remote SSH server
    - `description` (optional): Optional description of what this command will do (appended as a comment)
  - **Timeout Configuration:**
    - Timeout is configured via command line argument `--timeout` (in milliseconds)
    - Default timeout: 60000ms (1 minute)
    - When a command times out, the server automatically attempts to abort the running process before closing the connection

- `sudo-exec`: Execute a shell command with sudo elevation
  - **Parameters:**
    - `command` (required): Shell command to execute as root using sudo
    - `description` (optional): Optional description of what this command will do (appended as a comment)
  - **Notes:**
    - Requires `--sudoPassword` to be set for password-protected sudo
    - Can be disabled by passing the `--disableSudo` flag at startup if sudo access is not needed or not available
    - For persistent root access, consider using `--suPassword` instead which establishes a root shell
    - Tool will not be available at all if server is started with `--disableSudo`
  - **Timeout Configuration:**
    - Timeout is configured via command line argument `--timeout` (in milliseconds)
    - Default timeout: 60000ms (1 minute)
    - When a command times out, the server automatically attempts to abort the running process before closing the connection
  - **Max Command Length Configuration:**
    - Max command characters are configured via `--maxChars`
    - Default: `1000`
    - No-limit mode: set `--maxChars=none` or any `<= 0` value (e.g. `--maxChars=0`)

### Connection Reliability

The server implements several mechanisms to maintain a stable SSH connection:

- **SSH Keepalive**: Sends keepalive packets every 15 seconds to prevent NAT gateways and firewalls from dropping idle connections. Disconnects after 3 consecutive failed keepalives.
- **Automatic Reconnection**: When the connection drops, the server automatically attempts to reconnect with exponential backoff (1s, 2s, 4s, 8s, 16s... up to 30s max), with up to 5 retry attempts.
- **Connection Retry**: Initial connection failures are retried up to 3 times with exponential backoff, protecting against transient network issues.
- **su Shell Recovery**: When the SSH connection drops, the elevated (su) shell state is properly reset. On reconnection, the su shell is automatically re-established if `--suPassword` is configured.
- **Reliable Prompt Detection**: Uses a unique prompt marker (`SSH_MCP_READY>`) instead of matching generic `#` characters, preventing false command completion detection from comments, hex colors, or other output containing `#`.

---

## Installation

1. **Clone the repository:**
   ```bash
   git clone [https://github.com/yourusername/ssh-mcp-keepalive.git](https://github.com/yourusername/ssh-mcp-keepalive.git)
   cd ssh-mcp-keepalive

```

2. **Install dependencies:**
```bash
npm install

```



---

## Client Setup

You can configure your IDE or LLM like Cursor, Windsurf, or Claude Desktop to use this MCP Server.

**Required Parameters:**

* `host`: Hostname or IP of the Linux or Windows server
* `user`: SSH username

**Optional Parameters:**

* `port`: SSH port (default: 22)
* `password`: SSH password (or use `key` for key-based auth)
* `key`: Path to private SSH key
* `sudoPassword`: Password for sudo elevation (when executing commands with sudo)
* `suPassword`: Password for su elevation (when you need a persistent root shell)
* `timeout`: Command execution timeout in milliseconds (default: 60000ms = 1 minute)
* `maxChars`: Maximum allowed characters for the `command` input (default: 1000). Use `none` or `0` to disable the limit.
* `disableSudo`: Flag to disable the `sudo-exec` tool completely. Useful when sudo access is not needed or not available.

```json
{
    "mcpServers": {
        "ssh-mcp-keepalive": {
            "command": "npx",
            "args": [
                "ssh-mcp-keepalive",
                "-y",
                "--",
                "--host=1.2.3.4",
                "--port=22",
                "--user=root",
                "--password=pass",
                "--key=path/to/key",
                "--timeout=30000",
                "--maxChars=none"
            ]
        }
    }
}

```

### Claude Code

You can add this MCP server to Claude Code using the `claude mcp add` command. This is the recommended method for Claude Code.

**Basic Installation:**

```bash
claude mcp add --transport stdio ssh-mcp-keepalive -- npx -y ssh-mcp-keepalive -- --host=YOUR_HOST --user=YOUR_USER --password=YOUR_PASSWORD

```

**Installation Examples:**

**With Password Authentication:**

```bash
claude mcp add --transport stdio ssh-mcp-keepalive -- npx -y ssh-mcp-keepalive -- --host=192.168.1.100 --port=22 --user=admin --password=your_password

```

**With SSH Key Authentication:**

```bash
claude mcp add --transport stdio ssh-mcp-keepalive -- npx -y ssh-mcp-keepalive -- --host=example.com --user=root --key=/path/to/private/key

```

**With Custom Timeout and No Character Limit:**

```bash
claude mcp add --transport stdio ssh-mcp-keepalive -- npx -y ssh-mcp-keepalive -- --host=192.168.1.100 --user=admin --password=your_password --timeout=120000 --maxChars=none

```

**With Sudo and Su Support:**

```bash
claude mcp add --transport stdio ssh-mcp-keepalive -- npx -y ssh-mcp-keepalive -- --host=192.168.1.100 --user=admin --password=your_password --sudoPassword=sudo_pass --suPassword=root_pass

```

**Installation Scopes:**

You can specify the scope when adding the server:

* **Local scope** (default): For personal use in the current project
```bash
claude mcp add --transport stdio ssh-mcp-keepalive --scope local -- npx -y ssh-mcp-keepalive -- --host=YOUR_HOST --user=YOUR_USER --password=YOUR_PASSWORD

```


* **Project scope**: Share with your team via `.mcp.json` file
```bash
claude mcp add --transport stdio ssh-mcp-keepalive --scope project -- npx -y ssh-mcp-keepalive -- --host=YOUR_HOST --user=YOUR_USER --password=YOUR_PASSWORD

```


* **User scope**: Available across all your projects
```bash
claude mcp add --transport stdio ssh-mcp-keepalive --scope user -- npx -y ssh-mcp-keepalive -- --host=YOUR_HOST --user=YOUR_USER --password=YOUR_PASSWORD

```



**Verify Installation:**

After adding the server, restart Claude Code and ask Cascade to execute a command:

```text
"Can you run 'ls -la' on the remote server?"

```

For more information about MCP in Claude Code, see the [official documentation](https://docs.claude.com/en/docs/claude-code/mcp).

---

## Testing

You can use the [MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector) for visual debugging of this MCP Server.

```bash
npm run inspect

```

---

## Disclaimer

SSH MCP Keepalive Server is provided under the [MIT License](https://www.google.com/search?q=./LICENSE). Use at your own risk. This project is not affiliated with or endorsed by any SSH or MCP provider.

## Contributing

We welcome contributions! Please see our [Contributing Guidelines](https://www.google.com/search?q=./CONTRIBUTING.md) for more information.

## Code of Conduct

This project follows a [Code of Conduct](https://www.google.com/search?q=./CODE_OF_CONDUCT.md) to ensure a welcoming environment for everyone.

## Support

If you find SSH MCP Keepalive Server helpful, consider starring the repository or contributing! Pull requests and feedback are welcome.
