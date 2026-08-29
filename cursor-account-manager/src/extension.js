"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const child_process_1 = require("child_process");
const cdpBrowser_1 = require("./cdpBrowser");
const { AccountRepository } = require("./accountRepository");
const accountBackup = require("./accountBackup");
const { migrateManualTokenFromConfiguration } = require("./migrations");
const { createNetworkPolicy, MODES } = require("./networkPolicy");
const { createCursorHttpClient } = require("./cursorHttp");
const { createCursorOAuth } = require("./cursorOAuth");
const { CursorStateStore } = require("./cursorStateStore");
const sandElevation = require("./sandElevation");
const { presentError } = require("./errorPresentation");
const { durableUnlink } = require("./atomicFile");

const sandPatcher = require('./sandPatcher');
let provider;
let extensionContext;
let accountRepository;
let networkPolicy;
let cursorHttpClient;
let cursorOAuth;
let cursorStateStore;
let accountUsage = null;
let accountLoading = false;
let accountTokenRefreshTimer = null;
let automaticNetworkTimeouts = [];
let currentCursorUserIdCache = '';
let currentCursorEmailCache = '';
let sqliteModuleCache;
let sandStatusBar;
let restartScheduled = false;
let pendingImportAccounts = [];
let migrationBlocked = false;
let runtimeStatus = {
    migration: { state: 'pending', message: '正在检查旧版凭据' },
    recovery: { state: 'pending', message: '正在检查未完成的切号事务' }
};

const VIEW_ID = 'cursor-account-manager.sidePanel';
const CONTAINER_ID = 'cursor-account-manager';
const CMD_OPEN = 'cursor-account-manager.openPanel';
const CMD_SAND_APPLY = 'cursor-account-manager.sandApply';
const CMD_SAND_RESTORE = 'cursor-account-manager.sandRestore';
const CFG_SECTION = 'cursorAccountManager';
const CFG_LEGACY = 'keepchat';
const UA = 'Mozilla/5.0 (CursorAccountManager)';
const WEBVIEW_OPERATION_LABELS = Object.freeze({
    openDashboard: '打开账号控制台',
    restartCursor: '重启 Cursor',
    accountAddCurrent: '导入当前账号',
    accountAddToken: '添加 Token 账号',
    accountDeepLogin: '浏览器授权',
    accountUpgradeToken: '升级账号令牌',
    accountRefreshToken: '续期账号令牌',
    accountRemove: '删除账号',
    accountCopyToken: '复制 Token',
    accountExportAll: '导出账号',
    accountImportAll: '读取账号备份',
    accountImportConfirm: '导入账号',
    accountSetNote: '保存账号备注',
    accountRefreshOne: '刷新账号',
    accountSwitch: '切换账号',
    accountSetHardLimit: '修改超额设置',
    accountListSessions: '读取设备会话',
    accountRevokeSession: '踢设备下线',
    sandApply: '注入 Sand',
    sandRestore: '卸载 Sand'
});

function cfgGetMachine(key) {
    const neu = vscode.workspace.getConfiguration(CFG_SECTION);
    const inspected = neu.inspect(key);
    if (inspected && inspected.globalValue !== undefined)
        return inspected.globalValue;
    const legacy = vscode.workspace.getConfiguration(CFG_LEGACY);
    const legacyInspected = legacy.inspect(key);
    if (legacyInspected && legacyInspected.globalValue !== undefined)
        return legacyInspected.globalValue;
    return inspected ? inspected.defaultValue : undefined;
}
function manualTokenMigrationPlan() {
    const folders = Array.isArray(vscode.workspace.workspaceFolders)
        ? vscode.workspace.workspaceFolders.map(folder => folder.uri)
        : [];
    const scopes = {
        global: { property: 'globalValue', target: vscode.ConfigurationTarget.Global, resource: undefined },
        workspace: { property: 'workspaceValue', target: vscode.ConfigurationTarget.Workspace, resource: undefined }
    };
    const parse = (key) => {
        const match = /^manualCursorToken@(global|workspace|workspaceFolder:(\d+))$/.exec(String(key || ''));
        if (!match)
            throw new Error('无效的旧 Token 配置位置');
        if (match[1] === 'global' || match[1] === 'workspace')
            return scopes[match[1]];
        const index = Number(match[2]);
        if (!Number.isSafeInteger(index) || !folders[index])
            throw new Error('旧 Token 工作区文件夹已不存在');
        return {
            property: 'workspaceFolderValue',
            target: vscode.ConfigurationTarget.WorkspaceFolder,
            resource: folders[index]
        };
    };
    const configuration = {
        async get(section, key) {
            const scope = parse(key);
            const inspected = vscode.workspace.getConfiguration(section, scope.resource).inspect('manualCursorToken');
            return inspected ? inspected[scope.property] : undefined;
        },
        async clear(section, key) {
            const scope = parse(key);
            await vscode.workspace.getConfiguration(section, scope.resource).update('manualCursorToken', undefined, scope.target);
        }
    };
    const locations = [];
    for (const section of [CFG_SECTION, CFG_LEGACY]) {
        locations.push(
            { section, key: 'manualCursorToken@global' },
            { section, key: 'manualCursorToken@workspace' }
        );
        folders.forEach((_resource, index) => {
            locations.push({
                section,
                key: `manualCursorToken@workspaceFolder:${index}`
            });
        });
    }
    return { configuration, locations };
}

async function migrateLegacyManualTokens() {
    const { configuration, locations } = manualTokenMigrationPlan();
    return migrateManualTokenFromConfiguration({
        repository: accountRepository,
        configuration,
        locations
    });
}

function explicitConfigValues(section, key) {
    const inspected = vscode.workspace.getConfiguration(section).inspect(key);
    if (!inspected)
        return [];
    return [
        inspected.globalValue,
        inspected.workspaceValue,
        inspected.workspaceFolderValue
    ].filter(value => value !== undefined);
}

async function initializeNetworkMode() {
    const configured = [CFG_SECTION, CFG_LEGACY]
        .map(section => vscode.workspace.getConfiguration(section).inspect('networkMode'))
        .map(inspected => inspected && inspected.globalValue)
        .filter(value => value !== undefined)
        .map(value => String(value || '').toLowerCase())
        .find(value => Object.values(MODES).includes(value));
    if (configured)
        return configured;

    const legacyValues = explicitConfigValues(CFG_SECTION, 'accountUsageEnabled')
        .concat(explicitConfigValues(CFG_LEGACY, 'accountUsageEnabled'));
    const mode = legacyValues.some(value => value === false)
        ? MODES.OFF
        : (legacyValues.some(value => value === true) || getAccounts().length > 0
            ? MODES.AUTOMATIC
            : MODES.MANUAL);
    await vscode.workspace.getConfiguration(CFG_SECTION)
        .update('networkMode', mode, vscode.ConfigurationTarget.Global);
    return mode;
}

function clearAutomaticNetworkTasks() {
    for (const timer of automaticNetworkTimeouts)
        clearTimeout(timer);
    automaticNetworkTimeouts = [];
    if (accountTokenRefreshTimer) {
        clearInterval(accountTokenRefreshTimer);
        accountTokenRefreshTimer = null;
    }
}

function configureAutomaticNetworkTasks() {
    clearAutomaticNetworkTasks();
    if (migrationBlocked || !networkPolicy || networkPolicy.mode !== MODES.AUTOMATIC)
        return;
    automaticNetworkTimeouts.push(setTimeout(() => {
        fetchCursorUsage('automatic').catch(error => {
            reportOperationError('自动刷新当前账号用量', error, { notify: false });
        });
    }, 2500));
    if (cfgGetMachine('autoRefreshAccountTokens') !== false) {
        automaticNetworkTimeouts.push(setTimeout(() => {
            refreshAllAccountTokens().catch(error => {
                reportOperationError('自动续期账号令牌', error, { notify: false });
            });
        }, 30000));
        accountTokenRefreshTimer = setInterval(() => {
            refreshAllAccountTokens().catch(error => {
                reportOperationError('自动续期账号令牌', error, { notify: false });
            });
        }, 600000);
    }
}

function now() { return new Date().toISOString(); }

function reportOperationError(operation, error, options = {}) {
    const detail = presentError(error, {
        fallback: options.fallback || `${operation}失败`
    });
    provider?.post({
        type: 'operationError',
        operation: String(operation || '操作'),
        error: detail
    });
    if (options.notify !== false) {
        const text = `账号管理：${operation}失败 - ${detail.message}`;
        if (options.warning)
            vscode.window.showWarningMessage(text);
        else
            vscode.window.showErrorMessage(text);
    }
    return detail;
}

function commandWithErrors(operation, handler) {
    return async (...args) => {
        try {
            return await handler(...args);
        }
        catch (error) {
            reportOperationError(operation, error);
            return undefined;
        }
    };
}

function migrationGuard(operation) {
    if (!migrationBlocked)
        return;
    const error = new Error(`安全凭据迁移未完成，已阻止${operation}`);
    error.code = 'MIGRATION_BLOCKED';
    throw error;
}

function stateWriteGuard(operation) {
    migrationGuard(operation);
    if (runtimeStatus.recovery && runtimeStatus.recovery.state === 'blocked') {
        const error = new Error(`切号事务尚未恢复，已阻止${operation}`);
        error.code = 'RECOVERY_BLOCKED';
        error.recoveryRequired = true;
        throw error;
    }
}

function extensionVersion() {
    return String(extensionContext?.extension?.packageJSON?.version || 'unknown');
}

async function activate(context) {
    extensionContext = context;
    accountRepository = new AccountRepository(context);
    try {
        await accountRepository.initialize();
        await migrateLegacyManualTokens();
        runtimeStatus.migration = {
            state: 'ready',
            message: '凭据已由系统安全存储保护'
        };
    }
    catch (error) {
        migrationBlocked = true;
        const detail = presentError(error, { fallback: '安全凭据迁移失败' });
        runtimeStatus.migration = {
            state: 'blocked',
            message: detail.message,
            error: detail
        };
        vscode.window.showErrorMessage('账号管理：安全迁移失败；联网和登录态写入已锁定，以避免丢失凭据 - ' + detail.message);
    }
    let networkMode = migrationBlocked ? MODES.OFF : MODES.MANUAL;
    if (!migrationBlocked) {
        try {
            networkMode = await initializeNetworkMode();
        }
        catch (error) {
            const detail = presentError(error, { fallback: '网络模式迁移失败' });
            vscode.window.showWarningMessage('账号管理：网络模式迁移失败，已安全回退为仅手动联网 - ' + detail.message);
        }
    }
    networkPolicy = createNetworkPolicy({ mode: networkMode });
    cursorHttpClient = createCursorHttpClient({ policy: networkPolicy });
    try {
        cursorOAuth = createCursorOAuth({
            http: createCursorHttpClient(),
            policy: networkPolicy,
            clientId: cursorOAuthClientId()
        });
    }
    catch (error) {
        runtimeStatus.oauth = {
            state: 'limited',
            message: presentError(error, { fallback: 'OAuth 客户端配置无效' }).message
        };
        cursorOAuth = createCursorOAuth({
            http: createCursorHttpClient(),
            policy: networkPolicy
        });
    }
    let activationReady = false;
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration(CFG_SECTION + '.networkMode') ||
            event.affectsConfiguration(CFG_SECTION + '.autoRefreshAccountTokens')) {
            const mode = migrationBlocked
                ? MODES.OFF
                : String(cfgGetMachine('networkMode') || MODES.MANUAL);
            try {
                networkPolicy.setMode(mode);
            }
            catch (error) {
                networkPolicy.setMode(MODES.OFF);
                reportOperationError('应用网络模式', error, { warning: true });
            }
            if (networkPolicy.mode === MODES.OFF) {
                (0, cdpBrowser_1.disposeAll)().catch(error => {
                    reportOperationError('关闭离线模式下的隔离浏览器', error, { notify: false });
                });
            }
            if (activationReady)
                configureAutomaticNetworkTasks();
            accountUsage = null;
            provider?.postState();
        }
    }));
    try {
        networkPolicy.setMode(
            migrationBlocked
                ? MODES.OFF
                : String(cfgGetMachine('networkMode') || MODES.MANUAL)
        );
    }
    catch (error) {
        networkPolicy.setMode(MODES.OFF);
        reportOperationError('对账网络模式', error, { warning: true });
    }
    if (networkPolicy.mode === MODES.OFF) {
        try {
            await (0, cdpBrowser_1.disposeAll)();
        }
        catch (error) {
            reportOperationError('对账离线浏览器状态', error, { notify: false });
        }
    }
    const sqlite = loadCursorSqlite();
    if (sqlite) {
        cursorStateStore = new CursorStateStore({
            storageDir: cursorGlobalStorageDir(),
            loaded: sqlite,
            maxBackups: 5
        });
        try {
            const recovery = await cursorStateStore.recover();
            if (recovery && recovery.recovered) {
                const recoveryMessage = recovery.action === 'finalized-commit'
                    ? '已完成上次中断的切号提交'
                    : recovery.action === 'finalized-abort'
                        ? '已清理未写入的并发冲突事务'
                        : '已回滚上次中断的切号操作';
                runtimeStatus.recovery = {
                    state: 'recovered',
                    action: recovery.action,
                    message: recoveryMessage
                };
                vscode.window.showWarningMessage(
                    '账号管理：' + recoveryMessage
                );
            }
            else {
                runtimeStatus.recovery = {
                    state: 'ready',
                    message: '没有待恢复的切号事务'
                };
            }
        }
        catch (error) {
            const detail = presentError(error, { fallback: '切号事务恢复失败' });
            runtimeStatus.recovery = {
                state: 'blocked',
                message: detail.message,
                error: detail
            };
            vscode.window.showErrorMessage('账号管理：切号事务恢复失败；切号功能已保持锁定 - ' + detail.message);
        }
    }
    else {
        runtimeStatus.recovery = {
            state: 'unavailable',
            message: '当前 Cursor 未提供可用的 SQLite 模块'
        };
    }
    try {
        await (0, cdpBrowser_1.initializeCleanup)(context.globalStorageUri && context.globalStorageUri.fsPath);
    }
    catch (error) {
        const detail = presentError(error, { fallback: '隔离浏览器残留目录清理失败' });
        vscode.window.showWarningMessage('账号管理：隔离浏览器残留目录清理失败 - ' + detail.message);
    }
    provider = new AccountProvider(context.extensionUri);
    const openPanel = () => vscode.commands.executeCommand('workbench.view.extension.' + CONTAINER_ID);
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(VIEW_ID, provider, { webviewOptions: { retainContextWhenHidden: true } }));
    context.subscriptions.push(vscode.commands.registerCommand(CMD_OPEN, openPanel));
    context.subscriptions.push(vscode.commands.registerCommand('keepchat.openPanel', openPanel));
    context.subscriptions.push(vscode.commands.registerCommand('cursor-account-manager.setManualToken', commandWithErrors('设置手动 Token', async () => {
        migrationGuard('设置手动 Token');
        const token = await vscode.window.showInputBox({
            title: '安全设置手动 Cursor Token',
            prompt: '格式：userId::accessToken，可选第三段 refreshToken',
            password: true,
            ignoreFocusOut: true,
            validateInput: value => parseCursorSessionInput(value).accessToken ? undefined : '请输入有效 Token'
        });
        if (token === undefined)
            return;
        await accountRepository.setManualToken(token);
        vscode.window.showInformationMessage('账号管理：手动 Token 已保存到系统安全存储');
        provider?.postState();
    })));
    context.subscriptions.push(vscode.commands.registerCommand('cursor-account-manager.clearManualToken', commandWithErrors('清除手动 Token', async () => {
        migrationGuard('清除手动 Token');
        const accepted = await vscode.window.showWarningMessage(
            '确定从系统安全存储中删除手动 Token 吗？此操作无法撤销。',
            { modal: true },
            '清除 Token'
        );
        if (accepted !== '清除 Token')
            return;
        await accountRepository.clearManualToken();
        vscode.window.showInformationMessage('账号管理：手动 Token 已清除');
        provider?.postState();
    })));
    context.subscriptions.push(vscode.commands.registerCommand('cursor-account-manager.manualTokenStatus', commandWithErrors('读取手动 Token 状态', async () => {
        const configured = !!(await accountRepository.getManualToken());
        vscode.window.showInformationMessage(configured ? '账号管理：已配置安全手动 Token' : '账号管理：未配置手动 Token');
    })));
    context.subscriptions.push(vscode.commands.registerCommand('cursor-account-manager.restoreAccountState', commandWithErrors('恢复登录态', async () => {
        migrationGuard('恢复登录态');
        if (!cursorStateStore) {
            reportOperationError('恢复登录态', '未找到可用 SQLite 模块');
            return;
        }
        const accepted = await vscode.window.showWarningMessage(
            '确定恢复最近一次切号前的鉴权状态吗？只恢复鉴权键，不覆盖布局等其他 Cursor 状态。恢复后需要完整重启 Cursor。',
            { modal: true },
            '恢复登录态'
        );
        if (accepted !== '恢复登录态')
            return;
        try {
            const result = await cursorStateStore.restoreLatest();
            runtimeStatus.recovery = {
                state: 'ready',
                message: '登录态恢复完成'
            };
            provider?.postState();
            vscode.window.showInformationMessage('账号管理：已从 ' + result.restoredFrom + ' 恢复鉴权状态，请完整重启 Cursor');
        }
        catch (error) {
            reportOperationError('恢复登录态', error);
        }
    })));
    const sandApply = async () => {
        try {
            const result = await applySandPatchFromUi();
            if (result && result.cancelled)
                return;
            if (result && result.changed === false)
                vscode.window.showInformationMessage('账号管理：Sand 已经是注入状态');
            else
                promptSandRestart('apply');
        }
        catch (e) {
            reportOperationError('注入 Sand', e);
        }
    };
    context.subscriptions.push(vscode.commands.registerCommand(CMD_SAND_APPLY, sandApply));
    context.subscriptions.push(vscode.commands.registerCommand('cursor-account-manager.applyPatch', sandApply));
    context.subscriptions.push(vscode.commands.registerCommand('keepchat.sandApply', sandApply));
    context.subscriptions.push(vscode.commands.registerCommand('keepchat.applyPatch', sandApply));
    const sandRestore = async () => {
        try {
            const result = await restoreSandPatchFromUi();
            if (result && result.cancelled)
                return;
            promptSandRestart('restore');
        }
        catch (e) {
            reportOperationError('卸载 Sand', e);
        }
    };
    context.subscriptions.push(vscode.commands.registerCommand(CMD_SAND_RESTORE, sandRestore));
    context.subscriptions.push(vscode.commands.registerCommand('keepchat.sandRestore', sandRestore));
    sandStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 80);
    context.subscriptions.push(sandStatusBar);
    sandStatusBar.show();
    refreshSandStatusBar();
    setTimeout(() => {
        promptPendingTokenImport().catch(error => {
            reportOperationError('导入旧版待处理账号', error);
        });
    }, 1800);
    setTimeout(() => {
        refreshCurrentUserId().catch(error => {
            reportOperationError('读取当前 Cursor 账号', error, { warning: true });
        });
    }, 2600);
    activationReady = true;
    configureAutomaticNetworkTasks();
    context.subscriptions.push({
        dispose: () => {
            clearAutomaticNetworkTasks();
            try {
                networkPolicy?.dispose();
            }
            catch (error) {
                reportOperationError('释放网络策略', error, { notify: false });
            }
        }
    });
}

async function deactivate() {
    clearAutomaticNetworkTasks();
    try {
        networkPolicy?.dispose();
    }
    catch (error) {
        reportOperationError('释放网络策略', error, { notify: false });
    }
    try {
        await (0, cdpBrowser_1.disposeAll)();
    }
    catch (error) {
        reportOperationError('清理隔离浏览器', error, { notify: false });
    }
}

function clientState() {
    let accounts = [];
    let credentialStatus = {
        state: migrationBlocked ? 'blocked' : 'ready',
        available: 0,
        missing: 0
    };
    try {
        accounts = accountsForClient();
        credentialStatus.available = accounts.filter(account => account.credentialStatus === 'available').length;
        credentialStatus.missing = accounts.filter(account => account.credentialStatus !== 'available').length;
        if (!migrationBlocked && credentialStatus.missing > 0)
            credentialStatus.state = 'warning';
    }
    catch (error) {
        const detail = presentError(error, { fallback: '无法读取安全账号仓库' });
        credentialStatus = {
            state: 'blocked',
            available: 0,
            missing: 0,
            error: detail,
            message: detail.message
        };
    }
    return {
        account: buildAccount(0, 0, 0),
        accounts,
        version: extensionVersion(),
        sand: sandStatusForClient(),
        status: {
            network: {
                mode: networkPolicy ? networkPolicy.mode : MODES.OFF,
                automatic: !!networkPolicy && networkPolicy.mode === MODES.AUTOMATIC
            },
            migration: runtimeStatus.migration,
            recovery: runtimeStatus.recovery,
            oauth: runtimeStatus.oauth || { state: 'ready', message: '' },
            credentials: credentialStatus
        }
    };
}

class AccountProvider {
    constructor(extUri) {
        this.extUri = extUri;
    }
    resolveWebviewView(view) {
        this.view = view;
        view.title = `账号管理 v${extensionVersion()}`;
        view.webview.options = { enableScripts: true, localResourceRoots: [this.extUri] };
        view.webview.html = this.html(view.webview);
        view.webview.onDidReceiveMessage(async (msg) => this.handle(msg));
        this.postState();
    }
    postState() { const st = { type: 'state', state: clientState() }; this.view?.webview.postMessage(st); }
    post(payload) { this.view?.webview.postMessage(payload); }
    async handle(msg) {
        try {
            if (msg.type === 'ready') {
                this.postState();
                return;
            }
            if (msg.type === 'refreshAccount') {
                fetchCursorUsage();
            }
            if (msg.type === 'refreshAccounts') {
                await refreshCurrentUserId();
                await fetchCursorUsage();
            }
            if (msg.type === 'openDashboard') {
                const r = await openAccountDashboard(String(msg.id || ''));
                if (!r.ok)
                    reportOperationError('打开账号控制台', r.error || '未知错误');
            }
            if (msg.type === 'reloadWindow') {
                await vscode.commands.executeCommand('workbench.action.reloadWindow');
            }
            if (msg.type === 'restartCursor') {
                const accepted = await vscode.window.showWarningMessage(
                    '确定完整退出并重启 Cursor 吗？请先保存所有未保存的工作。',
                    { modal: true },
                    '重启 Cursor'
                );
                if (accepted !== '重启 Cursor') {
                    this.post({ type: 'restartCancelled' });
                    return;
                }
                const rr = scheduleCursorRestart();
                if (!rr.ok) {
                    const detail = reportOperationError('自动重启 Cursor', rr.error || '未知错误');
                    this.post({ type: 'restartFailed', error: detail });
                }
            }
            if (msg.type === 'accountAddCurrent') {
                const r = await addAccountFromCurrentLogin();
                if (r.ok) {
                    vscode.window.showInformationMessage('账号管理：已新增本机 Token 账号记录（未切换）');
                    fetchCursorUsage();
                }
                else
                    reportOperationError('导入当前账号', r.error || '未知错误');
                this.postState();
            }
            if (msg.type === 'accountAddToken') {
                const probe = parseCursorSessionInput(String(msg.token || ''));
                const hasRealRefresh = !!(probe.refreshToken && probe.refreshToken !== probe.accessToken);
                const isWebToken = !hasRealRefresh && probe.accessToken && tokenMetaOf(probe.accessToken).tokenType === 'web';
                if (isWebToken) {
                    const pick = await vscode.window.showWarningMessage('这是 web 网页令牌，切过去发消息可能弹登录框。可先「仅导入额度」看 Auto/Other/Bot；要可续期请用无痕浏览器注入换真令牌。', { modal: true }, '仅导入额度', '无痕浏览器注入');
                    if (pick === '无痕浏览器注入') {
                        const injUserId = normUserId(probe.userId) || normUserId(String((decodeJwtPayload(probe.accessToken) || {}).sub || '').replace(/^auth0\|/, ''));
                        const cookieValue = injUserId && probe.accessToken ? injUserId + '%3A%3A' + probe.accessToken : '';
                        const r = cookieValue ? await deepLoginViaInjectedBrowser(cookieValue) : await startCursorDeepLogin();
                        if (r.cancelled) {
                            this.postState();
                            return;
                        }
                        if (!r.ok || !r.accessToken || !r.refreshToken) {
                            reportOperationError('浏览器登录', r.error || '未获取到令牌');
                            this.postState();
                            return;
                        }
                        if (cookieValue && !isSameCursorAccount({ userId: injUserId, accessToken: probe.accessToken }, { userId: r.authId, accessToken: r.accessToken, authId: r.authId })) {
                            const loginUserId = normUserId(String((decodeJwtPayload(r.accessToken) || {}).sub || r.authId || '').replace(/^auth0\|/, ''));
                            reportOperationError('添加 Token 账号', '授权账号与粘贴的 Token 不一致（…' + loginUserId.slice(-8) + '），未添加');
                            this.postState();
                            return;
                        }
                        const add = await addAccountFromDeepLogin(r.accessToken, r.refreshToken, r.authId || '');
                        if (add.ok)
                            vscode.window.showInformationMessage('账号管理：已通过浏览器登录添加可续期账号' + (add.duplicate ? '（已更新同账号令牌）' : ''));
                        else
                            reportOperationError('添加浏览器授权账号', add.error || '未知错误');
                        this.postState();
                        return;
                    }
                    if (pick !== '仅导入额度') {
                        this.postState();
                        return;
                    }
                }
                const r = await addAccountFromToken(String(msg.token || ''));
                if (r.ok) {
                    this.postState();
                    if (r.tokenType === 'web') {
                        vscode.window.showWarningMessage('账号管理：已记录该 web 令牌账号（只能本地读取用量；切过去发消息会报鉴权）。要正常使用请改用「浏览器授权」。');
                    }
                    else {
                        vscode.window.showInformationMessage(r.error ? '账号管理：已新增可续期 token 账号记录，但读取额度失败 - ' + r.error : '账号管理：已新增可续期 token 账号记录（未切换）');
                    }
                }
                else
                    reportOperationError('添加 Token 账号', r.error || '未知错误');
            }
            if (msg.type === 'accountDeepLogin') {
                const r = await startCursorDeepLogin();
                if (r.cancelled) {
                    this.postState();
                    return;
                }
                if (!r.ok || !r.accessToken || !r.refreshToken) {
                    reportOperationError('浏览器登录', r.error || '未获取到令牌');
                    this.postState();
                    return;
                }
                const add = await addAccountFromDeepLogin(r.accessToken, r.refreshToken, r.authId || '');
                if (add.ok)
                    vscode.window.showInformationMessage('账号管理：已通过浏览器登录添加可续期账号' + (add.duplicate ? '（已更新同账号令牌）' : '') + (add.error ? '，但读取额度失败 - ' + add.error : ''));
                else
                    reportOperationError('添加浏览器授权账号', add.error || '未知错误');
                this.postState();
            }
            if (msg.type === 'accountUpgradeToken') {
                const acc = getAccounts().find(a => a.id === msg.id);
                if (!acc) {
                    reportOperationError('升级账号令牌', '未找到该账号');
                    this.postState();
                    return;
                }
                const targetUserId = normUserId(acc.userId);
                const targetAccessToken = unquote((acc.authBlob || {})['cursorAuth/accessToken'] || '');
                const cookieValue = sessionCookieValueOf(acc);
                if (!cookieValue) {
                    reportOperationError('升级账号令牌', '该账号缺少会话令牌');
                    this.postState();
                    return;
                }
                const ok = await vscode.window.showInformationMessage('将打开一个隔离浏览器并自动以 ' + (acc.email || '该账号') + ' 的身份登录 Cursor。\n若页面出现「Authorize」按钮，点一下即可；拿到可续期令牌后会替换这条账号。', { modal: true }, '开始升级');
                if (ok !== '开始升级') {
                    this.postState();
                    return;
                }
                const r = await deepLoginViaInjectedBrowser(cookieValue);
                if (r.cancelled) {
                    this.postState();
                    return;
                }
                if (!r.ok || !r.accessToken || !r.refreshToken) {
                    reportOperationError('升级账号授权', r.error || '未获取到令牌');
                    this.postState();
                    return;
                }
                const payload = decodeJwtPayload(r.accessToken) || {};
                const loginUserId = normUserId(String(payload.sub || '').replace(/^auth0\|/, ''));
                if (!isSameCursorAccount({ userId: targetUserId, accessToken: targetAccessToken, email: acc.email }, { userId: loginUserId, accessToken: r.accessToken, authId: r.authId })) {
                    reportOperationError('升级账号令牌', '授权账号与现有记录不一致（…' + loginUserId.slice(-8) + '），未升级');
                    this.postState();
                    return;
                }
                const add = await addAccountFromDeepLogin(
                    r.accessToken,
                    r.refreshToken,
                    r.authId || '',
                    {
                        replaceAccountId: acc.id,
                        expectedAccessToken: targetAccessToken,
                        source: 'upgraded'
                    }
                );
                if (!add.ok) {
                    reportOperationError('升级账号令牌', add.error || '未知错误');
                    this.postState();
                    return;
                }
                vscode.window.showInformationMessage('账号管理：已升级为可续期账号' + (add.error ? '，但读取额度失败 - ' + add.error : ''));
                this.postState();
            }
            if (msg.type === 'accountRefreshToken') {
                const r = await accountRefreshToken(String(msg.id || ''));
                if (r.ok)
                    vscode.window.showInformationMessage('账号管理：账号令牌已续期');
                else
                    reportOperationError('续期账号令牌', r.error || '未知错误', { warning: true });
                this.postState();
            }
            if (msg.type === 'accountRemove') {
                const id = String(msg.id || '');
                const account = getAccounts().find(item => item.id === id);
                const accepted = await vscode.window.showWarningMessage(
                    `确定删除账号记录 ${account && account.email || id} 吗？对应凭据将从系统安全存储删除，且无法撤销。`,
                    { modal: true },
                    '删除账号'
                );
                if (accepted !== '删除账号')
                    return;
                await removeAccount(id);
                this.postState();
            }
            if (msg.type === 'copyText') {
                const text = String(msg.text || '');
                if (text)
                    await vscode.env.clipboard.writeText(text);
            }
            if (msg.type === 'accountCopyEmail') {
                const acc = getAccounts().find(a => a.id === String(msg.id || ''));
                const email = String((acc && acc.email) || '').trim();
                if (!email || email === '(未知邮箱)')
                    vscode.window.showWarningMessage('账号管理：该账号没有邮箱可复制');
                else
                    await vscode.env.clipboard.writeText(email);
            }
            if (msg.type === 'accountCopyToken') {
                const acc = getAccounts().find(a => a.id === String(msg.id || ''));
                const token = exportAccountSession(acc);
                if (!token)
                    vscode.window.showWarningMessage('账号管理：该账号没有可复制的 token');
                else {
                    const accepted = await vscode.window.showWarningMessage(
                        '复制 Token 会将完整登录凭据放入系统剪贴板，其他应用可能读取。仅在可信环境中继续。',
                        { modal: true },
                        '复制 Token'
                    );
                    if (accepted !== '复制 Token')
                        return;
                    await vscode.env.clipboard.writeText(token);
                }
            }
            if (msg.type === 'accountExportAll') {
                const r = await exportAllAccounts();
                if (r.cancelled)
                    return;
                if (!r.ok)
                    reportOperationError('导出账号', r.error || '未知错误');
                else {
                    vscode.window.showInformationMessage('账号管理：已导出 ' + r.count + ' 个账号');
                    this.post({ type: 'toast', text: '已导出 ' + r.count + ' 个账号' });
                }
            }
            if (msg.type === 'accountImportAll') {
                const r = await pickAccountBackup();
                if (r.cancelled)
                    return;
                if (!r.ok) {
                    reportOperationError('读取账号备份', r.error || '未知错误');
                    return;
                }
                this.post({
                    type: 'importPreview',
                    fileName: r.fileName || '',
                    added: r.added,
                    updated: r.updated,
                    rows: r.rows || []
                });
            }
            if (msg.type === 'accountImportCancel') {
                pendingImportAccounts = [];
            }
            if (msg.type === 'accountImportConfirm') {
                const accepted = await vscode.window.showWarningMessage(
                    `确定把预览中的 ${pendingImportAccounts.length} 个账号写入系统安全存储吗？同一账号的现有凭据可能被更新。`,
                    { modal: true },
                    '确认导入'
                );
                if (accepted !== '确认导入')
                    return;
                const r = await commitPendingImport();
                if (r.cancelled)
                    return;
                if (!r.ok)
                    reportOperationError('导入账号', r.error || '未知错误');
                else {
                    vscode.window.showInformationMessage('账号管理：导入完成，新增 ' + r.added + '，更新 ' + r.updated);
                    this.post({ type: 'toast', text: '导入完成：新增 ' + r.added + '，更新 ' + r.updated });
                }
                this.postState();
                fetchCursorUsage();
            }
            if (msg.type === 'accountSetNote') {
                const r = await setAccountNote(String(msg.id || ''), msg.note);
                if (!r.ok)
                    reportOperationError('保存账号备注', r.error || '未知错误');
                this.postState();
            }
            if (msg.type === 'accountRefreshOne') {
                const r = await refreshAccountInfo(String(msg.id || ''));
                if (!r.ok)
                    reportOperationError('刷新账号', r.error || '未知错误', { warning: true });
                else if (r.error)
                    reportOperationError('联网读取账号用量', r.error, { warning: true });
                this.postState();
            }
            if (msg.type === 'accountSwitch') {
                const acc = getAccounts().find(a => a.id === msg.id);
                const ok = await vscode.window.showWarningMessage('确定切换 Cursor 全局登录账号到 ' + (acc && acc.email || msg.id) + ' 吗？\n这会纯净替换 Cursor 登录态（state.vscdb + storage.json，已自动备份）。写入成功后需完整重启一次 Cursor 才会生效。', { modal: true }, '切换账号');
                if (ok === '切换账号') {
                    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '正在切换 Cursor 账号…', cancellable: false }, async (progress) => {
                        progress.report({ message: '写入登录态并校验' });
                        const r = await switchCursorAccount(String(msg.id || ''));
                        if (r.ok) {
                            await refreshCurrentUserId();
                            fetchCursorUsage();
                            this.postState();
                            const swAcc2 = getAccounts().find(a => a.id === msg.id);
                            const webWarn2 = (swAcc2 && (swAcc2.tokenType === 'web' || swAcc2.noRefresh === true)) ? ' 注意：该账号为 web token，无法自动续期，Cursor 可能稍后提示重新登录，建议用「浏览器授权」重新添加。' : '';
                            this.post({
                                type: 'retryNeedsRestart',
                                message: '账号登录态已写入，完整重启一次 Cursor 即可生效。' + webWarn2,
                                action: 'accountSwitch',
                                restartCommand: 'restartCursor'
                            });
                        }
                        else
                            reportOperationError('切换账号', (r.error || '未知错误') + '；可使用“恢复最近切号”命令恢复鉴权状态');
                    });
                }
            }
            if (msg.type === 'accountSetHardLimit') {
                const mode = String(msg.mode || 'fixed');
                const limit = mode === 'fixed' ? 10000 : (typeof msg.hardLimit === 'number' ? msg.hardLimit : undefined);
                const acc = getAccounts().find(a => a.id === msg.id);
                const who = (acc && acc.email) || msg.id || '该账号';
                const closing = mode === 'disabled';
                const confirmLabel = closing ? '关闭超额' : '开启无限超额';
                const warn = closing
                    ? ('确定关闭 ' + who + ' 的超额吗？关闭后套餐额度用完就不能再超量使用。')
                    : ('确定给 ' + who + ' 开启无限超额吗？套餐额度用完后会继续按用量计费，可能产生额外费用。');
                const ok = await vscode.window.showWarningMessage(warn, { modal: true }, confirmLabel);
                if (ok !== confirmLabel)
                    return;
                const r = await setHardLimitForAccount(String(msg.id || ''), mode, limit);
                if (r.ok) {
                    vscode.window.showInformationMessage('账号管理：' + who + ' 的超额设置已提交');
                    this.postState();
                }
                else
                    reportOperationError('修改超额设置', r.error || '未知错误');
            }
            if (msg.type === 'accountListSessions') {
                const r = await listAccountSessions(String(msg.id || ''));
                const detail = r.ok
                    ? null
                    : reportOperationError('读取设备会话', r.error || '读取设备失败', { notify: false });
                this.post({ type: 'sessions', accountId: String(msg.id || ''), email: r.email || '', sessions: r.sessions || [], error: detail ? detail.message : '' });
            }
            if (msg.type === 'accountRevokeSession') {
                const account = getAccounts().find(item => item.id === String(msg.id || ''));
                const accepted = await vscode.window.showWarningMessage(
                    `确定将 ${account && account.email || '该账号'} 的这个设备会话踢下线吗？生效可能需要约 10 分钟。`,
                    { modal: true },
                    '踢下线'
                );
                if (accepted !== '踢下线') {
                    this.post({
                        type: 'sessionActionCancelled',
                        accountId: String(msg.id || '')
                    });
                    return;
                }
                const r = await revokeAccountSession(String(msg.id || ''), String(msg.sessionId || ''));
                if (!r.ok) {
                    const detail = reportOperationError('踢设备下线', r.error || '踢下线失败');
                    this.post({ type: 'sessions', accountId: String(msg.id || ''), email: '', sessions: [], error: detail.message });
                }
                else {
                    const listed = await listAccountSessions(String(msg.id || ''));
                    const detail = listed.ok
                        ? null
                        : reportOperationError('刷新设备会话', listed.error || '读取设备失败', { notify: false });
                    this.post({ type: 'sessions', accountId: String(msg.id || ''), email: listed.email || '', sessions: listed.sessions || [], error: detail ? detail.message : '', toast: '已提交踢下线，最多约 10 分钟生效' });
                    this.postState();
                }
            }
            if (msg.type === 'sandRefresh') {
                refreshSandStatusBar();
                this.postState();
            }
            if (msg.type === 'sandApply') {
                try {
                    const result = await applySandPatchFromUi();
                    if (result && result.cancelled) {
                        this.postState();
                        return;
                    }
                    if (result && result.changed === false)
                        this.post({ type: 'toast', text: 'Sand 已经是注入状态' });
                    else
                        promptSandRestart('apply');
                }
                catch (e) {
                    reportOperationError('注入 Sand', e);
                }
                this.postState();
            }
            if (msg.type === 'sandRestore') {
                try {
                    const result = await restoreSandPatchFromUi();
                    if (result && result.cancelled) {
                        this.postState();
                        return;
                    }
                    promptSandRestart('restore');
                }
                catch (e) {
                    reportOperationError('卸载 Sand', e);
                }
                this.postState();
            }
        }
        catch (e) {
            reportOperationError(
                WEBVIEW_OPERATION_LABELS[String(msg && msg.type || '')] || '处理面板请求',
                e
            );
            this.postState();
        }
    }
    html(webview) {
        const nonce = Math.random().toString(36).slice(2);
        const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extUri, 'media', 'webview.css'));
        const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extUri, 'media', 'webview.js'));
        const csp = [
            "default-src 'none'",
            `img-src ${webview.cspSource} data:`,
            `style-src ${webview.cspSource} 'unsafe-inline'`,
            `font-src ${webview.cspSource}`,
            `script-src 'nonce-${nonce}' ${webview.cspSource}`
        ].join('; ');
        return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="${cssUri}"><title>账号管理</title></head><body><div id="app"></div><script nonce="${nonce}" src="${jsUri}"></script></body></html>`;
    }
}

function accountUsageEnabled() {
    return !!networkPolicy && networkPolicy.mode !== MODES.OFF;
}
function cursorGlobalStorageDir() {
    try {
        if (extensionContext?.globalStorageUri?.fsPath)
            return path.dirname(extensionContext.globalStorageUri.fsPath);
    }
    catch { }
    const home = os.homedir();
    if (process.platform === 'win32')
        return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Cursor', 'User', 'globalStorage');
    if (process.platform === 'darwin')
        return path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage');
    return path.join(home, '.config', 'Cursor', 'User', 'globalStorage');
}
function findCursorExecutable() {
    try {
        const appRoot = vscode.env.appRoot;
        if (appRoot) {
            if (process.platform === 'darwin') {
                const idx = String(appRoot).indexOf('.app/');
                if (idx > 0)
                    return String(appRoot).slice(0, idx + 4);
            }
            if (process.platform === 'win32') {
                const exe = path.join(path.dirname(path.dirname(appRoot)), 'Cursor.exe');
                if (fs.existsSync(exe))
                    return exe;
            }
        }
    }
    catch { }
    try {
        let cur = process.execPath;
        for (let i = 0; i < 10 && cur && cur !== path.dirname(cur); i++) {
            const base = path.basename(cur);
            if (process.platform === 'darwin' && base === 'Cursor.app')
                return cur;
            if (process.platform === 'win32' && /^cursor\.exe$/i.test(base) && !/helper/i.test(cur))
                return cur;
            cur = path.dirname(cur);
        }
    }
    catch { }
    if (process.platform === 'win32') {
        const roots = [
            path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Cursor', 'Cursor.exe'),
            path.join(process.env.ProgramFiles || '', 'Cursor', 'Cursor.exe'),
            path.join(process.env['ProgramFiles(x86)'] || '', 'Cursor', 'Cursor.exe')
        ];
        return roots.find(p => p && fs.existsSync(p)) || 'Cursor.exe';
    }
    if (process.platform === 'darwin')
        return '/Applications/Cursor.app';
    return 'cursor';
}
function findCursorCli() {
    const dirs = [];
    try {
        if (vscode.env.appRoot)
            dirs.push(path.join(vscode.env.appRoot, 'bin'));
    }
    catch { }
    try {
        dirs.push(path.join(path.dirname(process.execPath), 'bin'));
    }
    catch { }
    try {
        const app = findCursorExecutable();
        if (process.platform === 'win32')
            dirs.push(path.join(path.dirname(app), 'bin'));
        else if (process.platform === 'darwin')
            dirs.push(path.join(app, 'Contents', 'Resources', 'app', 'bin'));
    }
    catch { }
    for (const dir of dirs) {
        try {
            if (!dir || !fs.existsSync(dir))
                continue;
            let files = fs.readdirSync(dir).filter(f => !String(f).includes('-tunnel'));
            if (process.platform === 'win32')
                files = files.filter(f => /\.cmd$/i.test(f) && /cursor/i.test(f));
            else
                files = files.filter(f => /cursor/i.test(f) && !String(f).includes('.'));
            if (files.length)
                return path.join(dir, files[0]);
        }
        catch { }
    }
    return findCursorExecutable();
}
function readAppNameLong() {
    try {
        const p = path.join(vscode.env.appRoot, 'product.json');
        const j = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (j && j.nameLong)
            return String(j.nameLong);
    }
    catch { }
    return 'Cursor';
}
// 对齐 vscode-custom-ui-style / zokugun vscode-sync-settings：异步 spawn + detached，禁止 spawnSync（Windows 会 ETIMEDOUT）。
function scheduleCursorRestart() {
    if (restartScheduled)
        return { ok: true };
    try {
        let child;
        if (process.platform === 'win32')
            child = restartWindows();
        else if (process.platform === 'darwin')
            child = restartMacOS();
        else
            child = restartLinux();
        child.on('error', (err) => {
            restartScheduled = false;
            const detail = reportOperationError('自动重启 Cursor', err);
            provider?.post({ type: 'restartFailed', error: detail });
        });
        child.unref();
        restartScheduled = true;
        return { ok: true };
    }
    catch (e) {
        restartScheduled = false;
        return { ok: false, error: String(e && e.message || e) };
    }
}
function restartWindows() {
    const binary = findCursorCli();
    const checkScript = [
        'for ($i = 0; $i -lt 100; $i++) {',
        "    $p = Get-Process 'Cursor' -ErrorAction SilentlyContinue;",
        '    if ($p -eq $null) { exit }',
        '    Start-Sleep -Milliseconds 100',
        '}'
    ].join(' ');
    const batchScript = 'taskkill /F /IM "Cursor.exe" >nul 2>&1 & powershell -NoProfile -Command "' + checkScript + '" & "' + binary + '"';
    return (0, child_process_1.spawn)(process.env.ComSpec || 'cmd.exe', ['/C ' + batchScript], {
        detached: true,
        stdio: 'ignore',
        windowsVerbatimArguments: true
    });
}
function restartMacOS() {
    const nameLong = readAppNameLong();
    const binary = findCursorCli();
    return (0, child_process_1.spawn)('osascript', [
        '-e', 'quit app "' + nameLong + '"',
        '-e', 'repeat with i from 1 to 100',
        '-e', 'if not (application "' + nameLong + '" is running) then exit repeat',
        '-e', 'delay 0.1',
        '-e', 'end repeat',
        '-e', 'do shell script quoted form of "' + binary.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
    ], { detached: true, stdio: 'ignore' });
}
function restartLinux() {
    const binary = findCursorCli();
    const pid = Number(process.env.VSCODE_PID || process.env.CURSOR_PID || 0);
    if (!Number.isInteger(pid) || pid <= 0)
        throw new Error('无法确定 Cursor 主进程，请自己完全退出再打开');
    return (0, child_process_1.spawn)('/bin/sh', ['-c', 'kill "' + pid + '" 2>/dev/null || exit 1; c=0; while kill -0 "' + pid + '" 2>/dev/null && [ $c -lt 100 ]; do sleep 0.1; c=$((c+1)); done; ' + JSON.stringify(binary)], { detached: true, stdio: 'ignore' });
}
function loadCursorSqlite() {
    if (sqliteModuleCache !== undefined)
        return sqliteModuleCache;
    sqliteModuleCache = null;
    const roots = [];
    try {
        if (vscode.env.appRoot)
            roots.push(vscode.env.appRoot);
    }
    catch { }
    try {
        roots.push(path.join(path.dirname(process.execPath), 'resources', 'app'));
    }
    catch { }
    const rels = [
        ['node_modules', '@vscode', 'sqlite3'],
        ['node_modules.asar.unpacked', '@vscode', 'sqlite3'],
        ['node_modules', 'better-sqlite3'],
        ['node_modules.asar.unpacked', 'better-sqlite3'],
        ['node_modules', 'sqlite3'],
        ['node_modules', 'vscode-sqlite3']
    ];
    for (const root of roots) {
        for (const rel of rels) {
            const p = path.join(root, ...rel);
            try {
                if (!fs.existsSync(p))
                    continue;
                const mod = require(p);
                sqliteModuleCache = { mod, kind: rel.includes('better-sqlite3') ? 'better' : 'sqlite3' };
                return sqliteModuleCache;
            }
            catch { }
        }
    }
    return sqliteModuleCache;
}
async function querySqliteLike(dbPath, pattern) {
    const loaded = loadCursorSqlite();
    if (!loaded)
        return null;
    try {
        if (loaded.kind === 'better') {
            const Database = (loaded.mod.default || loaded.mod);
            const db = new Database(dbPath, { readonly: true, fileMustExist: true });
            try {
                const rows = db.prepare('SELECT key, value FROM ItemTable WHERE key LIKE ?').all(pattern);
                const out = {};
                for (const r of rows) {
                    if (r && r.value != null)
                        out[r.key] = Buffer.isBuffer(r.value) ? r.value.toString('utf8') : String(r.value);
                }
                return out;
            }
            finally {
                try {
                    db.close();
                }
                catch { }
            }
        }
        const sqlite3 = (loaded.mod.verbose ? loaded.mod.verbose() : loaded.mod);
        const Database = sqlite3.Database || (sqlite3.default && sqlite3.default.Database);
        if (!Database)
            return null;
        const READONLY = sqlite3.OPEN_READONLY != null ? sqlite3.OPEN_READONLY : 1;
        return await new Promise(resolve => {
            const db = new Database(dbPath, READONLY, (e) => { if (e)
                resolve(null); });
            db.all('SELECT key, value FROM ItemTable WHERE key LIKE ?', [pattern], (err, rows) => {
                const out = {};
                if (!err && Array.isArray(rows))
                    for (const r of rows) {
                        if (r && r.value != null)
                            out[r.key] = Buffer.isBuffer(r.value) ? r.value.toString('utf8') : String(r.value);
                    }
                try {
                    db.close();
                }
                catch { }
                resolve(err ? null : out);
            });
        });
    }
    catch {
        return null;
    }
}
function readCursorAuthFromStorageJson(dir) {
    try {
        const obj = JSON.parse(fs.readFileSync(path.join(dir, 'storage.json'), 'utf8'));
        const accessToken = String(obj['cursorAuth/accessToken'] || '').trim();
        if (!accessToken)
            return null;
        let email = String(obj['cursorAuth/cachedEmail'] || '').trim();
        if (!email) {
            try {
                email = JSON.parse(obj['cursorAuth/user'] || '{}').email || '';
            }
            catch { }
        }
        return { accessToken, userId: String(obj['cursorAuth/userId'] || '').trim(), email };
    }
    catch {
        return null;
    }
}
async function readCursorAuthFromVscdb(dir) {
    const dbPath = path.join(dir, 'state.vscdb');
    if (!fs.existsSync(dbPath))
        return null;
    const rows = await querySqliteLike(dbPath, 'cursorAuth/%');
    if (!rows)
        return null;
    const accessToken = unquote(rows['cursorAuth/accessToken'] || '').trim();
    if (!accessToken)
        return null;
    let email = normEmail(rows['cursorAuth/cachedEmail'] || rows['cursorAuth/email'] || '');
    if (!email) {
        try {
            email = normEmail(JSON.parse(rows['cursorAuth/user'] || '{}').email || '');
        }
        catch { }
    }
    const userId = normUserId(rows['cursorAuth/userId'] || rows['cursorAuth/cachedUserId'] || '');
    return { accessToken, userId, email };
}
async function readCursorAuth() {
    const manual = accountRepository ? String(await accountRepository.getManualToken() || '').trim() : '';
    if (manual) {
        const parsed = parseCursorSessionInput(manual);
        if (parsed.accessToken)
            return {
                accessToken: parsed.accessToken,
                refreshToken: parsed.refreshToken,
                userId: parsed.userId,
                email: ''
            };
    }
    const dir = cursorGlobalStorageDir();
    try {
        const a = await readCursorAuthFromVscdb(dir);
        if (a)
            return a;
    }
    catch { }
    return readCursorAuthFromStorageJson(dir);
}
function networkFailureResult(error) {
    const code = String(error && error.code || '');
    const status = code === 'ERR_TIMEOUT'
        ? -1
        : (code === 'ERR_NETWORK_OFF' || code === 'ERR_AUTOMATIC_DISABLED' ||
            code === 'ERR_POLICY_CHANGED' || code === 'ERR_POLICY_DISPOSED' ? -2 : 0);
    return {
        status,
        json: null,
        raw: '',
        error: error && error.message ? error.message : '网络请求失败',
        code
    };
}
async function cursorApi(method, pathname, cookie, body, timeoutMs = 8000, intent = 'manual') {
    return cursorApiHost(method, 'cursor.com', pathname, {
        Cookie: cookie,
        'User-Agent': UA,
        Accept: 'application/json',
        Origin: 'https://cursor.com',
        Referer: 'https://cursor.com/dashboard'
    }, body, timeoutMs, intent);
}
function buildCookie(auth) {
    return 'WorkosCursorSessionToken=' + encodeURIComponent(auth.userId) + '%3A%3A' + auth.accessToken;
}
function parseCursorSessionInput(input) {
    let raw = String(input || '').trim();
    if (!raw)
        return { userId: '', accessToken: '', refreshToken: '', rawSession: '' };
    const cookieMatch = /(?:^|[;\s])WorkosCursorSessionToken=([^;\s]+)/i.exec(raw);
    if (cookieMatch)
        raw = cookieMatch[1].trim();
    raw = raw.replace(/^["']|["']$/g, '').trim();
    try {
        raw = decodeURIComponent(raw);
    }
    catch { }
    raw = raw.replace(/%3A%3A/gi, '::');
    // 支持 userId::accessToken::refreshToken（带真 refreshToken 的可续期账号），也兼容旧的 userId::accessToken 和纯 token。
    const segs = raw.split('::').map(s => s.trim());
    let userId = '', accessToken = raw, refreshToken = '';
    if (segs.length >= 3) {
        userId = segs[0];
        accessToken = segs[1];
        refreshToken = segs.slice(2).join('::').trim();
    }
    else if (segs.length === 2) {
        userId = segs[0];
        accessToken = segs[1];
    }
    return { userId: normUserId(userId), accessToken: accessToken.trim(), refreshToken, rawSession: userId && accessToken ? (userId + '::' + accessToken) : raw };
}
async function cursorApiHost(method, host, pathname, headers, body, timeoutMs = 8000, intent = 'manual') {
    if (!cursorHttpClient)
        return networkFailureResult(new Error('安全网络客户端尚未初始化'));
    try {
        return await cursorHttpClient.request({
            host,
            method,
            path: pathname,
            headers,
            body,
            timeoutMs,
            intent
        });
    }
    catch (error) {
        return networkFailureResult(error);
    }
}
function cursorBearerUsage(accessToken, intent = 'manual') {
    return cursorApiHost('GET', 'api2.cursor.sh', '/auth/usage-summary', {
        Authorization: 'Bearer ' + accessToken,
        Accept: 'application/json',
        'User-Agent': UA
    }, undefined, 8000, intent);
}
// Cursor 桌面端登录用的固定 OAuth client_id（与八戒一致）；提为配置项，便于 Cursor 改 id 时不重打包。
function cursorOAuthClientId() {
    const v = String(cfgGetMachine('cursorOAuthClientId') || '').trim();
    return v || 'KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB';
}
// 用真 refreshToken 走 Cursor 官方续期换新 accessToken。web/cookie token 不是合法 refresh_token，会拿到 shouldLogout。
async function refreshCursorAccessToken(refreshToken, accountId = 'shared', intent = 'manual') {
    const rt = String(refreshToken || '').trim();
    if (!rt)
        return { ok: false, error: 'empty_refresh_token' };
    if (!cursorOAuth)
        return { ok: false, error: '安全 OAuth 客户端尚未初始化' };
    return cursorOAuth.refresh({
        accountId,
        refreshToken: rt,
        clientId: cursorOAuthClientId(),
        intent,
        timeoutMs: 15000
    });
}
// 轮询深度登录结果：用户在浏览器登录后，api2 用 uuid+verifier 换回真 client token 对。
async function pollCursorDeepLogin(uuid, verifier, signal) {
    if (!cursorOAuth)
        return null;
    const result = await cursorOAuth.pollDeepLogin({
        uuid,
        verifier,
        intent: 'manual',
        signal,
        timeoutMs: 15000
    });
    return result;
}
// 浏览器深度登录（PKCE）：开 cursor.com/loginDeepControl，用户登录后轮询 /auth/poll 拿真 token 对。
async function startCursorDeepLogin() {
    try {
        networkPolicy.assertAllowed({ host: 'cursor.com', intent: 'manual' });
    }
    catch (error) {
        return { ok: false, error: error.message };
    }
    const { loginUrl, uuid, verifier } = buildDeepLoginUrl();
    const pick = await vscode.window.showInformationMessage('账号管理：将打开浏览器登录 Cursor 以获取可自动续期的账号令牌。登录完成后回到这里，插件会自动捕获。', { modal: true }, '打开浏览器', '复制登录链接');
    if (pick === '复制登录链接') {
        await vscode.env.clipboard.writeText(loginUrl);
        vscode.window.showInformationMessage('登录链接已复制，请在浏览器中打开并完成 Cursor 登录。');
    }
    else if (pick === '打开浏览器') {
        try {
            networkPolicy.assertAllowed({ host: 'cursor.com', intent: 'manual' });
        }
        catch (error) {
            return { ok: false, error: error.message };
        }
        await vscode.env.openExternal(vscode.Uri.parse(loginUrl));
    }
    else {
        return { ok: false, cancelled: true };
    }
    return await pollDeepLoginWithProgress(uuid, verifier, '已打开浏览器，请完成 Cursor 登录…');
}
// 生成一次性 PKCE 登录链接（verifier/challenge/uuid）。
function buildDeepLoginUrl() {
    if (!cursorOAuth)
        throw new Error('安全 OAuth 客户端尚未初始化');
    return cursorOAuth.buildDeepLoginUrl();
}
// 共享轮询核心：带进度条、可取消，最多 ~150×2s 轮询 /auth/poll，拿到真 token 对即返回。
async function pollDeepLoginWithProgress(uuid, verifier, startMsg, onTick, externalSignal) {
    return await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Cursor 登录', cancellable: true }, async (progress, token) => {
        const controller = new AbortController();
        const cancellation = token.onCancellationRequested(() => controller.abort());
        const cancelFromPolicy = () => controller.abort(externalSignal && externalSignal.reason);
        if (externalSignal)
            externalSignal.addEventListener('abort', cancelFromPolicy, { once: true });
        if (externalSignal && externalSignal.aborted)
            cancelFromPolicy();
        progress.report({ message: startMsg });
        try {
            for (let i = 0; i < 150; i++) {
                if (token.isCancellationRequested)
                    return { ok: false, cancelled: true };
                const got = await pollCursorDeepLogin(uuid, verifier, controller.signal);
                if (got && got.ok)
                    return { ok: true, accessToken: got.accessToken, refreshToken: got.refreshToken, authId: got.authId };
                if (got && got.cancelled)
                    return { ok: false, cancelled: true };
                if (got && !got.pending && !got.retryable)
                    return { ok: false, error: got.error || '登录轮询失败' };
                if (i > 0 && i % 15 === 0)
                    progress.report({ message: '等待登录中…（' + Math.round(2 * i) + 's）' });
                await new Promise(resolve => {
                    const finish = () => {
                        clearTimeout(timer);
                        controller.signal.removeEventListener('abort', finish);
                        resolve();
                    };
                    const timer = setTimeout(finish, 2000);
                    controller.signal.addEventListener('abort', finish, { once: true });
                });
            }
            return { ok: false, error: '登录超时（5 分钟未完成），请重试' };
        }
        finally {
            cancellation.dispose();
            if (externalSignal)
                externalSignal.removeEventListener('abort', cancelFromPolicy);
        }
    });
}
// 隔离浏览器升级：起临时无痕浏览器、注入指定账号的会话 cookie、打开授权页，再走共享轮询拿真 token 对。
async function deepLoginViaInjectedBrowser(cookieValue) {
    const { loginUrl, uuid, verifier } = buildDeepLoginUrl();
    let policyHandle;
    try {
        policyHandle = networkPolicy.beginRequest({
            host: 'cursor.com',
            intent: 'manual'
        });
    }
    catch (error) {
        return { ok: false, error: error.message };
    }
    try {
        const launched = await (0, cdpBrowser_1.launchInjectedBrowser)({
            cookieValue,
            loginUrl,
            signal: policyHandle.signal,
            stateRoot: extensionContext?.globalStorageUri?.fsPath
        });
        if (!launched.ok)
            return {
                ok: false,
                cancelled: launched.cancelled === true,
                error: launched.error || '启动隔离浏览器失败'
            };
        try {
            return await pollDeepLoginWithProgress(
                uuid,
                verifier,
                '已在隔离浏览器打开授权页，若出现「Authorize」请点一下…',
                undefined,
                policyHandle.signal
            );
        }
        finally {
            try {
                await launched.close();
            }
            catch (error) {
                reportOperationError('关闭隔离浏览器', error, { notify: false });
            }
        }
    }
    finally {
        policyHandle.finish();
    }
}
function exportAccountRecord(acc) {
    if (!acc)
        return null;
    const blob = acc.authBlob || {};
    const accessToken = unquote(blob['cursorAuth/accessToken'] || '');
    const userId = normUserId(acc.userId || blob['cursorAuth/userId'] || '');
    const rawRefresh = unquote(acc.refreshToken || blob['cursorAuth/refreshToken'] || '');
    const refreshToken = (rawRefresh && rawRefresh !== accessToken) ? rawRefresh : '';
    if (!accessToken)
        return null;
    return {
        email: acc.email || '',
        userId,
        note: normalizeNote(acc.note),
        type: acc.type || '',
        tokenType: acc.tokenType || (refreshToken ? 'client' : 'web'),
        source: acc.source || '',
        addedAt: acc.addedAt || '',
        accessToken,
        refreshToken,
        accessTokenExp: typeof acc.accessTokenExp === 'number' ? acc.accessTokenExp : 0,
        noRefresh: !refreshToken,
        partial: !!(!refreshToken || acc.partial)
    };
}
function parseAccountBackup(raw) {
    let data;
    try {
        data = JSON.parse(String(raw || ''));
    }
    catch {
        return { ok: false, error: '不是合法 JSON' };
    }
    let items = [];
    if (Array.isArray(data))
        items = data;
    else if (data && Array.isArray(data.accounts))
        items = data.accounts;
    else if (data && (data.accessToken || data.token || data.session || data.email))
        items = [data];
    else
        return { ok: false, error: 'JSON 里没有 accounts 数组' };
    return { ok: true, items };
}
function accountFromBackupItem(item) {
    if (!item || typeof item !== 'object')
        return null;
    let accessToken = unquote(item.accessToken || '');
    let userId = normUserId(item.userId || '');
    let refreshToken = unquote(item.refreshToken || '');
    const packed = String(item.token || item.session || item.raw || '').trim();
    if ((!accessToken || !userId) && packed) {
        const parsed = parseCursorSessionInput(packed);
        userId = userId || parsed.userId;
        accessToken = accessToken || parsed.accessToken;
        if (!refreshToken && parsed.refreshToken && parsed.refreshToken !== parsed.accessToken)
            refreshToken = parsed.refreshToken;
    }
    if (!accessToken)
        return null;
    const email = normEmail(item.email || '');
    const realRefresh = refreshToken && refreshToken !== accessToken ? refreshToken : '';
    const sess = userId ? (userId + '%3A%3A' + accessToken) : accessToken;
    const blob = {
        'cursorAuth/accessToken': accessToken,
        'cursorAuth/userId': userId,
        'cursorAuth/cachedUserId': userId,
        'cursorAuth/authId': userId,
        'cursorAuth/workosCursorSessionToken': sess,
        'cursorAuth/cachedWorkosSessionToken': sess,
        'cursorAuth/isLoggedIn': 'true',
        'cursorAuth/isAuthenticated': 'true',
        'cursorAuth/isAuthorized': 'true'
    };
    if (realRefresh)
        blob['cursorAuth/refreshToken'] = realRefresh;
    if (email) {
        blob['cursorAuth/cachedEmail'] = email;
        blob['cursorAuth/email'] = email;
        blob['cursorAuth/user'] = JSON.stringify({ email, id: userId, sub: userId });
    }
    if (item.type)
        blob['cursorAuth/stripeMembershipType'] = String(item.type);
    const acc = makeAccountFromBlob(blob, { email, userId });
    acc.note = normalizeNote(item.note);
    acc.tokenType = item.tokenType || (realRefresh ? 'client' : 'web');
    acc.noRefresh = !realRefresh || item.noRefresh === true;
    acc.partial = !realRefresh || item.partial === true;
    acc.refreshToken = realRefresh;
    acc.source = item.source || 'import';
    acc.type = item.type || acc.type || '';
    acc.accessTokenExp = typeof item.accessTokenExp === 'number' ? item.accessTokenExp : tokenMetaOf(accessToken).accessTokenExp;
    if (item.addedAt)
        acc.addedAt = String(item.addedAt);
    if (email)
        acc.email = email;
    if (userId)
        acc.userId = userId;
    return acc;
}
async function exportAllAccounts() {
    const accounts = getAccounts();
    const records = accounts.map(exportAccountRecord).filter(Boolean);
    if (!records.length)
        return { ok: false, error: '没有可导出的账号' };
    if (records.length !== accounts.length) {
        return {
            ok: false,
            error: `${accounts.length - records.length} 个账号的安全凭据不可用；为避免生成不完整备份，已取消导出`
        };
    }
    const password = await vscode.window.showInputBox({
        title: '设置账号备份密码',
        prompt: '备份将使用 scrypt + AES-256-GCM 加密；密码至少 10 个字符',
        password: true,
        ignoreFocusOut: true,
        validateInput: value => value.length >= 10 ? undefined : '密码至少需要 10 个字符'
    });
    if (password === undefined)
        return { ok: false, cancelled: true };
    const confirmation = await vscode.window.showInputBox({
        title: '确认账号备份密码',
        prompt: '再次输入相同密码。密码无法找回。',
        password: true,
        ignoreFocusOut: true,
        validateInput: value => value === password ? undefined : '两次输入的密码不一致'
    });
    if (confirmation === undefined)
        return { ok: false, cancelled: true };
    if (confirmation !== password)
        return { ok: false, error: '两次输入的密码不一致' };
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(path.join(os.homedir(), 'Desktop', 'cursor-accounts-' + stamp + '.cam.json')),
        filters: { JSON: ['json'] },
        saveLabel: '保存加密账号备份'
    });
    if (!uri)
        return { ok: false, cancelled: true };
    const payload = {
        kind: 'cursor-account-manager',
        version: 2,
        exportedAt: now(),
        accounts: records
    };
    try {
        const encrypted = await accountBackup.encryptBackup(payload, password);
        await accountBackup.writeFileAtomic(uri.fsPath, encrypted);
    }
    catch (e) {
        return { ok: false, error: (e && e.message) || '写文件失败' };
    }
    return { ok: true, count: records.length, file: uri.fsPath };
}
function importPreviewRows(accs) {
    const existing = getAccounts();
    let added = 0, updated = 0, conflicts = 0;
    const rows = accs.map(acc => {
        const match = findAccountMatch(existing, acc);
        if (match.conflict)
            conflicts++;
        else if (match.index >= 0)
            updated++;
        else
            added++;
        return {
            email: acc.email || '(未知邮箱)',
            userTail: String(acc.userId || '').slice(-8),
            note: normalizeNote(acc.note),
            tokenType: acc.tokenType || (acc.refreshToken ? 'client' : 'web'),
            action: match.conflict ? 'conflict' : (match.index >= 0 ? 'update' : 'add')
        };
    });
    return { rows, added, updated, conflicts };
}
async function pickAccountBackup() {
    const picked = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { JSON: ['json'] },
        title: '选择账号备份 JSON',
        openLabel: '预览导入'
    });
    if (!picked || !picked[0])
        return { ok: false, cancelled: true };
    let raw = '';
    try {
        const stat = fs.statSync(picked[0].fsPath);
        if (!stat.isFile() || stat.size > accountBackup.BACKUP_LIMITS.maxFileBytes)
            return { ok: false, error: '备份文件不是普通文件或大小超限' };
        raw = fs.readFileSync(picked[0].fsPath, 'utf8');
    }
    catch (e) {
        return { ok: false, error: (e && e.message) || '读文件失败' };
    }
    let root;
    try {
        root = JSON.parse(raw);
    }
    catch {
        return { ok: false, error: '不是合法 JSON' };
    }
    let password = '';
    if (accountBackup.isEncryptedBackup(root)) {
        const entered = await vscode.window.showInputBox({
            title: '解密账号备份',
            prompt: '输入导出时设置的备份密码',
            password: true,
            ignoreFocusOut: true
        });
        if (entered === undefined)
            return { ok: false, cancelled: true };
        password = entered;
    }
    else {
        const choice = await vscode.window.showWarningMessage(
            '这是旧版明文账号备份，文件中的 Token 未加密。导入后会迁移到系统安全存储。',
            { modal: true },
            '继续导入'
        );
        if (choice !== '继续导入')
            return { ok: false, cancelled: true };
    }
    let payload;
    try {
        payload = await accountBackup.decryptBackup(raw, password);
    }
    catch (error) {
        return { ok: false, error: error && error.message || '备份解密失败' };
    }
    const parsed = parseAccountBackup(JSON.stringify(payload));
    if (!parsed.ok)
        return parsed;
    const accs = parsed.items.map(accountFromBackupItem).filter(Boolean);
    if (!accs.length)
        return { ok: false, error: '文件里没有可用的账号 token' };
    pendingImportAccounts = accs;
    const preview = importPreviewRows(accs);
    return {
        ok: true,
        fileName: path.basename(picked[0].fsPath),
        added: preview.added,
        updated: preview.updated,
        conflicts: preview.conflicts,
        rows: preview.rows
    };
}
async function commitPendingImport() {
    const accs = pendingImportAccounts.slice();
    pendingImportAccounts = [];
    if (!accs.length)
        return { ok: false, error: '没有待导入的账号，请重新选择文件' };
    let added = 0, updated = 0;
    try {
        await mutateAccounts('导入账号', list => {
            for (const acc of accs) {
                const match = findAccountMatch(list, acc);
                if (match.conflict)
                    throw new Error('存在邮箱相同但 userId 冲突的账号，未写入任何数据');
                if (match.index >= 0) {
                    const previous = list[match.index];
                    acc.id = previous.id;
                    list[match.index] = {
                        ...previous,
                        ...acc,
                        id: previous.id,
                        addedAt: previous.addedAt || acc.addedAt,
                        note: normalizeNote(acc.note != null ? acc.note : previous.note)
                    };
                    updated++;
                }
                else {
                    list.push(acc);
                    added++;
                }
            }
            return list;
        });
    }
    catch (error) {
        if (error && error.message === '存在邮箱相同但 userId 冲突的账号，未写入任何数据')
            return { ok: false, error: error.message };
        throw error;
    }
    return { ok: true, added, updated, total: accs.length };
}
function exportAccountSession(acc) {
    if (!acc)
        return '';
    const blob = acc.authBlob || {};
    const accessToken = unquote(blob['cursorAuth/accessToken'] || '');
    const userId = normUserId(acc.userId || blob['cursorAuth/userId'] || '');
    const refreshToken = unquote(acc.refreshToken || blob['cursorAuth/refreshToken'] || '');
    if (userId && accessToken && refreshToken && refreshToken !== accessToken)
        return userId + '::' + accessToken + '::' + refreshToken;
    if (userId && accessToken)
        return userId + '::' + accessToken;
    return accessToken || '';
}
function sessionCookieValueOf(acc) {
    if (!acc)
        return '';
    const blob = (acc.authBlob || {});
    let cookieValue = unquote(blob['cursorAuth/cachedWorkosSessionToken'] || blob['cursorAuth/workosCursorSessionToken'] || '');
    if (!cookieValue) {
        const at = unquote(blob['cursorAuth/accessToken'] || '');
        const uid = normUserId(acc.userId || blob['cursorAuth/userId'] || '');
        if (uid && at)
            cookieValue = uid + '%3A%3A' + at;
    }
    return cookieValue;
}
// 进控制台：隔离浏览器 + 注入该账号 cookie，打开 spending，浏览器留给用户关。
async function openAccountDashboard(id) {
    let policyHandle;
    try {
        policyHandle = networkPolicy.beginRequest({
            host: 'cursor.com',
            intent: 'manual'
        });
    }
    catch (error) {
        return { ok: false, error: error.message };
    }
    try {
        const list = getAccounts();
        const acc = (id && list.find(a => a.id === id)) || list.find(a => a.id === resolveCurrentAccountId()) || null;
        let cookieValue = sessionCookieValueOf(acc);
        if (!cookieValue) {
            const auth = await readCursorAuth();
            if (auth && auth.userId && auth.accessToken)
                cookieValue = normUserId(auth.userId) + '%3A%3A' + auth.accessToken;
        }
        if (!cookieValue)
            return { ok: false, error: '该账号缺少会话令牌，无法注入浏览器' };
        const launched = await (0, cdpBrowser_1.launchInjectedBrowser)({
            cookieValue,
            signal: policyHandle.signal,
            startUrl: 'https://cursor.com/dashboard/spending',
            keepOpen: true,
            stateRoot: extensionContext?.globalStorageUri?.fsPath
        });
        if (!launched.ok)
            return { ok: false, error: launched.error || '启动隔离浏览器失败' };
        const heldPolicy = policyHandle;
        policyHandle = null;
        launched.closed.finally(() => heldPolicy.finish());
        return { ok: true };
    }
    finally {
        if (policyHandle)
            policyHandle.finish();
    }
}
function cursorHardLimitBody(mode, limitDollars) {
    if (mode === 'disabled')
        return {
            hardLimit: 0,
            noUsageBasedAllowed: true,
            preserveHardLimitPerUser: false,
            perUserMonthlyLimitDollars: 0,
            clearPerUserMonthlyLimitDollars: false,
            isDynamicTeamLimit: false,
            clearConflictingPolicy: false
        };
    if (mode === 'unlimited')
        return {
            isUnlimited: true,
            hardLimit: 10000,
            noUsageBasedAllowed: false,
            preserveHardLimitPerUser: false,
            perUserMonthlyLimitDollars: 0,
            clearPerUserMonthlyLimitDollars: false,
            isDynamicTeamLimit: false,
            clearConflictingPolicy: false
        };
    const n = Math.min(10000, Math.max(1, Math.floor(typeof limitDollars === 'number' && limitDollars > 0 ? limitDollars : 100)));
    return {
        hardLimit: n,
        hardLimitPerUser: n,
        noUsageBasedAllowed: false,
        preserveHardLimitPerUser: false,
        perUserMonthlyLimitDollars: 0,
        clearPerUserMonthlyLimitDollars: false,
        isDynamicTeamLimit: false,
        clearConflictingPolicy: false
    };
}
function planLabelOf(plan) {
    const p = String(plan || '').toLowerCase();
    if (!p)
        return '';
    if (p.includes('free'))
        return 'Free';
    if (p.includes('ultra'))
        return 'Ultra';
    if (p.includes('pro'))
        return 'Pro';
    if (p.includes('business') || p.includes('team') || p.includes('enterprise'))
        return 'Business';
    return plan;
}
async function fetchCursorUsage(intent = 'manual') {
    if (!accountUsageEnabled() || accountLoading)
        return;
    try {
        networkPolicy.assertAllowed({ host: 'cursor.com', intent });
    }
    catch (error) {
        if (intent === 'automatic')
            return;
        accountUsage = { error: error.message, fetchedAt: Date.now(), source: 'policy' };
        provider?.postState();
        return;
    }
    accountLoading = true;
    provider?.postState();
    try {
        const auth = await readCursorAuth();
        if (!auth || !auth.accessToken) {
            accountUsage = { error: '未读取到 Cursor 登录态（设置→关于 可填手动 token）', fetchedAt: Date.now(), source: 'none' };
            return;
        }
        const cookie = buildCookie(auth);
        const [planInfo, usage, stripe, me, hard, period, sand] = await Promise.all([
            cursorApi('POST', '/api/dashboard/get-plan-info', cookie, '{}', 8000, intent),
            cursorApi('GET', '/api/usage-summary', cookie, undefined, 8000, intent),
            cursorApi('GET', '/api/auth/stripe', cookie, undefined, 8000, intent),
            cursorApi('GET', '/api/auth/me', cookie, undefined, 8000, intent),
            cursorApi('POST', '/api/dashboard/get-hard-limit', cookie, '{}', 8000, intent),
            cursorApi('POST', '/api/dashboard/get-current-period-usage', cookie, '{}', 8000, intent),
            cursorApi('POST', '/api/dashboard/get-sand-usage-status', cookie, '{}', 8000, intent)
        ]);
        const probes = [planInfo, usage, stripe, me];
        if (!probes.some(r => r.status === 200 && r.json)) {
            const codes = probes.map(r => r.status);
            const diag = codes.includes(401) || codes.includes(403) ? '登录态无效(401/403)，请重新登录 Cursor 或填手动 token'
                : codes.every(c => c === -1) ? '请求超时（网络慢或无法访问 cursor.com）'
                    : codes.every(c => c === 0) ? '网络错误（连不上 cursor.com）'
                        : '返回异常(' + codes.join('/') + ')';
            accountUsage = { email: auth.email, error: 'cursor.com ' + diag, fetchedAt: Date.now(), source: 'cursor.com' };
            return;
        }
        const email = (me.json && me.json.email) || auth.email || '';
        const plan = (stripe.json && stripe.json.membershipType) || (planInfo.json && (planInfo.json.membershipType || planInfo.json.plan)) || '';
        const up = (usage.json && usage.json.individualUsage && usage.json.individualUsage.plan) || (planInfo.json && planInfo.json.individualUsage && planInfo.json.individualUsage.plan) || null;
        const used = up && typeof up.used === 'number' ? up.used : (planInfo.json && typeof planInfo.json.used === 'number' ? planInfo.json.used : 0);
        const limit = up && typeof up.limit === 'number' ? up.limit : (planInfo.json && typeof planInfo.json.limit === 'number' ? planInfo.json.limit : 0);
        const hj = hard.status === 200 ? hard.json : null;
        const hardLimit = hj && typeof hj.hardLimit === 'number' ? hj.hardLimit : undefined;
        const usageBased = hj ? !(hj.noUsageBasedAllowed === true) : undefined;
        const qTop = extractDashboardQuotas(period && period.json, usage && usage.json, sand && sand.json);
        accountUsage = { email, plan, planLabel: planLabelOf(plan), used, limit, hardLimit, usageBased, fetchedAt: Date.now(), source: 'cursor.com', ...qTop };
    }
    catch (e) {
        accountUsage = { error: '读取用量异常：' + (e && e.message || String(e)), fetchedAt: Date.now(), source: 'error' };
    }
    finally {
        accountLoading = false;
        provider?.postState();
    }
}
// 用某账号自己的 token 联网拉邮箱/套餐/用量/超额（供 token 导入与每账号刷新复用；只读，不写凭证）
async function fetchAccountInfoByToken(userId, accessToken, intent = 'manual') {
    if (!accessToken)
        return { error: 'token 为空' };
    try {
        networkPolicy.assertAllowed({ host: 'cursor.com', intent });
    }
    catch (error) {
        return { error: error.message, policyDenied: true };
    }
    const cookie = buildCookie({ userId, accessToken });
    const [api2, me, stripe, usage, planInfo, hard, period, sand, sessions] = await Promise.all([
        cursorBearerUsage(accessToken, intent),
        cursorApi('GET', '/api/auth/me', cookie, undefined, 8000, intent),
        cursorApi('GET', '/api/auth/stripe', cookie, undefined, 8000, intent),
        cursorApi('GET', '/api/usage-summary', cookie, undefined, 8000, intent),
        cursorApi('POST', '/api/dashboard/get-plan-info', cookie, '{}', 8000, intent),
        cursorApi('POST', '/api/dashboard/get-hard-limit', cookie, '{}', 8000, intent),
        cursorApi('POST', '/api/dashboard/get-current-period-usage', cookie, '{}', 8000, intent),
        cursorApi('POST', '/api/dashboard/get-sand-usage-status', cookie, '{}', 8000, intent),
        cursorApi('GET', '/api/auth/sessions', cookie, undefined, 8000, intent)
    ]);
    if (![api2, me, stripe, usage, planInfo].some(r => r.status === 200 && r.json)) {
        const codes = [api2, me, stripe, usage, planInfo].map(r => r.status);
        return { error: codes.includes(401) || codes.includes(403) ? '登录态无效(401/403)' : codes.every(c => c === -1) ? '请求超时' : codes.every(c => c === 0) ? '网络错误' : '返回异常(' + codes.join('/') + ')' };
    }
    const resolvedUserId = normUserId((me.json && (me.json.sub || me.json.id || me.json.authId || me.json.userId)) || userId || '');
    const email = (me.json && me.json.email) || (api2.json && (api2.json.email || api2.json.usageSummaryEmail)) || (stripe.json && stripe.json.email) || '';
    const pi = planInfo.json && planInfo.json.planInfo && typeof planInfo.json.planInfo === 'object' ? planInfo.json.planInfo : (planInfo.json || {});
    const plan = (stripe.json && stripe.json.membershipType) || (api2.json && (api2.json.membershipType || api2.json.planName || api2.json.plan)) || (pi && (pi.membershipType || pi.planName || pi.plan)) || '';
    const up = (usage.json && usage.json.individualUsage && usage.json.individualUsage.plan) || (api2.json && api2.json.individualUsage && api2.json.individualUsage.plan) || null;
    const used = up && typeof up.used === 'number' ? up.used : 0;
    const limit = up && typeof up.limit === 'number' ? up.limit : 0;
    const hj = hard.status === 200 ? hard.json : null;
    const hardLimit = hj && typeof hj.hardLimit === 'number' ? hj.hardLimit : undefined;
    const usageBased = hj ? !(hj.noUsageBasedAllowed === true) : undefined;
    const billingCycleEnd = typeof pi.billingCycleEnd === 'number' ? pi.billingCycleEnd : undefined;
    const q = extractDashboardQuotas(period && period.json, usage && usage.json, sand && sand.json);
    const sessionCount = (sessions && sessions.status === 200 && sessions.json && Array.isArray(sessions.json.sessions)) ? sessions.json.sessions.length : null;
    return { userId: resolvedUserId, email, plan, used, limit, hardLimit, usageBased, billingCycleEnd, sessionCount, source: api2.status === 200 ? 'api2+cursor.com' : 'cursor.com', ...q };
}
function buildAccount(messages, chats, waiting) {
    const localLabel = os.userInfo().username || 'local';
    if (!accountUsageEnabled()) {
        return { label: localLabel, plan: '', planLabel: '本地模式', usageText: `${messages} msgs / ${chats} chats`, usageShort: '', usagePct: Math.min(100, messages % 101), waiting, loading: false, error: '', enabled: false };
    }
    const a = accountUsage;
    if (a && !a.error && (a.email || a.plan || a.limit)) {
        const used = a.used || 0, limit = a.limit || 0;
        const pct = limit > 0 ? Math.min(100, Math.round(used / limit * 100)) : Math.min(100, messages % 101);
        const qShort = [typeof a.autoPercent === 'number' ? ('A' + Math.round(a.autoPercent)) : '', typeof a.otherPercent === 'number' ? ('O' + Math.round(a.otherPercent)) : '', typeof a.botPercent === 'number' ? ('B' + Math.round(a.botPercent)) : ''].filter(Boolean).join(' ');
        const usageText = qShort || (limit > 0 ? `用量 ${used}/${limit}` : (used > 0 ? `用量 ${used}` : `${messages} msgs / ${chats} chats`));
        const usageShort = qShort || (limit > 0 ? `${used}/${limit}` : (used > 0 ? String(used) : ''));
        return { label: localLabel, email: a.email || '', plan: a.plan || '', planLabel: a.planLabel || a.plan || '', used, limit, usageText, usageShort, usagePct: pct, waiting, loading: accountLoading, error: '', enabled: true, hardLimit: typeof a.hardLimit === 'number' ? a.hardLimit : null, usageBased: typeof a.usageBased === 'boolean' ? a.usageBased : null, autoPercent: a.autoPercent, otherPercent: a.otherPercent, botPercent: a.botPercent, botHasLimit: !!a.botHasLimit, botResetAt: a.botResetAt || '', cycleEnd: a.cycleEnd || '' };
    }
    return { label: localLabel, email: (a && a.email) || '', plan: '', planLabel: accountLoading ? '加载中…' : '本地模式', usageText: `${messages} msgs / ${chats} chats`, usageShort: '', usagePct: Math.min(100, messages % 101), waiting, loading: accountLoading, error: (a && a.error) || '', enabled: true };
}
// ── 多账号管理（参考八戒：导入/列表/切换=写回 state.vscdb 全局登录态/超额三态）──
function acctId() { return 'acc_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function getAccounts() {
    if (!accountRepository)
        throw new Error('安全账号仓库尚未初始化');
    return accountRepository.list();
}
async function mutateAccounts(operation, mutator) {
    migrationGuard(operation);
    if (!accountRepository)
        throw new Error('安全账号仓库尚未初始化');
    return accountRepository.mutate(mutator);
}
function unquote(v) { const s = String(v == null ? '' : v); if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
    try {
        return String(JSON.parse(s));
    }
    catch { }
} return s; }
function normEmail(v) { return unquote(v).toLowerCase().trim(); }
function normUserId(v) { return unquote(v).trim(); }
function jwtEmailClaim(payload) {
    if (!payload || typeof payload !== 'object')
        return '';
    const v = payload.email || payload.email_address || '';
    const e = normEmail(v);
    return e && !e.endsWith('@cursor.local') ? e : '';
}
function collectCursorUserIds(userId, accessToken, authId) {
    const ids = new Set();
    const add = (v) => {
        const s = normUserId(String(v || '').replace(/^auth0\|/i, ''));
        if (!s)
            return;
        ids.add(s);
        const m = s.match(/user_[A-Za-z0-9]+/);
        if (m)
            ids.add(m[0]);
    };
    add(userId);
    add(authId);
    const p = decodeJwtPayload(accessToken) || {};
    add(p.sub);
    add(p.id);
    add(p.userId);
    add(p.authId);
    add(p.user_id);
    return ids;
}
function cursorIdsOverlap(a, b) {
    for (const x of a)
        if (x && b.has(x))
            return true;
    return false;
}
function realEmailOf(accessToken, fallback) {
    const p = decodeJwtPayload(accessToken) || {};
    const fromClaim = jwtEmailClaim(p);
    if (fromClaim)
        return fromClaim;
    const sub = String(p.sub || '');
    if (sub.includes('@'))
        return normEmail(sub.split('|').find(x => x.includes('@')) || sub);
    const fb = normEmail(fallback);
    return fb && !fb.endsWith('@cursor.local') ? fb : '';
}
// 网页 JWT.sub 和桌面授权回来的 WorkOS user_xxx 经常不是同一串，但还是同一个人。
// 只在两边都有真实邮箱且邮箱不同时才当成换号；id 对不上但邮箱未知则放行。
function isSameCursorAccount(expected, got) {
    const aIds = collectCursorUserIds(expected && expected.userId, expected && expected.accessToken, expected && expected.authId);
    const bIds = collectCursorUserIds(got && got.userId, got && got.accessToken, got && got.authId);
    if (cursorIdsOverlap(aIds, bIds))
        return true;
    const aEmail = realEmailOf(expected && expected.accessToken, expected && expected.email);
    const bEmail = realEmailOf(got && got.accessToken, got && got.email);
    if (aEmail && bEmail)
        return aEmail === bEmail;
    return true;
}
function decodeJwtPayload(token) {
    try {
        const part = String(token || '').split('.')[1];
        if (!part)
            return null;
        const padded = part.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - part.length % 4) % 4);
        return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
    }
    catch {
        return null;
    }
}
// 从 JWT 推导 token 类型与过期：type==='web' 是 cookie/网页令牌，不能用作 refresh_token；其它（client/session 等）视为可续期。
function tokenMetaOf(accessToken) {
    const p = decodeJwtPayload(accessToken) || {};
    const t = String(p.type || '').toLowerCase();
    const exp = typeof p.exp === 'number' ? p.exp : (Number(p.exp) || 0);
    return { tokenType: t === 'web' ? 'web' : 'client', accessTokenExp: exp };
}
function emailFromJwt(token, userId = '') {
    const payload = decodeJwtPayload(token) || {};
    const sub = String(payload.sub || '');
    if (sub.includes('@'))
        return normEmail(sub.split('|').find((p) => p.includes('@')) || sub);
    if (sub.includes('|')) {
        const part = sub.split('|').find((p) => p.startsWith('user_')) || '';
        if (part)
            return normEmail(part.replace(/^user_/, '') + '@cursor.local');
    }
    if (userId)
        return normEmail(userId.replace(/^user_/, '') + '@cursor.local');
    return '';
}
function findAccountMatch(list, acc) {
    const uid = normUserId(acc.userId);
    const email = normEmail(acc.email);
    if (uid) {
        const index = list.findIndex(a => normUserId(a.userId) === uid);
        if (index >= 0)
            return { index, conflict: false };
    }
    const realEmail = email && !email.endsWith('@cursor.local') ? email : '';
    if (realEmail) {
        const index = list.findIndex(a => normEmail(a.email) === realEmail);
        if (index >= 0) {
            const existingUid = normUserId(list[index].userId);
            if (uid && existingUid && uid !== existingUid)
                return { index: -1, conflict: true };
            return { index, conflict: false };
        }
    }
    return { index: -1, conflict: false };
}
function findAccountIndex(list, acc) {
    const match = findAccountMatch(list, acc);
    return match.conflict ? -1 : match.index;
}
function resolveCurrentAccountId() {
    const list = getAccounts();
    const liveUid = normUserId(currentCursorUserIdCache);
    const liveEmail = normEmail(currentCursorEmailCache);
    if (liveEmail) {
        const hits = list.filter(a => normEmail(a.email) === liveEmail);
        const hit = newestAccount(hits);
        if (hit)
            return hit.id;
    }
    if (liveUid) {
        const hits = list.filter(a => normUserId(a.userId) === liveUid);
        const hit = newestAccount(hits);
        if (hit)
            return hit.id;
    }
    return '';
}
function newestAccount(list) {
    if (!list.length)
        return null;
    return list.slice().sort((a, b) => {
        const ta = Date.parse(a.lastSwitchedAt || a.addedAt || '') || 0;
        const tb = Date.parse(b.lastSwitchedAt || b.addedAt || '') || 0;
        return tb - ta;
    })[0];
}
function makeAccountFromBlob(blob, hint) {
    const email = normEmail(blob['cursorAuth/cachedEmail'] || blob['cursorAuth/email'] || (hint && hint.email) || '');
    const userId = normUserId(blob['cursorAuth/userId'] || blob['cursorAuth/cachedUserId'] || (hint && hint.userId) || '');
    const type = unquote(blob['cursorAuth/stripeMembershipType'] || '');
    if (email && userId && !blob['cursorAuth/user'])
        blob['cursorAuth/user'] = JSON.stringify({ email, id: userId, sub: userId });
    return { id: acctId(), email, userId, type, addedAt: now(), authBlob: blob, partial: false };
}
async function upsertAccount(acc) {
    acc.userId = normUserId(acc.userId);
    acc.email = normEmail(acc.email) || acc.email || '';
    let saved;
    let duplicate = false;
    await mutateAccounts('保存账号', list => {
        const match = findAccountMatch(list, acc);
        if (match.conflict)
            throw new Error('邮箱相同但 userId 不一致，拒绝覆盖现有账号');
        if (match.index >= 0) {
            const prev = list[match.index];
            acc.id = prev.id;
            saved = {
                ...prev,
                ...acc,
                id: prev.id,
                addedAt: prev.addedAt || acc.addedAt,
                note: normalizeNote(acc.note != null ? acc.note : prev.note)
            };
            list[match.index] = saved;
            duplicate = true;
        }
        else {
            list.push(acc);
            saved = acc;
        }
        return list;
    });
    return { acc: saved, duplicate };
}
async function appendAccount(acc) {
    acc.id = acctId();
    acc.userId = normUserId(acc.userId);
    acc.email = normEmail(acc.email) || acc.email || '';
    acc.addedAt = now();
    await mutateAccounts('添加账号', list => {
        list.push(acc);
        return list;
    });
    return { acc };
}
async function addAccountFromCurrentLogin() {
    await refreshCurrentUserId();
    const blob = await querySqliteLike(path.join(cursorGlobalStorageDir(), 'state.vscdb'), 'cursorAuth/%');
    if (!blob || !blob['cursorAuth/accessToken'])
        return { ok: false, error: '未读取到当前 Cursor 登录态（需本机已登录 Cursor 且 sqlite 可用）' };
    await appendAccount(makeAccountFromBlob(blob));
    return { ok: true, duplicate: false };
}
async function addAccountFromToken(token) {
    const parsed = parseCursorSessionInput(token);
    let userId = parsed.userId, accessToken = parsed.accessToken;
    if (!accessToken)
        return { ok: false, error: 'token 为空' };
    const meta = tokenMetaOf(accessToken);
    // 若粘贴了第三段 refreshToken，且它不等于 accessToken，则视为可续期 client 账号（和浏览器登录等价）。
    let pastedRefresh = parsed.refreshToken && parsed.refreshToken !== accessToken ? parsed.refreshToken : '';
    const isClient = !!pastedRefresh;
    const metaFinal = meta;
    const info = await fetchAccountInfoByToken(userId, accessToken);
    if (info.userId)
        userId = info.userId;
    const parsedEmail = normEmail(info.email || emailFromJwt(accessToken, userId));
    const sess = userId ? (userId + '%3A%3A' + accessToken) : accessToken;
    // 写全键集（对齐八戒：补 isLoggedIn/isAuthenticated/isAuthorized='true' + 联网拿到的 email/plan），让切换尽量生效。
    // 注意：cookie/token 导入天生无真 refreshToken —— 绝不再把 accessToken 当 refreshToken 写（那会让 Cursor 续期收到 shouldLogout 并弹登录框）。
    const blob = {
        'cursorAuth/accessToken': accessToken,
        'cursorAuth/userId': userId,
        'cursorAuth/cachedUserId': userId,
        'cursorAuth/workosCursorSessionToken': sess,
        'cursorAuth/cachedWorkosSessionToken': sess,
        'cursorAuth/isLoggedIn': 'true',
        'cursorAuth/isAuthenticated': 'true',
        'cursorAuth/isAuthorized': 'true'
    };
    if (pastedRefresh)
        blob['cursorAuth/refreshToken'] = pastedRefresh;
    if (parsedEmail) {
        blob['cursorAuth/cachedEmail'] = parsedEmail;
        blob['cursorAuth/email'] = parsedEmail;
        blob['cursorAuth/user'] = JSON.stringify({ email: parsedEmail, id: userId, sub: userId });
    }
    if (info.plan)
        blob['cursorAuth/stripeMembershipType'] = info.plan;
    if (userId) {
        blob['cursorAuth/userId'] = userId;
        blob['cursorAuth/cachedUserId'] = userId;
        blob['cursorAuth/authId'] = userId;
    }
    const acc = makeAccountFromBlob(blob);
    acc.partial = !isClient;
    acc.tokenType = isClient ? 'client' : metaFinal.tokenType;
    acc.accessTokenExp = metaFinal.accessTokenExp;
    acc.noRefresh = !isClient;
    acc.refreshToken = pastedRefresh;
    acc.source = isClient ? 'token' : 'cookie';
    if (parsedEmail)
        acc.email = parsedEmail;
    if (info.userId)
        acc.userId = normUserId(info.userId);
    if (info.plan)
        acc.type = info.plan;
    acc.usage = usageFromInfo(info);
    const saved = await upsertAccount(acc);
    return { ok: true, duplicate: saved.duplicate, error: info.error, tokenType: acc.tokenType, accId: saved.acc.id, userId, accessToken };
}
// 浏览器深度登录拿到真 client token 对后入列：存真 refreshToken，可自动续期、切号后不会弹登录框。
async function addAccountFromDeepLogin(accessToken, refreshToken, authId, options = {}) {
    if (!accessToken || !refreshToken)
        return { ok: false, error: '深度登录未返回完整令牌' };
    const meta = tokenMetaOf(accessToken);
    const payload = decodeJwtPayload(accessToken) || {};
    let userId = normUserId(String(payload.sub || '').replace(/^auth0\|/, '') || (authId && !authId.includes('@') ? authId : ''));
    const info = await fetchAccountInfoByToken(userId, accessToken);
    if (info.userId)
        userId = info.userId;
    const email = normEmail(info.email || (authId && authId.includes('@') ? authId : '') || emailFromJwt(accessToken, userId));
    const sess = userId ? (userId + '%3A%3A' + accessToken) : accessToken;
    const blob = {
        'cursorAuth/accessToken': accessToken,
        'cursorAuth/refreshToken': refreshToken,
        'cursorAuth/userId': userId,
        'cursorAuth/cachedUserId': userId,
        'cursorAuth/workosCursorSessionToken': sess,
        'cursorAuth/cachedWorkosSessionToken': sess,
        'cursorAuth/isLoggedIn': 'true',
        'cursorAuth/isAuthenticated': 'true',
        'cursorAuth/isAuthorized': 'true'
    };
    if (email) {
        blob['cursorAuth/cachedEmail'] = email;
        blob['cursorAuth/email'] = email;
        blob['cursorAuth/user'] = JSON.stringify({ email, id: userId, sub: userId });
    }
    if (info.plan)
        blob['cursorAuth/stripeMembershipType'] = info.plan;
    if (userId)
        blob['cursorAuth/authId'] = userId;
    const acc = makeAccountFromBlob(blob);
    acc.partial = false;
    acc.tokenType = 'client';
    acc.accessTokenExp = meta.accessTokenExp;
    acc.noRefresh = false;
    acc.refreshToken = refreshToken;
    acc.source = options.source || 'deeplogin';
    if (email)
        acc.email = email;
    if (info.userId)
        acc.userId = normUserId(info.userId);
    if (info.plan)
        acc.type = info.plan;
    acc.usage = usageFromInfo(info);
    if (options.replaceAccountId) {
        let saved = null;
        await mutateAccounts('升级账号令牌', list => {
            const index = list.findIndex(item => item.id === options.replaceAccountId);
            if (index < 0)
                return undefined;
            const previous = list[index];
            const currentAccessToken = unquote(
                previous.authBlob && previous.authBlob['cursorAuth/accessToken'] || ''
            );
            if (currentAccessToken !== options.expectedAccessToken)
                return undefined;
            acc.id = previous.id;
            saved = {
                ...previous,
                ...acc,
                id: previous.id,
                addedAt: previous.addedAt || acc.addedAt,
                note: normalizeNote(previous.note)
            };
            list[index] = saved;
            return list;
        });
        if (!saved) {
            return {
                ok: false,
                error: '目标账号已被删除或凭据已在授权期间变更，未写入升级令牌'
            };
        }
        return { ok: true, duplicate: true, error: info.error, acc: saved };
    }
    const saved = await upsertAccount(acc);
    return { ok: true, duplicate: saved.duplicate, error: info.error };
}
async function refreshCurrentUserId() {
    const rows = await querySqliteLike(path.join(cursorGlobalStorageDir(), 'state.vscdb'), 'cursorAuth/%');
    if (rows) {
        currentCursorUserIdCache = normUserId(rows['cursorAuth/userId'] || rows['cursorAuth/cachedUserId'] || '');
        currentCursorEmailCache = normEmail(rows['cursorAuth/cachedEmail'] || rows['cursorAuth/email'] || '');
        if (!migrationBlocked && currentCursorUserIdCache && currentCursorEmailCache)
            await backfillCurrentAccountEmail(currentCursorUserIdCache, currentCursorEmailCache, rows);
    }
    provider?.postState();
}
async function backfillCurrentAccountEmail(userId, email, rows) {
    await mutateAccounts('补全账号邮箱', list => {
        const candidates = list.filter(a => normUserId(a.userId) === userId || (normEmail(a.email).endsWith('@cursor.local') && String(a.userId || '').slice(-8) === userId.slice(-8)));
        const acc = newestAccount(candidates);
        if (!acc || normEmail(acc.email) === normEmail(email))
            return undefined;
        acc.email = normEmail(email);
        acc.authBlob = acc.authBlob || {};
        acc.authBlob['cursorAuth/cachedEmail'] = normEmail(email);
        acc.authBlob['cursorAuth/email'] = normEmail(email);
        acc.authBlob['cursorAuth/user'] = (rows && rows['cursorAuth/user']) || JSON.stringify({ email: normEmail(email), id: userId, sub: userId });
        return list;
    });
}
async function refreshAccountInfo(id) {
    const acc = getAccounts().find(a => a.id === id);
    if (!acc)
        return { ok: false, error: '账号不存在' };
    const blob = acc.authBlob || {};
    const accessToken = unquote(blob['cursorAuth/accessToken'] || '');
    const userId = acc.userId || unquote(blob['cursorAuth/userId'] || '');
    if (!accessToken)
        return { ok: false, error: '该账号无 accessToken，无法联网刷新' };
    const info = await fetchAccountInfoByToken(userId, accessToken);
    let updated = false;
    await mutateAccounts('刷新账号信息', list => {
        const current = list.find(item => item.id === id);
        if (!current)
            return undefined;
        const currentToken = unquote(current.authBlob && current.authBlob['cursorAuth/accessToken'] || '');
        if (currentToken !== accessToken)
            return undefined;
        if (info.email)
            current.email = normEmail(info.email);
        if (info.userId)
            current.userId = normUserId(info.userId);
        if (info.plan)
            current.type = info.plan;
        current.usage = usageFromInfo(info);
        if (info.email || info.plan || info.userId) {
            current.authBlob = current.authBlob || {};
            if (info.email) {
                current.authBlob['cursorAuth/cachedEmail'] = info.email;
                current.authBlob['cursorAuth/email'] = info.email;
                current.authBlob['cursorAuth/user'] = JSON.stringify({ email: info.email, id: info.userId || current.userId, sub: info.userId || current.userId });
                delete current.authBlob['cursor.email'];
            }
            if (info.plan)
                current.authBlob['cursorAuth/stripeMembershipType'] = info.plan;
            if (info.userId) {
                current.authBlob['cursorAuth/userId'] = info.userId;
                current.authBlob['cursorAuth/cachedUserId'] = info.userId;
                current.authBlob['cursorAuth/authId'] = info.userId;
            }
        }
        updated = true;
        return list;
    });
    return updated
        ? { ok: true, error: info.error }
        : { ok: false, error: '账号已被删除或凭据已在刷新期间变更' };
}
// 把续期拿到的新 token 写回账号对象（accessToken/refreshToken/exp/authBlob），并持久化。
function applyRefreshedTokenToAccount(acc, accessToken, refreshToken) {
    acc.refreshToken = refreshToken || acc.refreshToken || '';
    const meta = tokenMetaOf(accessToken);
    acc.tokenType = 'client';
    acc.noRefresh = false;
    acc.accessTokenExp = meta.accessTokenExp;
    acc.authBlob = acc.authBlob || {};
    acc.authBlob['cursorAuth/accessToken'] = accessToken;
    if (acc.refreshToken)
        acc.authBlob['cursorAuth/refreshToken'] = acc.refreshToken;
    const uid = normUserId(acc.userId || unquote(acc.authBlob['cursorAuth/userId'] || ''));
    if (uid)
        acc.authBlob['cursorAuth/workosCursorSessionToken'] = uid + '%3A%3A' + accessToken;
}
// 切前/定时调用：仅对 client（有真 refreshToken）账号生效。accessToken 失效或临近过期则续期；web 账号直接跳过。
async function ensureFreshAccessToken(acc, intent = 'manual') {
    if (!acc || acc.tokenType === 'web' || acc.noRefresh === true)
        return { refreshed: false };
    const refreshToken = unquote(acc.refreshToken || (acc.authBlob && acc.authBlob['cursorAuth/refreshToken']) || '');
    const accessToken = unquote((acc.authBlob && acc.authBlob['cursorAuth/accessToken']) || '');
    if (!refreshToken || refreshToken === accessToken)
        return { refreshed: false };
    // 判断是否需要续期：accessToken 缺失、已过期、或 5 分钟内过期。
    const exp = acc.accessTokenExp || tokenMetaOf(accessToken).accessTokenExp;
    const soon = !accessToken || !exp || (exp - Math.floor(Date.now() / 1000) < 300);
    if (!soon)
        return { refreshed: false };
    const r = await refreshCursorAccessToken(refreshToken, acc.id || 'shared', intent);
    if (!r.ok || !r.accessToken)
        return { refreshed: false, error: r.error };
    applyRefreshedTokenToAccount(acc, r.accessToken, r.refreshToken || refreshToken);
    return { refreshed: true };
}
// 每账号「刷新 Token」按钮：client 账号强制走 OAuth 续期换新 token；web 账号明确提示无法续期。
async function accountRefreshToken(id) {
    const acc = getAccounts().find(a => a.id === id);
    if (!acc)
        return { ok: false, error: '账号不存在' };
    if (acc.tokenType === 'web' || acc.noRefresh === true)
        return { ok: false, error: '该账号为 web/cookie token，无法自动续期。请用「浏览器登录」重新添加可续期账号。' };
    const refreshToken = unquote(acc.refreshToken || (acc.authBlob && acc.authBlob['cursorAuth/refreshToken']) || '');
    if (!refreshToken)
        return { ok: false, error: '该账号无 refreshToken，无法续期。请用「浏览器登录」重新添加。' };
    const r = await refreshCursorAccessToken(refreshToken, acc.id, 'manual');
    if (!r.ok || !r.accessToken) {
        if (r.shouldLogout) {
            await mutateAccounts('标记账号令牌失效', list => {
                const current = list.find(item => item.id === id);
                const currentRefreshToken = unquote(current && (
                    current.refreshToken ||
                    current.authBlob && current.authBlob['cursorAuth/refreshToken']
                ) || '');
                if (!current || currentRefreshToken !== refreshToken)
                    return undefined;
                current.noRefresh = true;
                return list;
            });
        }
        return { ok: false, error: r.error || '续期失败', shouldLogout: r.shouldLogout };
    }
    // 顺带刷新一次额度/邮箱
    const info = await fetchAccountInfoByToken(acc.userId || '', r.accessToken);
    let persisted = false;
    await mutateAccounts('保存续期令牌', list => {
        const current = list.find(item => item.id === id);
        const currentRefreshToken = unquote(current && (
            current.refreshToken ||
            current.authBlob && current.authBlob['cursorAuth/refreshToken']
        ) || '');
        if (!current || currentRefreshToken !== refreshToken)
            return undefined;
        applyRefreshedTokenToAccount(current, r.accessToken, r.refreshToken || refreshToken);
        if (info.email)
            current.email = normEmail(info.email);
        if (info.plan)
            current.type = info.plan;
        current.usage = usageFromInfo(info);
        persisted = true;
        return list;
    });
    return persisted
        ? { ok: true, refreshed: true }
        : { ok: false, error: '账号已被删除或凭据已在续期期间变更' };
}
// 后台定时续期：对所有 client 账号做一次「临期才续」的检查（受 autoRefreshAccountTokens 控制）。
async function refreshAllAccountTokens() {
    if (!networkPolicy || networkPolicy.mode !== MODES.AUTOMATIC ||
        cfgGetMachine('autoRefreshAccountTokens') === false)
        return;
    let changed = false;
    const errors = [];
    for (const acc of getAccounts()) {
        const expectedRefreshToken = unquote(
            acc.refreshToken ||
            acc.authBlob && acc.authBlob['cursorAuth/refreshToken'] ||
            ''
        );
        try {
            const r = await ensureFreshAccessToken(acc, 'automatic');
            if (r.refreshed) {
                const refreshedAccessToken = unquote(acc.authBlob && acc.authBlob['cursorAuth/accessToken'] || '');
                const refreshedRefreshToken = unquote(
                    acc.refreshToken ||
                    acc.authBlob && acc.authBlob['cursorAuth/refreshToken'] ||
                    expectedRefreshToken
                );
                let persisted = false;
                await mutateAccounts('自动保存续期令牌', list => {
                    const current = list.find(item => item.id === acc.id);
                    const currentRefreshToken = unquote(current && (
                        current.refreshToken ||
                        current.authBlob && current.authBlob['cursorAuth/refreshToken']
                    ) || '');
                    if (!current || currentRefreshToken !== expectedRefreshToken)
                        return undefined;
                    applyRefreshedTokenToAccount(current, refreshedAccessToken, refreshedRefreshToken);
                    persisted = true;
                    return list;
                });
                changed = changed || persisted;
            }
        }
        catch (error) {
            const detail = presentError(error, { fallback: '自动续期失败' });
            errors.push(detail);
            let persisted = false;
            await mutateAccounts('记录自动续期错误', list => {
                const current = list.find(item => item.id === acc.id);
                const currentRefreshToken = unquote(current && (
                    current.refreshToken ||
                    current.authBlob && current.authBlob['cursorAuth/refreshToken']
                ) || '');
                if (!current || currentRefreshToken !== expectedRefreshToken)
                    return undefined;
                current.usage = { ...(current.usage || {}), error: detail.message, fetchedAt: now() };
                persisted = true;
                return list;
            });
            changed = changed || persisted;
        }
    }
    if (changed)
        provider?.postState();
    if (errors.length)
        reportOperationError('自动续期账号令牌', `${errors.length} 个账号续期失败：${errors[0].message}`, { notify: false });
}
async function switchCursorAccount(id) {
    stateWriteGuard('切换账号');
    if (!cursorStateStore)
        return { ok: false, error: '未找到可用 SQLite 模块，无法安全切换账号' };
    let acc = getAccounts().find(a => a.id === id);
    if (!acc)
        return { ok: false, error: '账号不存在' };
    const expectedRefreshToken = unquote(
        acc.refreshToken ||
        acc.authBlob && acc.authBlob['cursorAuth/refreshToken'] ||
        ''
    );
    // 切前续期：client 账号若 accessToken 已失效且有真 refreshToken，先换新 token 再写入，避免写过期 token。
    const freshness = await ensureFreshAccessToken(acc, 'manual');
    if (freshness.error)
        return { ok: false, error: '切换前续期失败：' + freshness.error };
    if (freshness.refreshed) {
        const refreshedAccessToken = unquote(acc.authBlob && acc.authBlob['cursorAuth/accessToken'] || '');
        const refreshedRefreshToken = unquote(
            acc.refreshToken ||
            acc.authBlob && acc.authBlob['cursorAuth/refreshToken'] ||
            expectedRefreshToken
        );
        let persisted = false;
        await mutateAccounts('保存切号前续期令牌', list => {
            const current = list.find(item => item.id === id);
            const currentRefreshToken = unquote(current && (
                current.refreshToken ||
                current.authBlob && current.authBlob['cursorAuth/refreshToken']
            ) || '');
            if (!current || currentRefreshToken !== expectedRefreshToken)
                return undefined;
            applyRefreshedTokenToAccount(current, refreshedAccessToken, refreshedRefreshToken);
            persisted = true;
            return list;
        });
        if (!persisted)
            return { ok: false, error: '账号已被删除或凭据已在续期期间变更' };
    }
    acc = getAccounts().find(item => item.id === id);
    if (!acc)
        return { ok: false, error: '账号已在切换期间被删除' };
    const blob = acc.authBlob || {};
    if (!unquote(blob['cursorAuth/accessToken'] || ''))
        return { ok: false, error: '该账号无 accessToken，请用「导入本机 Token」重新添加' };
    if (!normUserId(acc.userId || blob['cursorAuth/userId'] || blob['cursorAuth/cachedUserId'] || ''))
        return { ok: false, error: '该账号 userId 缺失，请删除后重新用「导入 userId::Token」或在该账号登录时用「导入本机 Token」' };
    let switched;
    try {
        switched = await cursorStateStore.switchAccount(acc);
    }
    catch (error) {
        const suffix = error && error.recoveryRequired
            ? '；恢复 journal 已保留，请先运行“恢复最近切号”'
            : (error && error.rolledBack ? '；原鉴权状态已回滚' : '');
        return { ok: false, error: (error && error.message || String(error)) + suffix };
    }
    await mutateAccounts('记录账号切换时间', list => {
        const current = list.find(item => item.id === id);
        if (!current)
            return undefined;
        current.lastSwitchedAt = now();
        return list;
    });
    await refreshCurrentUserId();
    try {
        await accountRepository.clearManualToken();
    }
    catch (error) {
        return {
            ok: true,
            needsRestart: true,
            backupName: switched.backupName,
            warning: '账号已切换，但清理手动 Token 失败：' + (error && error.message || error)
        };
    }
    accountUsage = null;
    // 账号已写入 state.vscdb。Cursor 在运行时把鉴权缓存在内存里，必须完整重启才会重新从库读取并生效。
    return {
        ok: true,
        needsRestart: true,
        backupName: switched.backupName,
        recoveryPending: switched.recoveryPending === true
    };
}
async function setHardLimitForAccount(id, mode, limitDollars) {
    migrationGuard('修改超额设置');
    const acc = getAccounts().find(account => account.id === id);
    if (!acc)
        return { ok: false, error: '账号不存在' };
    const blob = acc.authBlob || {};
    const accessToken = unquote(blob['cursorAuth/accessToken'] || '');
    const userId = acc.userId || unquote(blob['cursorAuth/userId'] || '');
    if (!accessToken)
        return { ok: false, error: '该账号无 accessToken' };
    const response = await cursorApi(
        'POST',
        '/api/dashboard/set-hard-limit',
        buildCookie({ userId, accessToken }),
        JSON.stringify(cursorHardLimitBody(mode, limitDollars)),
        8000,
        'manual'
    );
    if (response.status !== 200) {
        return {
            ok: false,
            error: response.status === 401 || response.status === 403
                ? '登录态无效'
                : (response.status === -1 ? '请求超时' : ('HTTP ' + response.status))
        };
    }
    await refreshAccountInfo(id);
    return { ok: true };
}
async function removeAccount(id) {
    await mutateAccounts('删除账号', list => list.filter(account => account.id !== id));
}
function normalizeNote(v) {
    return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, 24);
}
async function setAccountNote(id, note) {
    const normalized = normalizeNote(note);
    let updated = false;
    await mutateAccounts('保存账号备注', list => {
        const acc = list.find(a => a.id === id);
        if (!acc)
            return undefined;
        acc.note = normalized;
        updated = true;
        return list;
    });
    return updated
        ? { ok: true, note: normalized }
        : { ok: false, error: '账号不存在' };
}
function accountsForClient() {
    const currentId = resolveCurrentAccountId();
    return getAccounts().map(a => {
        const u = a.usage || null;
        const hasRealRefresh = !!(a.refreshToken || (a.authBlob && a.authBlob['cursorAuth/refreshToken']));
        const tokenType = a.tokenType || (a.partial ? 'web' : (hasRealRefresh ? 'client' : 'web'));
        return {
            id: a.id, email: a.email || '(未知邮箱)', userTail: String(a.userId || '').slice(-8), type: a.type || '', partial: !!a.partial,
            tokenType,
            credentialStatus: a.credentialStatus || 'missing',
            accessTokenExp: typeof a.accessTokenExp === 'number' ? a.accessTokenExp : 0,
            addedAt: a.addedAt || '',
            source: a.source || (a.partial ? 'cookie' : 'currentLogin'),
            noRefresh: !!(a.noRefresh || tokenType === 'web' || !hasRealRefresh),
            isCurrent: !!currentId && a.id === currentId,
            used: u && typeof u.used === 'number' ? u.used : null,
            limit: u && typeof u.limit === 'number' ? u.limit : null,
            hardLimit: u && typeof u.hardLimit === 'number' ? u.hardLimit : null,
            usageBased: u && typeof u.usageBased === 'boolean' ? u.usageBased : null,
            usageError: u && u.error ? u.error : '',
            autoPercent: u && typeof u.autoPercent === 'number' ? u.autoPercent : null,
            otherPercent: u && typeof u.otherPercent === 'number' ? u.otherPercent : null,
            totalPercent: u && typeof u.totalPercent === 'number' ? u.totalPercent : null,
            botPercent: u && typeof u.botPercent === 'number' ? u.botPercent : null,
            botHasLimit: !!(u && u.botHasLimit),
            botResetAt: (u && u.botResetAt) || '',
            cycleEnd: (u && u.cycleEnd) || '',
            sessionCount: u && typeof u.sessionCount === 'number' ? u.sessionCount : null,
            note: normalizeNote(a.note)
        };
    });
}
function pickFinite() {
    for (let i = 0; i < arguments.length; i++) {
        const v = arguments[i];
        if (typeof v === 'number' && Number.isFinite(v))
            return v;
    }
    return null;
}
function parseAnyDate(v) {
    if (v == null || v === '')
        return '';
    if (typeof v === 'number' && Number.isFinite(v))
        return new Date(v > 1e12 ? v : v * 1000).toISOString();
    const s = String(v).trim();
    if (/^\d{13}$/.test(s))
        return new Date(Number(s)).toISOString();
    if (/^\d{10}$/.test(s))
        return new Date(Number(s) * 1000).toISOString();
    const d = new Date(s);
    return Number.isFinite(d.getTime()) ? d.toISOString() : '';
}
function extractDashboardQuotas(period, usage, sand) {
    const pu = (period && period.planUsage) || (usage && usage.individualUsage && usage.individualUsage.plan) || {};
    const sandOk = !!(sand && sand.hasNonZeroIncludedLimit);
    return {
        autoPercent: pickFinite(pu.autoPercentUsed),
        otherPercent: pickFinite(pu.apiPercentUsed),
        totalPercent: pickFinite(pu.totalPercentUsed),
        botPercent: sandOk ? pickFinite(sand.usagePercent) : null,
        botHasLimit: sandOk,
        botResetAt: sandOk ? parseAnyDate(sand.nextResetTimestampUtc) : '',
        cycleEnd: parseAnyDate((period && period.billingCycleEnd) || (usage && usage.billingCycleEnd))
    };
}
function usageFromInfo(info) {
    if (!info)
        return { error: '空结果', fetchedAt: now() };
    if (info.error)
        return { error: info.error, fetchedAt: now() };
    return {
        used: info.used,
        limit: info.limit,
        hardLimit: info.hardLimit,
        usageBased: info.usageBased,
        plan: info.plan,
        autoPercent: info.autoPercent,
        otherPercent: info.otherPercent,
        totalPercent: info.totalPercent,
        botPercent: info.botPercent,
        botHasLimit: !!info.botHasLimit,
        botResetAt: info.botResetAt || '',
        cycleEnd: info.cycleEnd || '',
        sessionCount: typeof info.sessionCount === 'number' ? info.sessionCount : null,
        fetchedAt: now()
    };
}
function sessionTypeLabel(t) {
    const x = String(t || '').toUpperCase();
    if (x.includes('WEB'))
        return 'Web';
    if (x.includes('CLIENT') || x.includes('DESKTOP') || x.includes('APP') || x.includes('IDE'))
        return 'Cursor 桌面';
    if (x.includes('MOBILE'))
        return '手机';
    return String(t || '').replace(/^SESSION_TYPE_/, '') || '未知设备';
}
function accountAuthPair(id) {
    const acc = getAccounts().find(a => a.id === id);
    if (!acc)
        return null;
    const blob = acc.authBlob || {};
    const accessToken = unquote(blob['cursorAuth/accessToken'] || '');
    const userId = acc.userId || unquote(blob['cursorAuth/userId'] || '');
    if (!accessToken)
        return null;
    return { acc, userId, accessToken, cookie: buildCookie({ userId, accessToken }) };
}
async function listAccountSessions(id) {
    try {
        networkPolicy.assertAllowed({ host: 'cursor.com', intent: 'manual' });
    }
    catch (error) {
        return { ok: false, error: error.message };
    }
    const pair = accountAuthPair(id);
    if (!pair)
        return { ok: false, error: '账号不存在或无令牌' };
    const r = await cursorApi('GET', '/api/auth/sessions', pair.cookie);
    if (r.status !== 200 || !r.json)
        return { ok: false, error: r.status === 401 || r.status === 403 ? '登录态无效' : (r.status === -1 ? '请求超时' : ('HTTP ' + (r.status || 0))) };
    const sessions = (Array.isArray(r.json.sessions) ? r.json.sessions : []).map(s => ({
        sessionId: String(s.sessionId || ''),
        type: String(s.type || ''),
        typeLabel: sessionTypeLabel(s.type),
        createdAt: s.createdAt || '',
        expiresAt: s.expiresAt || ''
    })).filter(s => s.sessionId);
    return { ok: true, email: pair.acc.email || '', sessions };
}
async function revokeAccountSession(id, sessionId) {
    try {
        networkPolicy.assertAllowed({ host: 'cursor.com', intent: 'manual' });
    }
    catch (error) {
        return { ok: false, error: error.message };
    }
    const pair = accountAuthPair(id);
    if (!pair)
        return { ok: false, error: '账号不存在或无令牌' };
    const sid = String(sessionId || '').trim();
    if (!sid)
        return { ok: false, error: 'sessionId 为空' };
    const r = await cursorApi('POST', '/api/auth/sessions/revoke', pair.cookie, JSON.stringify({ sessionId: sid }));
    if (r.status !== 200)
        return { ok: false, error: r.status === 401 || r.status === 403 ? '登录态无效' : (r.status === -1 ? '请求超时' : ('HTTP ' + r.status)) };
    return { ok: true };
}
async function promptPendingTokenImport() {
    if (migrationBlocked)
        return;
    const cursorHome = path.join(os.homedir(), '.cursor');
    const candidates = [
        path.join(cursorHome, 'cursor-account-manager-pending-import.txt'),
        path.join(cursorHome, 'keepchat-pending-import.txt'),
        path.join(cursorHome, 'cursor-accounts-pending-import.txt')
    ];
    const existing = [];
    for (const candidate of candidates) {
        try {
            const stat = await fs.promises.lstat(candidate);
            if (!stat.isFile() || stat.isSymbolicLink()) {
                const error = new Error('旧版待导入文件不是普通文件，已拒绝读取：' + path.basename(candidate));
                error.code = 'UNSAFE_PENDING_IMPORT';
                throw error;
            }
            if (stat.size > 256 * 1024) {
                const error = new Error('旧版待导入文件过大，已拒绝读取：' + path.basename(candidate));
                error.code = 'PENDING_IMPORT_TOO_LARGE';
                throw error;
            }
            if (typeof process.getuid === 'function' && Number.isInteger(stat.uid) && stat.uid !== process.getuid()) {
                const error = new Error('旧版待导入文件不属于当前用户，已拒绝读取：' + path.basename(candidate));
                error.code = 'PENDING_IMPORT_OWNER_MISMATCH';
                throw error;
            }
            existing.push({
                path: candidate,
                unsafePermissions: process.platform !== 'win32' && (stat.mode & 0o077) !== 0
            });
        }
        catch (error) {
            if (error && error.code === 'ENOENT')
                continue;
            throw error;
        }
    }
    if (!existing.length)
        return;
    const permissionWarning = existing.some(item => item.unsafePermissions)
        ? '\n其中有文件可被其他本机用户读取；请确认文件确由你创建。'
        : '';
    const accepted = await vscode.window.showWarningMessage(
        `检测到 ${existing.length} 个旧版明文 Token 待导入文件。只有确认后才会读取；成功写入系统安全存储后才会删除原文件。${permissionWarning}`,
        { modal: true },
        '安全导入'
    );
    if (accepted !== '安全导入')
        return;
    let imported = 0;
    for (const item of existing) {
        const token = String(await fs.promises.readFile(item.path, 'utf8')).trim();
        if (token) {
            const result = await addAccountFromToken(token);
            if (!result.ok) {
                const error = new Error(result.error || ('无法导入 ' + path.basename(item.path)));
                error.code = 'PENDING_IMPORT_FAILED';
                throw error;
            }
            imported += 1;
        }
        await durableUnlink(item.path, { root: cursorHome });
    }
    vscode.window.showInformationMessage(`账号管理：已安全导入 ${imported} 个旧版待处理账号并删除明文文件`);
    provider?.postState();
}


function sandAppRoot() {
    const configured = String(cfgGetMachine('sandAppRoot') || '').trim();
    return configured || (vscode.env && vscode.env.appRoot) || '';
}
function sandStateRoot() {
    return (extensionContext && extensionContext.globalStorageUri && extensionContext.globalStorageUri.fsPath) || sandPatcher.defaultStateRoot();
}
function sandGlobalStorageDir() {
    if (process.platform === 'darwin')
        return path.join(os.homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage');
    if (process.platform === 'win32')
        return path.join(process.env.APPDATA || os.homedir(), 'Cursor', 'User', 'globalStorage');
    return path.join(os.homedir(), '.config', 'Cursor', 'User', 'globalStorage');
}
function knownSandStateRoots() {
    const list = [];
    const add = (p) => {
        const n = String(p || '').trim();
        if (n && !list.includes(n))
            list.push(n);
    };
    add(sandStateRoot());
    add(path.join(sandGlobalStorageDir(), 'leila-local.cursor-sand-router'));
    add(sandPatcher.defaultStateRoot());
    try {
        const gs = sandGlobalStorageDir();
        for (const name of fs.readdirSync(gs)) {
            if (/sand-router|sandrouter/i.test(name))
                add(path.join(gs, name));
        }
    }
    catch { }
    return list;
}
function pickRestoreStateRoot(appRoot) {
    const roots = knownSandStateRoots();
    if (appRoot) {
        for (const root of roots) {
            try {
                if (sandPatcher.findLatestManifest(appRoot, root))
                    return root;
            }
            catch { }
        }
    }
    for (const root of roots) {
        try {
            if (fs.existsSync(path.join(root, 'backups')))
                return root;
        }
        catch { }
    }
    return path.join(sandGlobalStorageDir(), 'leila-local.cursor-sand-router');
}
function sandStatusForClient() {
    try {
        const root = sandAppRoot();
        if (!root)
            return {
                patched: false,
                version: '',
                sand: 0,
                unpatched: 0,
                error: '未找到 Cursor 安装目录',
                auto: sandAutoPatchEnabled(),
                residualRisk: sandElevation.residualRisk.statement
            };
        const s = sandPatcher.inspect(root);
        return {
            patched: !!s.patched,
            version: s.version || '',
            sand: (s.totals && s.totals.sandAssignments) || 0,
            unpatched: (s.totals && s.totals.unpatchedAssignments) || 0,
            partial: !!s.partial,
            state: s.state || '',
            error: '',
            auto: false,
            residualRisk: sandElevation.residualRisk.statement
        };
    }
    catch (e) {
        return {
            patched: false,
            version: '',
            sand: 0,
            unpatched: 0,
            error: presentError(e, { fallback: 'Sand 状态读取失败' }).message,
            auto: sandAutoPatchEnabled(),
            residualRisk: sandElevation.residualRisk.statement
        };
    }
}
function sandAutoPatchEnabled() {
    return false;
}
function refreshSandStatusBar() {
    if (!sandStatusBar)
        return;
    const s = sandStatusForClient();
    if (s.error) {
        sandStatusBar.text = '$(warning) Sand 异常';
        sandStatusBar.tooltip = s.error;
    }
    else if (s.patched) {
        sandStatusBar.text = '$(check) Sand 已注入';
        sandStatusBar.tooltip = 'x-cursor-client-type = sand\n点击打开账号管理';
    }
    else {
        sandStatusBar.text = '$(circle-slash) Sand 未注入';
        sandStatusBar.tooltip = '点击打开账号管理，一键注入';
    }
    sandStatusBar.command = CMD_OPEN;
}
async function applySandPatchFromUi() {
    const accepted = await vscode.window.showWarningMessage(
        'Sand/Grok 会修改 Cursor 安装文件并可能请求管理员权限，这可能触发完整性校验或账号风控。内置提权仅做尽力加固，不能替代签名原生 Helper。确定继续？',
        { modal: true },
        '继续注入 Sand'
    );
    if (accepted !== '继续注入 Sand')
        return { cancelled: true };
    const cliPath = path.join(__dirname, 'sandCli.js');
    const appRoot = sandAppRoot();
    const stateRoot = sandStateRoot();
    try {
        const result = sandPatcher.applyPatch({ appRoot, stateRoot });
        refreshSandStatusBar();
        provider?.postState();
        return result;
    } catch (e) {
        if (isPermissionFailure(e)) {
            const args = ['apply', '--app-root', appRoot, '--state-root', stateRoot, '--json'];
            const result = await sandElevation.runElevated(cliPath, args);
            refreshSandStatusBar();
            provider?.postState();
            return result;
        }
        throw e;
    }
}
async function restoreSandPatchFromUi() {
    const accepted = await vscode.window.showWarningMessage(
        '确定按已验证的 manifest 卸载 Sand 并恢复原文件吗？如果 Cursor 已升级、文件被第三方修改或备份损坏，将拒绝进行任何写入。',
        { modal: true },
        '安全卸载 Sand'
    );
    if (accepted !== '安全卸载 Sand')
        return { cancelled: true };
    const appRoot = sandAppRoot();
    const preferred = pickRestoreStateRoot(appRoot);
    const roots = [preferred].concat(knownSandStateRoots().filter((r) => r !== preferred));
    let lastErr = null;
    for (const root of roots) {
        try {
            let result;
            try {
                result = sandPatcher.restoreLatest({ appRoot, stateRoot: root });
            } catch (e) {
                if (isPermissionFailure(e)) {
                    const cliPath = path.join(__dirname, 'sandCli.js');
                    const args = ['restore', '--app-root', appRoot, '--state-root', root, '--json'];
                    result = await sandElevation.runElevated(cliPath, args);
                } else {
                    throw e;
                }
            }
            refreshSandStatusBar();
            provider?.postState();
            return result;
        }
        catch (e) {
            lastErr = e;
        }
    }
    throw lastErr || new Error('没有找到可回滚的备份');
}
function isPermissionFailure(error) {
    const code = String(error && error.code || '');
    const message = String(error && error.message || error || '');
    return code === 'EPERM' || code === 'EACCES' || code === 'EROFS' ||
        /\b(?:EPERM|EACCES|EROFS|permission denied|access denied|read-only file system)\b/i.test(message);
}
function promptSandRestart(kind) {
    provider?.post({
        type: 'retryNeedsRestart',
        message: kind === 'restore'
            ? 'Sand 补丁已按 manifest 校验并安全卸载。必须完整退出 Cursor 再打开，Reload Window 不够。'
            : 'Sand 补丁已写入磁盘。必须完整退出 Cursor 再打开，Reload Window 不会重载主进程。',
        action: 'sandPatch',
        restartCommand: 'restartCursor'
    });
}


