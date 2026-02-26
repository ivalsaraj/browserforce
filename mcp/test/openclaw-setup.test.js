import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyAutostart,
  buildBrowserforceMcpServerEntry,
  buildAutostartSpec,
  formatJsonStable,
  mergeOpenClawConfig,
  renderLaunchAgentPlist,
  renderSystemdUserService,
} from '../src/openclaw-setup.js';

function quoteShellArg(value) {
  const stringValue = String(value);
  if (process.platform === 'win32') {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }
  return `'${stringValue.replace(/'/g, `'\\''`)}'`;
}

function buildNodeEvalCommand(source) {
  return `${quoteShellArg(process.execPath)} -e ${quoteShellArg(source)}`;
}

test('buildBrowserforceMcpServerEntry returns stdio sh wrapper with relay autostart on POSIX', () => {
  const entry = buildBrowserforceMcpServerEntry({ platform: 'linux' });

  assert.equal(entry.transport, 'stdio');
  assert.equal(entry.command, 'sh');
  assert.equal(entry.args[0], '-lc');
  assert.match(entry.args[1], /if ! lsof -tiTCP:19222 -sTCP:LISTEN/);
  assert.match(entry.args[1], /npx -y browserforce@latest serve/);
  assert.match(entry.args[1], /exec npx -y browserforce@latest mcp/);
});

test('buildBrowserforceMcpServerEntry returns win32-safe powershell wrapper', () => {
  const entry = buildBrowserforceMcpServerEntry({ platform: 'win32' });

  assert.equal(entry.transport, 'stdio');
  assert.equal(entry.command, 'powershell');
  assert.deepEqual(entry.args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
  assert.match(entry.args[3], /netstat -ano/);
  assert.match(entry.args[3], /browserforce@latest','serve/);
  assert.match(entry.args[3], /& npx -y browserforce@latest mcp/);
});

test('mergeOpenClawConfig adds and enables plugins.entries["mcp-adapter"]', () => {
  const merged = mergeOpenClawConfig({
    plugins: {
      entries: {
        'mcp-adapter': {
          enabled: false,
        },
      },
    },
  });

  assert.equal(merged.plugins.entries['mcp-adapter'].enabled, true);
});

test('mergeOpenClawConfig preserves unrelated keys', () => {
  const existing = {
    ui: {
      theme: 'light',
    },
    plugins: {
      entries: {
        other: {
          enabled: false,
          config: { foo: 1 },
        },
      },
    },
    tools: {
      sandbox: {
        tools: {
          allow: ['shell'],
          deny: ['network'],
        },
      },
    },
  };

  const merged = mergeOpenClawConfig(existing);

  assert.equal(merged.ui.theme, 'light');
  assert.deepEqual(merged.plugins.entries.other, existing.plugins.entries.other);
  assert.deepEqual(merged.tools.sandbox.tools.deny, ['network']);
});

test('mergeOpenClawConfig preserves existing non-browserforce servers', () => {
  const existing = {
    plugins: {
      entries: {
        'mcp-adapter': {
          enabled: false,
          config: {
            timeoutMs: 1000,
            servers: [
              {
                name: 'custom',
                transport: 'stdio',
                command: 'node',
                args: ['custom-mcp.js'],
              },
            ],
          },
        },
      },
    },
  };

  const merged = mergeOpenClawConfig(existing);
  const servers = merged.plugins.entries['mcp-adapter'].config.servers;

  assert.equal(merged.plugins.entries['mcp-adapter'].config.timeoutMs, 1000);
  assert.deepEqual(servers.find((server) => server.name === 'custom'), existing.plugins.entries['mcp-adapter'].config.servers[0]);
  assert.equal(servers.filter((server) => server.name === 'browserforce').length, 1);
});

test('mergeOpenClawConfig updates browserforce server entry once without duplicates', () => {
  const existing = {
    plugins: {
      entries: {
        'mcp-adapter': {
          config: {
            servers: [
              { name: 'custom', transport: 'stdio', command: 'node', args: ['custom.js'] },
              { name: 'browserforce', transport: 'stdio', command: 'node', args: ['old-browserforce.js'] },
              { name: 'browserforce', transport: 'stdio', command: 'node', args: ['stale-browserforce.js'] },
            ],
          },
        },
      },
    },
  };

  const merged = mergeOpenClawConfig(existing);
  const servers = merged.plugins.entries['mcp-adapter'].config.servers;
  const browserforceServers = servers.filter((server) => server.name === 'browserforce');

  assert.equal(browserforceServers.length, 1);
  assert.deepEqual(browserforceServers[0], buildBrowserforceMcpServerEntry());
  assert.deepEqual(servers.find((server) => server.name === 'custom'), existing.plugins.entries['mcp-adapter'].config.servers[0]);
});

test('mergeOpenClawConfig is idempotent', () => {
  const first = mergeOpenClawConfig({
    plugins: { entries: {} },
    tools: { sandbox: { tools: { allow: ['shell'] } } },
  });
  const second = mergeOpenClawConfig(first);

  assert.deepEqual(second, first);
});

test('mergeOpenClawConfig writes win32 browserforce server entry without sh', () => {
  const merged = mergeOpenClawConfig(
    {
      plugins: {
        entries: {
          'mcp-adapter': {
            config: {
              servers: [],
            },
          },
        },
      },
    },
    { platform: 'win32' },
  );
  const server = merged.plugins.entries['mcp-adapter'].config.servers.find((value) => value.name === 'browserforce');

  assert.equal(server.command, 'powershell');
  assert.deepEqual(server.args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
});

test('formatJsonStable uses 2-space indentation and trailing newline', () => {
  const out = formatJsonStable({ a: 1, nested: { b: true } });
  assert.equal(out, '{\n  "a": 1,\n  "nested": {\n    "b": true\n  }\n}\n');
});

test('mergeOpenClawConfig ensures tools.sandbox.tools.allow includes mcp-adapter once', () => {
  const merged = mergeOpenClawConfig({
    tools: {
      sandbox: {
        tools: {
          allow: ['shell', 'mcp-adapter', 'mcp-adapter'],
        },
      },
    },
  });

  const allow = merged.tools.sandbox.tools.allow;
  assert.equal(allow.includes('mcp-adapter'), true);
  assert.equal(allow.filter((item) => item === 'mcp-adapter').length, 1);
  assert.equal(allow.includes('shell'), true);
});

test('buildAutostartSpec returns darwin launch agent spec', () => {
  const spec = buildAutostartSpec({
    platform: 'darwin',
    homeDir: '/Users/alex',
    nodePath: '/usr/local/bin/node',
    binScriptPath: '/Users/alex/.npm/_npx/browserforce/bin.js',
  });

  assert.equal(spec.platform, 'darwin');
  assert.equal(Array.isArray(spec.filesToWrite), true);
  assert.equal(spec.filesToWrite.length, 1);
  assert.equal(spec.filesToWrite[0].path, '/Users/alex/Library/LaunchAgents/ai.browserforce.relay.plist');
  assert.match(spec.filesToWrite[0].content, /<key>Label<\/key>\n\s*<string>ai\.browserforce\.relay<\/string>/);
  assert.equal(Array.isArray(spec.commands), true);
  assert.deepEqual(spec.commands, [
    "launchctl unload '/Users/alex/Library/LaunchAgents/ai.browserforce.relay.plist' >/dev/null 2>&1 || true",
    "launchctl load -w '/Users/alex/Library/LaunchAgents/ai.browserforce.relay.plist'",
  ]);
  assert.equal(typeof spec.summary, 'string');
  assert.notEqual(spec.summary.trim(), '');
  assert.equal(spec.launchAgent.label, 'ai.browserforce.relay');
  assert.equal(spec.launchAgent.plistPath, '/Users/alex/Library/LaunchAgents/ai.browserforce.relay.plist');
  assert.match(spec.launchAgent.programArguments.join(' '), /\/usr\/local\/bin\/node .*\/bin\.js serve/);
});

test('buildAutostartSpec returns linux systemd user service spec', () => {
  const spec = buildAutostartSpec({
    platform: 'linux',
    homeDir: '/home/alex',
    nodePath: '/usr/bin/node',
    binScriptPath: '/home/alex/.npm/_npx/browserforce/bin.js',
  });

  assert.equal(spec.platform, 'linux');
  assert.equal(Array.isArray(spec.filesToWrite), true);
  assert.equal(spec.filesToWrite.length, 1);
  assert.equal(spec.filesToWrite[0].path, '/home/alex/.config/systemd/user/browserforce-relay.service');
  assert.match(spec.filesToWrite[0].content, /ExecStart="\/usr\/bin\/node" "\/home\/alex\/\.npm\/_npx\/browserforce\/bin\.js" serve/);
  assert.equal(Array.isArray(spec.commands), true);
  assert.deepEqual(spec.commands, [
    'systemctl --user daemon-reload',
    'systemctl --user enable --now browserforce-relay.service',
  ]);
  assert.equal(typeof spec.summary, 'string');
  assert.notEqual(spec.summary.trim(), '');
  assert.equal(spec.systemd.servicePath, '/home/alex/.config/systemd/user/browserforce-relay.service');
  assert.equal(spec.commands.some((command) => command === 'systemctl --user enable --now browserforce-relay.service'), true);
});

test('buildAutostartSpec returns win32 scheduled task spec', () => {
  const spec = buildAutostartSpec({
    platform: 'win32',
    homeDir: 'C:\\Users\\alex',
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    binScriptPath: 'C:\\Users\\alex\\AppData\\Roaming\\npm\\node_modules\\browserforce\\bin.js',
  });

  assert.equal(spec.platform, 'win32');
  assert.equal(Array.isArray(spec.filesToWrite), true);
  assert.deepEqual(spec.filesToWrite, []);
  assert.equal(Array.isArray(spec.commands), true);
  assert.equal(spec.commands.length, 1);
  assert.match(spec.commands[0], /schtasks\s+\/Create/);
  assert.equal(typeof spec.summary, 'string');
  assert.notEqual(spec.summary.trim(), '');
  assert.equal(spec.scheduledTask.taskName, 'BrowserForceRelay');
  assert.match(spec.scheduledTask.createCommand, /schtasks\s+\/Create/);
  assert.match(spec.scheduledTask.createCommand, /\/SC\s+ONLOGON/);
});

test('buildAutostartSpec win32 escapes cmd metacharacters and quotes in /TR payload', () => {
  const spec = buildAutostartSpec({
    platform: 'win32',
    homeDir: 'C:\\Users\\alex',
    nodePath: 'C:\\Program Files\\Tools & Stuff\\100%\\node.exe',
    binScriptPath: 'C:\\Users\\alex\\AppData\\Roaming\\npm\\b&f%\\bin"odd".js',
  });

  assert.equal(spec.platform, 'win32');
  assert.match(spec.scheduledTask.commandToRun, /"\S[\s\S]*"\s+"\S[\s\S]*"\s+serve$/);
  assert.match(spec.scheduledTask.commandToRun, /\^&/);
  assert.match(spec.scheduledTask.commandToRun, /%%/);
  assert.match(spec.scheduledTask.commandToRun, /""odd""/);
  assert.match(spec.scheduledTask.createCommand, /\/TR\s+"/);
  assert.match(spec.scheduledTask.createCommand, /\^&/);
  assert.match(spec.scheduledTask.createCommand, /%%/);
});

test('buildAutostartSpec throws for unsupported platform', () => {
  assert.throws(
    () =>
      buildAutostartSpec({
        platform: 'freebsd',
        homeDir: '/home/alex',
        nodePath: '/usr/bin/node',
        binScriptPath: '/home/alex/bin/browserforce',
      }),
    /Unsupported platform: freebsd/,
  );
});

test('renderLaunchAgentPlist includes expected label, args, and run-at-load keys', () => {
  const output = renderLaunchAgentPlist({
    label: 'ai.browserforce.relay',
    nodePath: '/usr/local/bin/node',
    binScriptPath: '/Users/alex/.npm/_npx/browserforce/bin.js',
  });

  assert.match(output, /<key>Label<\/key>\n\s*<string>ai\.browserforce\.relay<\/string>/);
  assert.match(output, /<key>ProgramArguments<\/key>\n\s*<array>\n\s*<string>\/usr\/local\/bin\/node<\/string>\n\s*<string>\/Users\/alex\/\.npm\/_npx\/browserforce\/bin\.js<\/string>\n\s*<string>serve<\/string>\n\s*<\/array>/);
  assert.match(output, /<key>RunAtLoad<\/key>\n\s*<true\/>/);
});

test('renderLaunchAgentPlist escapes XML entities in interpolated values', () => {
  const output = renderLaunchAgentPlist({
    label: 'relay & <label> "x" \'y\'',
    nodePath: '/tmp/&<node>"\'',
    binScriptPath: '/tmp/&<script>"\'',
  });

  assert.match(output, /<string>relay &amp; &lt;label&gt; &quot;x&quot; &apos;y&apos;<\/string>/);
  assert.match(output, /<string>\/tmp\/&amp;&lt;node&gt;&quot;&apos;<\/string>/);
  assert.match(output, /<string>\/tmp\/&amp;&lt;script&gt;&quot;&apos;<\/string>/);
});

test('renderSystemdUserService includes unit, service, install sections and expected ExecStart', () => {
  const output = renderSystemdUserService({
    nodePath: '/usr/bin/node',
    binScriptPath: '/home/alex/.npm/_npx/browserforce/bin.js',
  });

  assert.match(output, /^\[Unit\]/m);
  assert.match(output, /^\[Service\]/m);
  assert.match(output, /^\[Install\]/m);
  assert.match(output, /^ExecStart="\/usr\/bin\/node" "\/home\/alex\/\.npm\/_npx\/browserforce\/bin\.js" serve$/m);
});

test('applyAutostart dryRun=true runs no commands and returns planned actions', async () => {
  const spec = {
    filesToWrite: [
      {
        path: '/tmp/browserforce/autostart/file.txt',
        content: 'hello',
      },
    ],
    commands: ['echo one', 'echo two'],
  };
  const execCalls = [];
  const fsCalls = [];

  const report = await applyAutostart(spec, {
    dryRun: true,
    execFn: async (command) => {
      execCalls.push(command);
    },
    fsApi: {
      mkdir: async (...args) => {
        fsCalls.push(['mkdir', ...args]);
      },
      writeFile: async (...args) => {
        fsCalls.push(['writeFile', ...args]);
      },
    },
  });

  assert.deepEqual(execCalls, []);
  assert.deepEqual(fsCalls, []);
  assert.deepEqual(report, {
    wroteFiles: ['/tmp/browserforce/autostart/file.txt'],
    ranCommands: [],
    skippedCommands: ['echo one', 'echo two'],
  });
});

test('applyAutostart dryRun=false executes commands in order', async () => {
  const spec = {
    filesToWrite: [],
    commands: ['echo first', 'echo second', 'echo third'],
  };
  const execCalls = [];

  const report = await applyAutostart(spec, {
    dryRun: false,
    execFn: async (command) => {
      execCalls.push(command);
    },
    fsApi: {
      mkdir: async () => {},
      writeFile: async () => {},
    },
  });

  assert.deepEqual(execCalls, ['echo first', 'echo second', 'echo third']);
  assert.deepEqual(report, {
    wroteFiles: [],
    ranCommands: ['echo first', 'echo second', 'echo third'],
    skippedCommands: [],
  });
});

test('applyAutostart creates parent directories before writing files', async () => {
  const spec = {
    filesToWrite: [
      {
        path: '/tmp/browserforce/nested/path/file.txt',
        content: 'created',
      },
    ],
    commands: [],
  };
  const fsCalls = [];

  const report = await applyAutostart(spec, {
    dryRun: false,
    execFn: async () => {},
    fsApi: {
      mkdir: async (...args) => {
        fsCalls.push(['mkdir', ...args]);
      },
      writeFile: async (...args) => {
        fsCalls.push(['writeFile', ...args]);
      },
    },
  });

  assert.deepEqual(fsCalls, [
    ['mkdir', '/tmp/browserforce/nested/path', { recursive: true }],
    ['writeFile', '/tmp/browserforce/nested/path/file.txt', 'created', 'utf8'],
  ]);
  assert.deepEqual(report, {
    wroteFiles: ['/tmp/browserforce/nested/path/file.txt'],
    ranCommands: [],
    skippedCommands: [],
  });
});

test('applyAutostart writes all files before executing any commands', async () => {
  const spec = {
    filesToWrite: [
      {
        path: '/tmp/browserforce/first/file.txt',
        content: 'one',
      },
      {
        path: '/tmp/browserforce/second/file.txt',
        content: 'two',
      },
    ],
    commands: ['echo after-files', 'echo still-after-files'],
  };
  const callOrder = [];

  const report = await applyAutostart(spec, {
    dryRun: false,
    execFn: async (command) => {
      callOrder.push(`exec:${command}`);
    },
    fsApi: {
      mkdir: async (dirPath) => {
        callOrder.push(`mkdir:${dirPath}`);
      },
      writeFile: async (filePath) => {
        callOrder.push(`writeFile:${filePath}`);
      },
    },
  });

  assert.deepEqual(callOrder, [
    'mkdir:/tmp/browserforce/first',
    'writeFile:/tmp/browserforce/first/file.txt',
    'mkdir:/tmp/browserforce/second',
    'writeFile:/tmp/browserforce/second/file.txt',
    'exec:echo after-files',
    'exec:echo still-after-files',
  ]);
  assert.deepEqual(report, {
    wroteFiles: ['/tmp/browserforce/first/file.txt', '/tmp/browserforce/second/file.txt'],
    ranCommands: ['echo after-files', 'echo still-after-files'],
    skippedCommands: [],
  });
});

test('applyAutostart default execFn runs process.execPath command successfully', async () => {
  const command = buildNodeEvalCommand('process.exit(0)');

  const report = await applyAutostart(
    {
      filesToWrite: [],
      commands: [command],
    },
    {
      dryRun: false,
      fsApi: {
        mkdir: async () => {},
        writeFile: async () => {},
      },
    },
  );

  assert.deepEqual(report, {
    wroteFiles: [],
    ranCommands: [command],
    skippedCommands: [],
  });
});

test('applyAutostart default execFn includes exit code and command on non-zero status', async () => {
  const command = buildNodeEvalCommand('process.exit(7)');

  await assert.rejects(
    applyAutostart(
      {
        filesToWrite: [],
        commands: [command],
      },
      {
        dryRun: false,
        fsApi: {
          mkdir: async () => {},
          writeFile: async () => {},
        },
      },
    ),
    (error) => {
      assert.match(error.message, /Command failed with exit code 7/);
      assert.equal(error.message.includes(command), true);
      return true;
    },
  );
});
