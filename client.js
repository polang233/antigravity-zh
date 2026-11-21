'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { readAsarPackageVersion } = require('./asar-version');
const { isLocalizedAsar, findValidOfficialBackup, normalizeVersion } = require('./src/backup-utils');
const { isAppRunningStrict } = require('./process-check');
const { withInstallLock } = require('./src/install-lock');
const { createAsyncWriteLock, httpError } = require('./src/http-security');
const writeLock = createAsyncWriteLock();

function getAppDir(customPath) {
  if (customPath) {
    if (typeof customPath !== 'string' || !path.isAbsolute(customPath) ||
        customPath.startsWith('\\\\') || customPath.startsWith('//') || customPath.includes('\0')) {
      throw httpError('请选择本机的绝对安装路径', 400);
    }
    const directory = path.resolve(customPath);
    return process.platform === 'darwin' && directory.endsWith('.app') ? path.join(directory, 'Contents') : directory;
  }
  if (process.platform === 'darwin') return '/Applications/Antigravity.app/Contents';
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'antigravity');
  return path.join(os.homedir(), 'Antigravity', 'Antigravity-x64');
}

function getResourcesDir(appDir) {
  const upperPath = path.join(appDir, 'Resources');
  const lowerPath = path.join(appDir, 'resources');
  if (fs.existsSync(upperPath)) return upperPath;
  if (fs.existsSync(lowerPath)) return lowerPath;
  return process.platform === 'darwin' ? upperPath : lowerPath;
}

function assertNotSymlinkOrJunction(targetPath, label = '目标路径') {
  if (!fs.existsSync(targetPath)) return;
  const st = fs.lstatSync(targetPath);
  if (st.isSymbolicLink()) {
    throw httpError(`${label}不允许使用符号链接或目录联接: ${targetPath}`, 400);
  }
}

async function hashFile(filePath) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

async function checkClientStatus({ appDir, getResourcesDir } = {}) {
  if (!appDir) {
    throw new Error('appDir 参数必填');
  }
  const resDirFn = getResourcesDir || (dir => path.join(dir, 'resources'));
  const resourcesDir = path.resolve(resDirFn(appDir));
  const asarPath = path.join(resourcesDir, 'app.asar');
  const defaultBackupPath = path.join(resourcesDir, 'app.asar.bak');

  const isInstalled = fs.existsSync(asarPath);
  if (!isInstalled) {
    return {
      isInstalled: false,
      appDir,
      resourcesDir,
      asarPath,
      appVersion: null,
      isLocalized: false,
      hasBackup: false,
      staleBackups: [],
      isUpdateOverwritten: false
    };
  }

  const appVersion = readAsarPackageVersion(asarPath);
  const isLocalized = isLocalizedAsar(asarPath);
  const backupLookup = findValidOfficialBackup({
    resourcesDir,
    targetVersion: appVersion,
    isLocalizedAsar
  });
  const hasBackup = Boolean(backupLookup.match);
  const backupPath = backupLookup.match ? backupLookup.match.path : defaultBackupPath;
  // 当程序已安装但未汉化时，说明是官方原版安装或官方更新覆盖
  const isUpdateOverwritten = !isLocalized;

  return {
    isInstalled: true,
    appDir,
    resourcesDir,
    asarPath,
    backupPath,
    appVersion,
    isLocalized,
    hasBackup,
    staleBackups: backupLookup.staleBackups,
    isUpdateOverwritten
  };
}

function runClientWrite(appDir, owner, operation) {
  const resourcesDir = getResourcesDir(appDir);
  return writeLock.tryRun(() => {
    assertNotSymlinkOrJunction(appDir, '安装目录');
    assertNotSymlinkOrJunction(resourcesDir, 'Resources 目录');
    return withInstallLock(resourcesDir, () => operation(resourcesDir));
  }, { owner, conflictMessage: '当前已有安装、还原或汉化任务正在进行，请稍候重试' });
}

async function runRestoreWorkflow(appDir, { isAppRunning = isAppRunningStrict } = {}) {
  return runClientWrite(appDir, 'restore', async resourcesDir => {
    const asarPath = path.join(resourcesDir, 'app.asar');
    const legacyBackupPath = path.join(resourcesDir, 'app.asar.bak');

    if (!fs.existsSync(asarPath)) {
      throw new Error(`找不到已安装的 app.asar: ${asarPath}`);
    }
    assertNotSymlinkOrJunction(appDir, '安装目录');
    assertNotSymlinkOrJunction(resourcesDir, 'Resources 目录');
    assertNotSymlinkOrJunction(asarPath, 'app.asar');

    const originalStat = fs.statSync(asarPath, { bigint: true });
    const currentClientVer = readAsarPackageVersion(asarPath);
    if (!currentClientVer) throw httpError('无法确认客户端版本，已停止还原', 409);
    const originalHash = await hashFile(asarPath);
    const backupSearch = findValidOfficialBackup({
      resourcesDir,
      targetVersion: currentClientVer,
      isLocalizedAsar,
    });

    if (!backupSearch.match) {
      if (backupSearch.staleBackups && backupSearch.staleBackups.length > 0) {
        const staleVer = backupSearch.staleBackups[0].version || '未知';
        throw httpError(
          `检测到备份文件版本 (v${staleVer}) 与当前客户端版本 (v${currentClientVer || '未知'}) 不匹配！已安全拦截还原以防止白屏崩溃。`,
          409
        );
      }
      if (fs.existsSync(legacyBackupPath) && isLocalizedAsar(legacyBackupPath)) {
        throw new Error('检测到备份文件 `app.asar.bak` 本身已被汉化包污染，无法还原为官方原版！请重新安装官方安装包以恢复。');
      }
      throw new Error('未找到与当前客户端版本匹配的官方原版备份文件，无法执行恢复！');
    }

    const backupPath = backupSearch.match.path;
    assertNotSymlinkOrJunction(backupPath, '备份文件');

    if (await isAppRunning()) throw httpError('请先正常退出 Antigravity 及其后台服务，再还原官方版', 409);

    const stageRestore = path.join(resourcesDir, `.app.asar.restore-${crypto.randomUUID()}.stage`);
    let staged = false;
    try {
      fs.copyFileSync(backupPath, stageRestore, fs.constants.COPYFILE_EXCL);
      staged = true;
      if (normalizeVersion(readAsarPackageVersion(stageRestore)) !== normalizeVersion(currentClientVer) || isLocalizedAsar(stageRestore) ||
          await hashFile(stageRestore) !== await hashFile(backupPath)) {
        throw httpError('原版备份发生变化，已停止还原', 409);
      }
      assertNotSymlinkOrJunction(asarPath, 'app.asar');
      if (await hashFile(asarPath) !== originalHash) {
        throw httpError('客户端在还原期间发生变化，已保留当前文件，请刷新后重试', 409);
      }
      if (await isAppRunning()) throw httpError('客户端已重新启动，请退出后再还原', 409);
      const beforeCommit = fs.lstatSync(asarPath, { bigint: true });
      if (readAsarPackageVersion(asarPath) !== currentClientVer ||
          beforeCommit.ino !== originalStat.ino || beforeCommit.dev !== originalStat.dev ||
          beforeCommit.ctimeNs !== originalStat.ctimeNs || beforeCommit.size !== originalStat.size) {
        throw httpError('客户端文件已更换，已停止还原', 409);
      }
      fs.renameSync(stageRestore, asarPath);
      staged = false;
    } catch (error) {
      if (error.code === 'ENOENT') throw httpError('客户端或备份文件已更换，请刷新后重试', 409);
      throw error;
    } finally {
      if (staged) fs.unlinkSync(stageRestore);
    }
  });
}

module.exports = { checkClientStatus, normalizeVersion, getAppDir, getResourcesDir, runRestoreWorkflow, writeLock };
