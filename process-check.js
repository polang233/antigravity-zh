'use strict';

const { execFileSync } = require('child_process');

const DEFAULT_TIMEOUT_MS = 5000;

function isAppRunningStrict({ platform = process.platform, run = execFileSync } = {}) {
  if (platform === 'win32') {
    const output = run('tasklist.exe', ['/FO', 'CSV', '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      timeout: DEFAULT_TIMEOUT_MS
    });
    const names = String(output).split(/\r?\n/).map(line => {
      const match = /^"([^"]+)"/.exec(line.trim());
      return match && match[1].toLowerCase();
    }).filter(Boolean);
    if (!names.length) throw new Error('无法解析 Windows 进程列表');
    return names.some(name => ['antigravity.exe', 'language_server.exe'].includes(name));
  }
  try {
    run('pgrep', ['-xi', 'antigravity|language_server'], {
      stdio: 'ignore',
      timeout: DEFAULT_TIMEOUT_MS
    });
    return true;
  } catch (error) {
    // pgrep uses exit 1 for no matches; execution and permission failures
    // must propagate so the installer cannot mistake them for an idle app.
    if (error && error.status === 1) return false;
    throw error;
  }
}

module.exports = { isAppRunningStrict };
