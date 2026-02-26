import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const RELAY_PORT = 19222;
const DARWIN_LAUNCH_AGENT_LABEL = 'ai.browserforce.relay';
const LINUX_SYSTEMD_USER_SERVICE = 'browserforce-relay.service';
const WIN32_TASK_NAME = 'BrowserForceRelay';

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function posixPathJoin(left, right) {
  return `${String(left).replace(/\/+$/, '')}/${String(right).replace(/^\/+/, '')}`;
}

function windowsCommandArg(value) {
  return String(value)
    .replace(/"/g, '""')
    .replace(/%/g, '%%')
    .replace(/[&<>|^]/g, '^$&');
}

function windowsTaskQuotedArg(value) {
  return `"${windowsCommandArg(value)}"`;
}

function windowsTaskEscapeForTr(value) {
  return String(value).replace(/"/g, '""');
}

function xmlEscape(value) {
  return String(value).replace(/[&<>"']/g, (ch) => {
    if (ch === '&') return '&amp;';
    if (ch === '<') return '&lt;';
    if (ch === '>') return '&gt;';
    if (ch === '"') return '&quot;';
    return '&apos;';
  });
}

export function renderLaunchAgentPlist({ label, nodePath, binScriptPath }) {
  const escapedLabel = xmlEscape(label);
  const escapedNodePath = xmlEscape(nodePath);
  const escapedBinScriptPath = xmlEscape(binScriptPath);

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${escapedLabel}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    `    <string>${escapedNodePath}</string>`,
    `    <string>${escapedBinScriptPath}</string>`,
    '    <string>serve</string>',
    '  </array>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <true/>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

export function renderSystemdUserService({ nodePath, binScriptPath }) {
  return [
    '[Unit]',
    'Description=BrowserForce Relay',
    'After=network.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart="${nodePath}" "${binScriptPath}" serve`,
    'Restart=always',
    'RestartSec=2',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

export function buildAutostartSpec({ platform, homeDir, nodePath, binScriptPath }) {
  const activePlatform = platform || process.platform;

  if (activePlatform === 'darwin') {
    const plistPath = posixPathJoin(
      posixPathJoin(homeDir, 'Library/LaunchAgents'),
      `${DARWIN_LAUNCH_AGENT_LABEL}.plist`,
    );
    const programArguments = [nodePath, binScriptPath, 'serve'];
    const plist = renderLaunchAgentPlist({
      label: DARWIN_LAUNCH_AGENT_LABEL,
      nodePath,
      binScriptPath,
    });

    return {
      platform: activePlatform,
      filesToWrite: [
        {
          path: plistPath,
          content: plist,
        },
      ],
      commands: [
        `launchctl unload ${shellQuote(plistPath)} >/dev/null 2>&1 || true`,
        `launchctl load -w ${shellQuote(plistPath)}`,
      ],
      summary: `Install launchd agent ${DARWIN_LAUNCH_AGENT_LABEL}`,
      launchAgent: {
        label: DARWIN_LAUNCH_AGENT_LABEL,
        plistPath,
        programArguments,
      },
    };
  }

  if (activePlatform === 'linux') {
    const servicePath = posixPathJoin(
      posixPathJoin(homeDir, '.config/systemd/user'),
      LINUX_SYSTEMD_USER_SERVICE,
    );
    const serviceContents = renderSystemdUserService({ nodePath, binScriptPath });

    return {
      platform: activePlatform,
      filesToWrite: [
        {
          path: servicePath,
          content: serviceContents,
        },
      ],
      commands: [
        'systemctl --user daemon-reload',
        `systemctl --user enable --now ${LINUX_SYSTEMD_USER_SERVICE}`,
      ],
      summary: `Install systemd user service ${LINUX_SYSTEMD_USER_SERVICE}`,
      systemd: {
        serviceName: LINUX_SYSTEMD_USER_SERVICE,
        servicePath,
      },
    };
  }

  if (activePlatform === 'win32') {
    const commandToRun = `${windowsTaskQuotedArg(nodePath)} ${windowsTaskQuotedArg(binScriptPath)} serve`;
    const createCommand = `schtasks /Create /F /TN "${WIN32_TASK_NAME}" /SC ONLOGON /TR "${windowsTaskEscapeForTr(commandToRun)}"`;

    return {
      platform: activePlatform,
      filesToWrite: [],
      commands: [createCommand],
      summary: `Install scheduled task ${WIN32_TASK_NAME}`,
      scheduledTask: {
        taskName: WIN32_TASK_NAME,
        createCommand,
        commandToRun,
      },
    };
  }

  throw new Error(`Unsupported platform: ${activePlatform}`);
}

export function buildBrowserforceMcpServerEntry({ platform = process.platform } = {}) {
  if (platform === 'win32') {
    const command = [
      `if (-not (netstat -ano | Select-String ':${RELAY_PORT}\\s+.*LISTENING')) {`,
      "Start-Process -WindowStyle Hidden -FilePath 'npx' -ArgumentList '-y','browserforce@latest','serve'",
      '}',
      '& npx -y browserforce@latest mcp',
    ].join(' ');

    return {
      name: 'browserforce',
      transport: 'stdio',
      command: 'powershell',
      args: ['-NoProfile', '-NonInteractive', '-Command', command],
    };
  }

  const command = [
    `if ! lsof -tiTCP:${RELAY_PORT} -sTCP:LISTEN >/dev/null 2>&1; then`,
    'npx -y browserforce@latest serve >/dev/null 2>&1 &',
    'fi;',
    'exec npx -y browserforce@latest mcp',
  ].join(' ');

  return {
    name: 'browserforce',
    transport: 'stdio',
    command: 'sh',
    args: ['-lc', command],
  };
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function ensureMcpAdapterOnce(allowList) {
  const values = Array.isArray(allowList) ? allowList : [];
  const filtered = values.filter((value) => value !== 'mcp-adapter');
  return [...filtered, 'mcp-adapter'];
}

function mergeServers(existingServers, { platform = process.platform } = {}) {
  const values = Array.isArray(existingServers) ? existingServers : [];
  const browserforceEntry = buildBrowserforceMcpServerEntry({ platform });
  const merged = [];
  let inserted = false;

  for (const value of values) {
    const isBrowserforce =
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      value.name === 'browserforce';

    if (!isBrowserforce) {
      merged.push(value);
      continue;
    }

    if (!inserted) {
      merged.push(browserforceEntry);
      inserted = true;
    }
  }

  if (!inserted) {
    merged.push(browserforceEntry);
  }

  return merged;
}

export function mergeOpenClawConfig(existingConfig, { platform = process.platform } = {}) {
  const root = asObject(existingConfig);

  const plugins = asObject(root.plugins);
  const entries = asObject(plugins.entries);
  const mcpAdapter = asObject(entries['mcp-adapter']);
  const mcpAdapterConfig = asObject(mcpAdapter.config);

  const tools = asObject(root.tools);
  const sandbox = asObject(tools.sandbox);
  const sandboxTools = asObject(sandbox.tools);

  return {
    ...root,
    plugins: {
      ...plugins,
      entries: {
        ...entries,
        'mcp-adapter': {
          ...mcpAdapter,
          enabled: true,
          config: {
            ...mcpAdapterConfig,
            servers: mergeServers(mcpAdapterConfig.servers, { platform }),
          },
        },
      },
    },
    tools: {
      ...tools,
      sandbox: {
        ...sandbox,
        tools: {
          ...sandboxTools,
          allow: ensureMcpAdapterOnce(sandboxTools.allow),
        },
      },
    },
  };
}

export function formatJsonStable(obj) {
  return `${JSON.stringify(obj, null, 2)}\n`;
}

function defaultExecFn(command) {
  const result = spawnSync(command, {
    shell: true,
    stdio: 'inherit',
  });

  if (result.error) {
    throw result.error;
  }

  if (typeof result.status === 'number' && result.status !== 0) {
    throw new Error(`Command failed with exit code ${result.status}: ${command}`);
  }

  if (result.status === null) {
    throw new Error(`Command terminated unexpectedly: ${command}`);
  }
}

export async function applyAutostart(spec, { dryRun = false, execFn = defaultExecFn, fsApi = fs } = {}) {
  const filesToWrite = Array.isArray(spec?.filesToWrite) ? spec.filesToWrite : [];
  const commands = Array.isArray(spec?.commands) ? spec.commands : [];
  const report = {
    wroteFiles: filesToWrite.map((file) => file.path),
    ranCommands: [],
    skippedCommands: dryRun ? [...commands] : [],
  };

  if (dryRun) {
    return report;
  }

  for (const file of filesToWrite) {
    const parentDir = path.dirname(file.path);
    await fsApi.mkdir(parentDir, { recursive: true });
    await fsApi.writeFile(file.path, file.content, 'utf8');
  }

  for (const command of commands) {
    await execFn(command);
    report.ranCommands.push(command);
  }

  return report;
}
