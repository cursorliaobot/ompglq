(function () {
  const vscode = acquireVsCodeApi();
  let state = null;
  let dialog = null;
  let toast = '';
  let toastTimer = null;
  let retryRestart = null;
  let restarting = false;
  let lastRenderSig = '';
  let activeTab = 'accounts';
  let openMenuId = '';
  let operationError = null;

  const app = document.getElementById('app');
  app.innerHTML = '<div class="empty"><div><strong>正在加载账号</strong><span>请稍候...</span></div></div>';

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (data && data.type === 'state') {
      const incoming = data.state;
      const sig = renderSig(incoming);
      if (state && sig === lastRenderSig) { state = incoming; return; }
      state = incoming;
      lastRenderSig = sig;
      render();
    } else if (data && data.type === 'retryNeedsRestart') {
      retryRestart = {
        message: String(data.message || '需要重启 Cursor 才能生效。'),
        action: String(data.action || 'accountSwitch'),
        restartCommand: 'restartCursor'
      };
      toast = '';
      if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
      render();
    } else if (data && data.type === 'restartFailed') {
      restarting = false;
      const restartError = data.error && typeof data.error === 'object'
        ? data.error.message
        : data.error;
      if (retryRestart)
        retryRestart.message = '自动重启没成功：' + String(restartError || '未知错误') + '。请自己完全退出 Cursor 再打开。';
      render();
    } else if (data && data.type === 'restartCancelled') {
      restarting = false;
      render();
    } else if (data && data.type === 'operationError') {
      const detail = data.error && typeof data.error === 'object' ? data.error : {};
      operationError = {
        operation: String(data.operation || '操作'),
        code: String(detail.code || 'OPERATION_FAILED'),
        message: String(detail.message || '操作失败'),
        retryable: detail.retryable === true,
        recoveryRequired: detail.recoveryRequired === true,
        offline: detail.offline === true
      };
      toast = '';
      if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
      render();
    } else if (data && data.type === 'toast') {
      showToast(String(data.text || ''));
    } else if (data && data.type === 'importPreview') {
      dialog = {
        type: 'acctImportPreview',
        fileName: String(data.fileName || ''),
        added: Number(data.added || 0),
        updated: Number(data.updated || 0),
        rows: Array.isArray(data.rows) ? data.rows : []
      };
      render();
    } else if (data && data.type === 'sessions') {
      dialog = {
        type: 'sessions',
        accountId: String(data.accountId || (dialog && dialog.accountId) || ''),
        email: data.email || (dialog && dialog.email) || '',
        sessions: Array.isArray(data.sessions) ? data.sessions : [],
        error: data.error || '',
        loading: false,
        confirmKick: ''
      };
      if (data.toast) showToast(String(data.toast));
      else render();
    } else if (data && data.type === 'sessionActionCancelled') {
      if (dialog && dialog.type === 'sessions' &&
          (!data.accountId || String(data.accountId) === dialog.accountId)) {
        dialog.loading = false;
        dialog.confirmKick = '';
        render();
      }
    }
  });

  function post(type, data) { vscode.postMessage(Object.assign({ type }, data || {})); }
  function currentAccountId() {
    const hit = ((state && state.accounts) || []).find((x) => x.isCurrent);
    return hit ? hit.id : '';
  }

  function renderSig(s) {
    if (!s) return '∅';
    const acc = s.account || {};
    const accts = (s.accounts || []).map((x) => [
      x.id, x.isCurrent ? 1 : 0, x.email || '', x.type || '', x.partial ? 1 : 0,
      x.noRefresh ? 1 : 0, x.userTail || '', x.used == null ? '' : x.used,
      x.limit == null ? '' : x.limit, String(x.usageBased), x.usageError || '',
      x.autoPercent, x.otherPercent, x.botPercent, x.sessionCount, x.cycleEnd || '', x.botResetAt || '', x.note || '',
      x.credentialStatus || ''
    ].join('|')).join(';');
    return [
      acc.email || '', acc.plan || '', acc.planLabel || '', acc.usageShort || '',
      acc.usageText || '', acc.error || '', acc.loading ? 1 : 0, acc.usagePct || 0,
      String(acc.usageBased), String(acc.enabled), accts, s.version || '',
      (s.sand && s.sand.patched) ? 1 : 0, (s.sand && s.sand.sand) || 0, (s.sand && s.sand.unpatched) || 0,
      (s.sand && s.sand.error) || '', (s.sand && s.sand.auto) ? 1 : 0,
      JSON.stringify(s.status || {})
    ].join('¶');
  }

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
  }
  function attr(value) { return esc(value).replace(/'/g, '&#39;').replace(/"/g, '&quot;'); }
  function disabled(flag) { return flag ? ' disabled' : ''; }
  function statusOf(name) { return (state && state.status && state.status[name]) || {}; }
  function writesBlocked() {
    return statusOf('migration').state === 'blocked' || statusOf('recovery').state === 'blocked';
  }
  function stateStoreUnavailable() {
    const stateName = statusOf('recovery').state;
    return stateName === 'blocked' || stateName === 'unavailable' || stateName === 'pending';
  }
  function networkOff() { return statusOf('network').mode === 'off'; }
  function credentialsMissing(x) { return !x || x.credentialStatus !== 'available'; }
  function statusNotice(kind, title, message, extra) {
    return '<div class="statusNotice ' + attr(kind) + '">'
      + '<div><b>' + esc(title) + '</b><span>' + esc(message) + '</span>'
      + (extra ? '<code>' + esc(extra) + '</code>' : '')
      + '</div></div>';
  }
  function statusPanel() {
    const notices = [];
    const network = statusOf('network');
    const migration = statusOf('migration');
    const recovery = statusOf('recovery');
    const credentials = statusOf('credentials');
    const oauth = statusOf('oauth');
    if (operationError) {
      const hint = operationError.recoveryRequired
        ? '需要先恢复未完成事务。'
        : (operationError.offline ? '当前网络策略不允许此请求。' : (operationError.retryable ? '这是可重试错误。' : ''));
      notices.push('<div class="statusNotice error operation">'
        + '<div><b>' + esc(operationError.operation) + '失败</b><span>' + esc(operationError.message) + '</span>'
        + (hint ? '<small>' + esc(hint) + '</small>' : '')
        + '<code>' + esc(operationError.code) + '</code></div>'
        + '<button data-action="dismissError" title="关闭">×</button></div>');
    }
    if (migration.state === 'blocked')
      notices.push(statusNotice('error', '安全迁移被阻止', migration.message || '联网和账号写入已锁定。', 'MIGRATION_BLOCKED'));
    if (recovery.state === 'blocked')
      notices.push(statusNotice('error', '切号恢复失败', recovery.message || '切号与恢复功能已锁定。', 'RECOVERY_BLOCKED'));
    else if (recovery.state === 'unavailable')
      notices.push(statusNotice('warn', '切号功能不可用', recovery.message || '当前没有可用的 SQLite 模块，账号列表仍可只读使用。'));
    else if (recovery.state === 'recovered')
      notices.push(statusNotice('success', '已恢复中断事务', recovery.message || '登录态已经恢复到一致状态。'));
    if (network.mode === 'off')
      notices.push(statusNotice('offline', '离线模式', '所有账号网络请求和后台续期均已关闭。可在设置中修改 Network Mode。'));
    else if (network.mode === 'manual')
      notices.push(statusNotice('info', '手动联网', '只在你点击刷新、授权或设备管理时发起网络请求。'));
    if (credentials.state === 'warning' && credentials.missing > 0)
      notices.push(statusNotice('warn', '凭据不可用', credentials.missing + ' 个账号缺少系统安全存储中的凭据，已禁用相关操作。'));
    if (oauth.state === 'limited')
      notices.push(statusNotice('warn', '浏览器授权受限', oauth.message || 'OAuth 配置无效。'));
    return notices.length ? '<div class="statusStack">' + notices.join('') + '</div>' : '';
  }
  function rel(value) {
    const ms = Date.now() - new Date(value).getTime();
    if (!Number.isFinite(ms)) return '';
    if (ms < 1000) return '刚刚';
    if (ms < 60000) return Math.max(1, Math.floor(ms / 1000)) + '秒前';
    if (ms < 3600000) return Math.floor(ms / 60000) + '分钟前';
    if (ms < 86400000) return Math.floor(ms / 3600000) + '小时前';
    return Math.floor(ms / 86400000) + '天前';
  }
  function isFreePlan(x) { return String(x.type || '').toLowerCase().includes('free'); }
  function pctCls(n) {
    if (n == null || !Number.isFinite(Number(n))) return '';
    const v = Number(n);
    if (v >= 100) return ' full';
    if (v >= 80) return ' hot';
    return '';
  }
  function resetHint(iso) {
    if (!iso) return '';
    const t = new Date(iso).getTime() - Date.now();
    if (!Number.isFinite(t)) return '';
    if (t <= 0) return '今日重置';
    const d = Math.floor(t / 86400000);
    const h = Math.floor((t % 86400000) / 3600000);
    if (d >= 1) return d + '天后重置';
    if (h >= 1) return h + '小时后重置';
    return '即将重置';
  }
  function quotaCol(label, value, hint) {
    const empty = value == null || !Number.isFinite(Number(value));
    const n = empty ? 0 : Math.max(0, Math.min(100, Number(value)));
    const shown = empty ? '—' : ((Math.round(n * 10) / 10) + '%');
    return '<div class="qCol">'
      + '<div class="qTop"><span>' + esc(label) + '</span><i>' + shown + '</i></div>'
      + '<div class="qBar' + (empty ? '' : pctCls(n)) + '"><b style="width:' + (empty ? 0 : n) + '%"></b></div>'
      + '<div class="qHint">' + (hint ? esc(hint) : '') + '</div>'
      + '</div>';
  }
  function acctQuotaRow(x) {
    if (x.usageError) return '<div class="acctLine2"><span class="muted">⚠ ' + esc(x.usageError) + '</span></div>';
    const has = x.autoPercent != null || x.otherPercent != null || x.botPercent != null;
    if (!has) return '<div class="acctLine2"><span class="muted">点刷新读取 Auto / Other / Bot</span></div>';
    const botHint = (x.botHasLimit || x.botPercent != null) ? resetHint(x.botResetAt) : '无周额度';
    return '<div class="quotaRow">'
      + quotaCol('Auto', x.autoPercent, resetHint(x.cycleEnd))
      + quotaCol('Other', x.otherPercent, '')
      + quotaCol('Grok Bot', (x.botHasLimit || x.botPercent != null) ? x.botPercent : null, botHint)
      + '</div>';
  }
  function acctPlanBadge(x) {
    const p = String((x && (x.type || x.plan || x.planLabel)) || '').toLowerCase();
    if (!p) return '';
    let label = x.type || x.planLabel || x.plan, cls = 'other';
    if (p.includes('free')) { label = 'Free'; cls = 'free'; }
    else if (p.includes('ultra')) { label = 'Ultra'; cls = 'ultra'; }
    else if (p.includes('pro')) { label = 'Pro'; cls = 'pro'; }
    else if (p.includes('business') || p.includes('team') || p.includes('enterprise')) { label = 'Business'; cls = 'biz'; }
    return '<span class="tag plan ' + cls + '">' + esc(label) + '</span>';
  }
  function acctNoteBadge(x) {
    const note = String((x && x.note) || '').trim();
    if (!note) return '';
    return '<span class="tag note" title="' + attr(note) + '">' + esc(note) + '</span>';
  }
  function acctOverageToggle(x) {
    if (isFreePlan(x)) return '';
    const on = x.usageBased === true;
    const label = on ? '超额开' : '超额关';
    const title = on ? '点击关闭超额' : '点击开启无限超额';
    const locked = writesBlocked() || networkOff() || credentialsMissing(x);
    return '<button class="acctOverage' + (on ? ' on' : '') + '" data-action="acctOverageToggle" data-id="' + attr(x.id) + '" data-mode="' + (on ? 'disabled' : 'unlimited') + '" title="' + attr(title) + '"' + disabled(locked) + '><span></span>' + label + '</button>';
  }
  function moreMenu(x) {
    const open = openMenuId === x.id;
    const missing = credentialsMissing(x);
    const locked = writesBlocked();
    const offline = networkOff();
    const canRenew = !(x.noRefresh || x.tokenType === 'web') && !missing;
    return '<div class="moreWrap">'
      + '<button class="toolBtn moreBtn" data-action="acctMore" data-id="' + attr(x.id) + '" title="更多">更多</button>'
      + (open ? '<div class="moreMenu" data-stop="1">'
        + (canRenew ? '<button data-action="acctRefreshToken" data-id="' + attr(x.id) + '"' + disabled(locked || offline) + '>令牌续期</button>' : '')
        + '<button data-action="acctNote" data-id="' + attr(x.id) + '"' + disabled(locked) + '>添加备注</button>'
        + '<button data-action="acctCopyToken" data-id="' + attr(x.id) + '"' + disabled(missing) + '>复制 Token</button>'
        + '<button data-action="acctDashboard" data-id="' + attr(x.id) + '"' + disabled(offline || missing) + '>进控制台</button>'
        + '<button data-action="acctSessions" data-id="' + attr(x.id) + '"' + disabled(offline || missing) + '>查看设备</button>'
        + '<button data-action="acctSwitch" data-id="' + attr(x.id) + '"' + disabled(locked || stateStoreUnavailable() || missing) + '>切换账号</button>'
        + '<button class="danger" data-action="acctRemove" data-id="' + attr(x.id) + '"' + disabled(locked) + '>从列表移除</button>'
      + '</div>' : '')
      + '</div>';
  }

  function accountCards() {
    const accts = (state && state.accounts) || [];
    if (!accts.length) return '<div class="acctEmpty">暂无账号。用上方三个按钮添加。</div>';
    return accts.map(function (x) {
      const isWeb = (x.tokenType === 'web' || x.noRefresh) && x.source !== 'currentLogin';
      const missing = credentialsMissing(x);
      const tags = (acctPlanBadge(x) + acctNoteBadge(x)).trim();
      return '<div class="acctCard' + (x.isCurrent ? ' cur' : '') + '">'
        + '<div class="acctTop">'
          + '<button class="acctEmail" data-action="acctCopyEmail" data-id="' + attr(x.id) + '" title="点击复制邮箱">' + esc(x.email || '(未知邮箱)') + '</button>'
          + '<div class="acctTools">'
            + '<button class="toolBtn" data-action="acctRefreshOne" data-id="' + attr(x.id) + '" title="刷新该账号额度"' + disabled(networkOff() || missing) + '>刷新</button>'
            + acctOverageToggle(x)
            + moreMenu(x)
          + '</div>'
        + '</div>'
        + (tags ? '<div class="acctTags">' + tags + '</div>' : '')
        + acctQuotaRow(x)
        + (isWeb ? '<div class="acctWarn">Web 令牌只读、无法续期，发消息可能弹登录框</div>' : '')
        + (missing ? '<div class="acctWarn danger">系统安全存储中的凭据不可用，已禁用敏感操作</div>' : '')
      + '</div>';
    }).join('');
  }

  function tabBar() {
    return '<div class="tabs">'
      + '<button class="tab' + (activeTab === 'accounts' ? ' on' : '') + '" data-action="switchTab" data-tab="accounts">账号管理</button>'
      + '<button class="tab' + (activeTab === 'grok' ? ' on' : '') + '" data-action="switchTab" data-tab="grok">Grok Bot</button>'
      + '<span class="ver">' + esc((state && state.version) || '') + '</span>'
      + '</div>';
  }

  function accountsPage() {
    const accts = (state && state.accounts) || [];
    const blocked = writesBlocked();
    const offline = networkOff();
    const incompleteBackup = accts.some(credentialsMissing);
    return '<div class="page">'
      + '<div class="acctAddRow">'
        + '<button class="btn primary acctAddBtn" data-action="acctDeepLogin"' + disabled(blocked || offline) + '>浏览器授权</button>'
        + '<button class="btn acctAddBtn" data-action="acctTokenDialog"' + disabled(blocked || offline) + '>Token 导入</button>'
        + '<button class="btn acctAddBtn" data-action="acctAddCurrent" title="读取本机 Cursor 当前登录态"' + disabled(blocked) + '>导入本机</button>'
      + '</div>'
      + '<div class="acctAddRow acctBackupRow">'
        + '<button class="btn acctAddBtn" data-action="acctExportAll" title="' + attr(incompleteBackup ? '存在凭据不可用的账号，禁止生成不完整备份' : '导出密码加密的 JSON 备份') + '"' + disabled(!accts.length || incompleteBackup) + '>导出备份</button>'
        + '<button class="btn acctAddBtn" data-action="acctImportAll" title="从 JSON 备份导入，同号会更新"' + disabled(blocked) + '>导入备份</button>'
      + '</div>'
      + '<p class="acctAddHint">推荐浏览器授权（可续期）。切换后必须完整退出 Cursor 再打开，Reload 不够。导出默认使用 scrypt + AES-256-GCM 加密，仍请妥善保管。</p>'
      + '<div class="acctSecHead"><h4>账号列表</h4><span class="acctCount">' + accts.length + '</span></div>'
      + '<div class="acctList">' + accountCards() + '</div>'
      + '</div>';
  }

  function grokBotRows() {
    const accts = (state && state.accounts) || [];
    if (!accts.length) return '<div class="acctEmpty">先在「账号管理」里加号，再看各账号 Bot 额度。</div>';
    return accts.map(function (x) {
      const hint = (x.botHasLimit || x.botPercent != null) ? resetHint(x.botResetAt) : '无周额度';
      return '<div class="botRow' + (x.isCurrent ? ' cur' : '') + '">'
        + '<button class="acctEmail" data-action="acctCopyEmail" data-id="' + attr(x.id) + '" title="点击复制邮箱">' + esc(x.email || '(未知)') + '</button>'
        + quotaCol('Grok Bot', (x.botHasLimit || x.botPercent != null) ? x.botPercent : null, hint)
        + '</div>';
    }).join('');
  }

  function sandCard() {
    const s = (state && state.sand) || {};
    const on = !!s.patched && !s.error;
    const badge = s.error ? '异常' : (on ? '已注入' : ((s.sand || 0) > 0 ? '部分注入' : '未注入'));
    const badgeCls = s.error ? 'err' : (on ? 'on' : ((s.sand || 0) > 0 ? 'warn' : 'off'));
    const detail = s.error
      ? esc(s.error)
      : (on
        ? ('已注入 · Cursor ' + esc(s.version || '?') + ' · ' + esc(s.sand || 0) + ' 处请求头为 sand')
        : ((s.sand || 0) > 0
          ? ('部分注入 · 已改 ' + esc(s.sand || 0) + ' / 未改 ' + esc(s.unpatched || 0))
          : ('未注入 · 还有 ' + esc(s.unpatched || 0) + ' 处仍是 ide')));
    return '<div class="sandCard' + (on ? ' on' : '') + '">'
      + '<div class="sandHead"><h4>Sand 注入</h4><span class="sandBadge ' + badgeCls + '">' + badge + '</span></div>'
      + '<p class="sandHint">注入后 Cursor 请求头变成 <code>sand</code>，对话走 Bot 额度，才能选 Grok Bot。写完必须完整退出再打开。</p>'
      + '<p class="sandRisk">风险：此操作会修改 Cursor 安装完整性，可能触发更新、兼容性或账号风控问题。' + esc(s.residualRisk || '内置提权是尽力加固，不能替代受系统保护的签名原生 Helper。') + '</p>'
      + '<div class="sandBtns">'
        + '<button class="btn primary" data-action="sandApplyAsk"' + (on ? ' disabled' : '') + '>一键注入</button>'
        + '<button class="btn danger" data-action="sandRestoreAsk">一键卸载</button>'
        + '<button class="btn" data-action="sandRefresh">刷新状态</button>'
      + '</div>'
      + '<div class="sandMeta">' + detail + '</div>'
      + '</div>';
  }

  function grokPage() {
    return '<div class="page">'
      + sandCard()
      + '<div class="acctSecHead"><h4>各账号 Bot 额度</h4></div>'
      + '<div class="botList">' + grokBotRows() + '</div>'
      + '</div>';
  }

  function backupPreviewList(rows, mode) {
    if (!rows.length) return '<p class="dialogHint">没有账号</p>';
    return '<div class="prevList">' + rows.map(function (x) {
      const kind = mode === 'import' ? (x.action === 'update' ? '更新' : '新增') : (x.tokenType === 'web' ? 'web' : '可续期');
      const cls = mode === 'import' ? (x.action === 'update' ? 'upd' : 'add') : (x.tokenType === 'web' ? 'upd' : 'add');
      return '<div class="prevRow">'
        + '<div><b>' + esc(x.email || '(未知邮箱)') + '</b>'
        + '<span>' + (x.note ? esc(x.note) + ' · ' : '') + (x.userTail ? '…' + esc(x.userTail) : '') + '</span></div>'
        + '<span class="prevAct ' + cls + '">' + esc(kind) + '</span>'
        + '</div>';
    }).join('') + '</div>';
  }

  function dialogHtml() {
    if (!dialog) return '';
    if (dialog.type === 'confirmSandApply') {
      return '<div class="modal" data-action="cancelDialog"><div class="dialog" data-stop="1"><h3>注入 Sand</h3>'
        + '<p class="restartMsg">会改 Cursor 安装目录里的请求头 <code>x-cursor-client-type</code> 为 <code>sand</code>，先备份再写。写完必须完整退出再打开，Reload 不够。</p>'
        + '<p class="riskConfirm">这会破坏 Cursor 原始安装完整性，并可能带来兼容、更新及账号风控风险。内置提权无法替代签名原生 Helper，也不能完全消除同用户进程替换提权代码的风险。</p>'
        + '<div class="dialogActions"><button class="btn" data-action="cancelDialog">取消</button><button class="btn primary" data-action="sandApplyConfirm">一键注入</button></div></div></div>';
    }
    if (dialog.type === 'confirmSandRestore') {
      return '<div class="modal" data-action="cancelDialog"><div class="dialog" data-stop="1"><h3>卸载 Sand</h3>'
        + '<p class="restartMsg">仅当备份、版本、commit 和当前文件哈希全部匹配时才会还原；任何冲突都会零写入。卸完必须完整退出再打开，Reload 不够。</p>'
        + '<p class="riskConfirm">恢复也可能需要内置提权；它是尽力加固方案，不能替代受系统保护的签名原生 Helper。</p>'
        + '<div class="dialogActions"><button class="btn" data-action="cancelDialog">取消</button><button class="btn danger" data-action="sandRestoreConfirm">一键卸载</button></div></div></div>';
    }
    if (dialog.type === 'confirmSwitch') {
      return '<div class="modal" data-action="cancelDialog"><div class="dialog" data-stop="1"><h3>切换账号</h3>'
        + '<p class="restartMsg">确定切换 Cursor 全局登录账号到 ' + esc(dialog.email || dialog.id || '') + ' 吗？会自动备份并替换登录态，完成后需要完整重启 Cursor。当前已是该号也可以再切一次。</p>'
        + '<div class="dialogActions"><button class="btn" data-action="cancelDialog">取消</button><button class="btn primary" data-action="confirmAccountSwitch">切换账号</button></div></div></div>';
    }
    if (dialog.type === 'confirmOverage') {
      const closing = dialog.mode === 'disabled';
      const who = dialog.email || dialog.id || '该账号';
      const title = closing ? '关闭超额' : '开启超额';
      const body = closing
        ? '确定关闭 ' + esc(who) + ' 的超额吗？关闭后套餐额度用完就不能再超量使用。'
        : '确定给 ' + esc(who) + ' 开启无限超额吗？套餐额度用完后会继续按用量计费，可能产生额外费用。';
      const okCls = closing ? 'btn danger' : 'btn primary';
      const okLabel = closing ? '关闭超额' : '开启无限超额';
      return '<div class="modal" data-action="cancelDialog"><div class="dialog" data-stop="1"><h3>' + title + '</h3>'
        + '<p class="restartMsg">' + body + '</p>'
        + '<div class="dialogActions"><button class="btn" data-action="cancelDialog">取消</button><button class="' + okCls + '" data-action="acctOverageConfirm">' + okLabel + '</button></div></div></div>';
    }
    if (dialog.type === 'acctNote') {
      return '<div class="modal" data-action="cancelDialog"><div class="dialog" data-stop="1"><h3>账号备注</h3>'
        + '<p class="dialogHint">给 ' + esc(dialog.email || '该账号') + ' 加个短标签，会显示在邮箱旁边。最多 24 字，留空等于清除。</p>'
        + '<input id="acctNoteText" class="dialogInput" maxlength="24" placeholder="例如：主力、备用、公司号" value="' + attr(dialog.draft || '') + '">'
        + '<div class="dialogActions">'
          + '<button class="btn" data-action="cancelDialog">取消</button>'
          + (String(dialog.draft || '').trim() ? '<button class="btn danger" data-action="acctNoteClear">清除</button>' : '')
          + '<button class="btn primary" data-action="acctNoteConfirm">保存备注</button>'
        + '</div></div></div>';
    }
    if (dialog.type === 'acctExportPreview') {
      const rows = dialog.rows || [];
      return '<div class="modal" data-action="cancelDialog"><div class="dialog wide" data-stop="1"><h3>导出预览</h3>'
        + '<p class="dialogHint">将导出 <b>' + rows.length + '</b> 个账号到密码加密 JSON（scrypt + AES-256-GCM）。弱密码仍可能被离线猜解，请勿上传或分享。</p>'
        + backupPreviewList(rows, 'export')
        + '<div class="dialogActions"><button class="btn" data-action="cancelDialog">取消</button><button class="btn primary" data-action="acctExportConfirm">导出到文件</button></div></div></div>';
    }
    if (dialog.type === 'acctImportPreview') {
      const rows = dialog.rows || [];
      return '<div class="modal" data-action="cancelDialog"><div class="dialog wide" data-stop="1"><h3>导入预览</h3>'
        + '<p class="dialogHint">' + (dialog.fileName ? esc(dialog.fileName) + ' · ' : '') + '共 ' + rows.length + ' 个 · 新增 ' + (dialog.added || 0) + ' · 更新 ' + (dialog.updated || 0) + '。确认后才写入，列表不会先被清空。</p>'
        + backupPreviewList(rows, 'import')
        + '<div class="dialogActions"><button class="btn" data-action="acctImportCancel">取消</button><button class="btn primary" data-action="acctImportConfirmAll">确认导入</button></div></div></div>';
    }
    if (dialog.type === 'acctImport') {
      return '<div class="modal" data-action="cancelDialog"><div class="dialog wide" data-stop="1"><h3>Token 导入账号</h3>'
        + '<p class="dialogHint">粘贴 <code>userId::accessToken</code> 或 <code>WorkosCursorSessionToken=...</code>。带第三段 <code>refreshToken</code> 的可自动续期。</p>'
        + '<textarea id="acctImportText" rows="7" placeholder="userId::accessToken::refreshToken 或 WorkosCursorSessionToken=...">' + esc(dialog.draft || '') + '</textarea>'
        + '<div class="dialogActions"><button class="btn" data-action="cancelDialog">取消</button><button class="btn primary" data-action="acctImportConfirm">导入账号</button></div></div></div>';
    }
    if (dialog.type === 'sessions') {
      const rows = dialog.sessions || [];
      const kick = dialog.confirmKick;
      const list = dialog.loading
        ? '<p class="dialogHint">正在读取登录设备…</p>'
        : (dialog.error ? '<p class="dialogHint err">' + esc(dialog.error) + '</p>' : '')
          + (rows.length ? rows.map(function (s) {
            return '<div class="sessRow">'
              + '<div><b>' + esc(s.typeLabel || s.type || '设备') + '</b>'
              + '<span>' + esc(s.createdAt ? (rel(s.createdAt) + '创建') : '') + '</span></div>'
              + '<button class="btn sm danger" data-action="acctRevokeAsk" data-sid="' + attr(s.sessionId) + '">踢下线</button>'
              + '</div>';
          }).join('') : (!dialog.error && !dialog.loading ? '<p class="dialogHint">当前没有登录设备</p>' : ''));
      const confirm = kick ? '<div class="kickWarn"><p>确定踢掉这台设备？踢下线最多约 10 分钟生效。'
        + (rows.length <= 1 ? ' 这可能是当前网页会话，踢掉后额度接口会失效，需重新导入。' : '')
        + '</p><div class="dialogActions"><button class="btn" data-action="acctRevokeCancel">取消</button>'
        + '<button class="btn danger" data-action="acctRevokeConfirm" data-sid="' + attr(kick) + '">确认踢下线</button></div></div>' : '';
      return '<div class="modal" data-action="cancelDialog"><div class="dialog wide" data-stop="1"><h3>登录设备</h3>'
        + '<p class="dialogHint">' + esc(dialog.email || '') + ' · ' + rows.length + ' 台</p>'
        + list + confirm
        + '<p class="dialogHint">对应 dashboard Settings → Active Sessions。踢下线后最多 10 分钟生效。</p>'
        + '<div class="dialogActions"><button class="btn" data-action="cancelDialog">关闭</button></div></div></div>';
    }
    return '';
  }

  function retryRestartHtml() {
    if (!retryRestart) return '';
    const restartTitle = restarting ? '正在重启' : ((retryRestart.action === 'sandPatch') ? '需要完整重启' : '切换成功');
    const hint = restarting
      ? '已在结束 Cursor 进程，结束后会自动再打开。不要点 Reload Window。'
      : '点「立即重启」会退出整个 Cursor 再自动打开，不是 Reload Window。也可以自己完全退出后再开。';
    return '<div class="modal restartModal" data-stop="1"><div class="dialog restartDialog" data-stop="1"><h3>' + restartTitle + '</h3>'
      + '<p class="restartMsg">' + esc(restarting ? '正在退出并重新打开 Cursor…' : (retryRestart.message || '需要重启 Cursor 才能生效。')) + '</p>'
      + '<p class="dialogHint">' + hint + '</p>'
      + '<div class="dialogActions restartActions">'
        + (restarting ? '<button class="btn primary" disabled>正在重启…</button>'
          : '<button class="btn" data-action="retryRestartLater">稍后自己退出</button><button class="btn primary" data-action="retryRestartNow">立即重启</button>')
      + '</div></div></div>';
  }

  function render() {
    if (!state) return;
    app.innerHTML = '<div class="app">'
      + tabBar()
      + statusPanel()
      + (activeTab === 'grok' ? grokPage() : accountsPage())
      + dialogHtml()
      + retryRestartHtml()
      + (toast ? '<div class="toast">' + esc(toast) + '</div>' : '')
      + '</div>';
    bind();
  }

  let bound = false;
  let ignoreMenuClose = false;
  function bind() {
    const acctImportText = document.getElementById('acctImportText');
    if (acctImportText) acctImportText.addEventListener('input', (e) => {
      if (dialog && dialog.type === 'acctImport') dialog.draft = String(e.target.value || '');
    });
    const acctNoteText = document.getElementById('acctNoteText');
    if (acctNoteText) acctNoteText.addEventListener('input', (e) => {
      if (dialog && dialog.type === 'acctNote') dialog.draft = String(e.target.value || '');
    });
    if (bound) return;
    bound = true;
    app.addEventListener('click', (e) => {
      const el = e.target.closest && e.target.closest('[data-action]');
      if (!el || !app.contains(el)) return;
      const action = el.getAttribute('data-action');
      const stop = e.target.closest && e.target.closest('[data-stop]');
      if ((action === 'cancelDialog') && stop && e.target !== el) return;
      e.stopPropagation();
      handleAction(action, el);
    });
    document.addEventListener('click', onDocClick);
  }

  function onDocClick(e) {
    if (ignoreMenuClose || !openMenuId) return;
    if (e.target.closest && (e.target.closest('.moreWrap') || e.target.closest('.modal'))) return;
    openMenuId = '';
    render();
  }

  function handleAction(action, el) {
    switch (action) {
      case 'dismissError':
        operationError = null;
        render();
        break;
      case 'switchTab':
        activeTab = el.getAttribute('data-tab') === 'grok' ? 'grok' : 'accounts';
        openMenuId = '';
        render();
        break;
      case 'acctMore': {
        const id = el.getAttribute('data-id') || '';
        openMenuId = openMenuId === id ? '' : id;
        ignoreMenuClose = true;
        render();
        setTimeout(() => { ignoreMenuClose = false; }, 0);
      } break;
      case 'acctDashboard':
        post('openDashboard', { id: el.getAttribute('data-id') });
        openMenuId = '';
        showToast('正在打开隔离浏览器并注入该账号…');
        break;
      case 'refreshAccount': post('refreshAccount'); showToast('正在刷新当前用量...'); break;
      case 'openDashboard': post('openDashboard'); break;
      case 'acctTokenDialog': dialog = { type: 'acctImport', draft: '' }; render(); break;
      case 'acctImportConfirm': {
        const t = document.getElementById('acctImportText');
        const latest = t ? String(t.value || '').trim() : '';
        if (!latest) { showToast('请粘贴 token'); break; }
        post('accountAddToken', { token: latest });
        showToast('正在导入账号...');
        dialog = null;
        render();
      } break;
      case 'acctExportAll': {
        const rows = ((state && state.accounts) || []).map(function (x) {
          return { email: x.email || '(未知邮箱)', userTail: x.userTail || '', note: x.note || '', tokenType: x.tokenType || (x.noRefresh ? 'web' : 'client') };
        });
        if (!rows.length) { showToast('没有可导出的账号'); break; }
        dialog = { type: 'acctExportPreview', rows: rows };
        render();
      } break;
      case 'acctExportConfirm':
        dialog = null;
        post('accountExportAll');
        showToast('选择保存位置…');
        render();
        break;
      case 'acctImportAll':
        post('accountImportAll');
        showToast('选择备份 JSON…');
        break;
      case 'acctImportConfirmAll':
        dialog = null;
        post('accountImportConfirm');
        showToast('正在导入…');
        render();
        break;
      case 'acctImportCancel':
        dialog = null;
        post('accountImportCancel');
        render();
        break;
      case 'acctDeepLogin': post('accountDeepLogin', {}); showToast('即将打开浏览器登录 Cursor...'); break;
      case 'acctUpgradeToken': openMenuId = ''; post('accountUpgradeToken', { id: el.getAttribute('data-id') }); showToast('即将打开浏览器升级该账号...'); break;
      case 'acctAddCurrent': post('accountAddCurrent', {}); showToast('正在读取本机 Cursor 登录态...'); break;
      case 'acctRefreshToken': openMenuId = ''; post('accountRefreshToken', { id: el.getAttribute('data-id') }); showToast('正在续期该账号令牌...'); break;
      case 'acctSwitch': {
        const id = el.getAttribute('data-id');
        const acc = (state.accounts || []).find((x) => x.id === id) || {};
        openMenuId = '';
        dialog = { type: 'confirmSwitch', id, email: acc.email || '' };
        render();
      } break;
      case 'confirmAccountSwitch':
        if (dialog && dialog.type === 'confirmSwitch') {
          post('accountSwitch', { id: dialog.id, confirmed: true });
          showToast('正在切换账号...');
        }
        dialog = null;
        render();
        break;
      case 'acctCopyEmail': {
        const id = el.getAttribute('data-id') || '';
        const acc = (state.accounts || []).find((x) => x.id === id) || {};
        const email = String(acc.email || '').trim();
        openMenuId = '';
        if (!email || email === '(未知邮箱)' || email === '(未知)') {
          showToast('没有邮箱可复制');
          break;
        }
        post('copyText', { text: email });
        showToast('已复制邮箱');
      } break;
      case 'acctCopyToken': {
        const id = el.getAttribute('data-id') || '';
        openMenuId = '';
        post('accountCopyToken', { id });
        showToast('等待宿主确认复制 Token…');
      } break;
      case 'acctNote': {
        const id = el.getAttribute('data-id') || '';
        const acc = (state.accounts || []).find((x) => x.id === id) || {};
        openMenuId = '';
        dialog = { type: 'acctNote', id, email: acc.email || '', draft: String(acc.note || '') };
        render();
      } break;
      case 'acctNoteConfirm':
        if (dialog && dialog.type === 'acctNote') {
          const t = document.getElementById('acctNoteText');
          const latest = t ? String(t.value || '') : String(dialog.draft || '');
          post('accountSetNote', { id: dialog.id, note: latest });
          dialog = null;
          showToast('正在保存备注…');
          render();
        }
        break;
      case 'acctNoteClear':
        if (dialog && dialog.type === 'acctNote') {
          post('accountSetNote', { id: dialog.id, note: '' });
          dialog = null;
          showToast('正在清除备注…');
          render();
        }
        break;
      case 'acctRemove': openMenuId = ''; post('accountRemove', { id: el.getAttribute('data-id') }); showToast('等待宿主确认删除账号…'); break;
      case 'acctRefreshOne': post('accountRefreshOne', { id: el.getAttribute('data-id') }); showToast('正在联网刷新该账号...'); break;
      case 'acctSessions': {
        const id = el.getAttribute('data-id') || currentAccountId();
        const acc = (state.accounts || []).find((x) => x.id === id) || {};
        openMenuId = '';
        dialog = { type: 'sessions', accountId: id, email: acc.email || '', sessions: [], loading: true, error: '', confirmKick: '' };
        post('accountListSessions', { id });
        render();
      } break;
      case 'acctRevokeAsk':
        if (dialog && dialog.type === 'sessions') { dialog.confirmKick = el.getAttribute('data-sid') || ''; render(); }
        break;
      case 'acctRevokeCancel':
        if (dialog && dialog.type === 'sessions') { dialog.confirmKick = ''; render(); }
        break;
      case 'acctRevokeConfirm':
        if (dialog && dialog.type === 'sessions') {
          const sid = el.getAttribute('data-sid') || dialog.confirmKick || '';
          dialog.loading = true;
          dialog.confirmKick = '';
          post('accountRevokeSession', { id: dialog.accountId, sessionId: sid });
          showToast('正在踢下线...');
          render();
        }
        break;
      case 'sandApplyAsk': dialog = { type: 'confirmSandApply' }; render(); break;
      case 'sandApplyConfirm': dialog = null; post('sandApply'); showToast('正在注入 Sand...'); render(); break;
      case 'sandRestoreAsk': dialog = { type: 'confirmSandRestore' }; render(); break;
      case 'sandRestoreConfirm': dialog = null; post('sandRestore'); showToast('正在卸载 Sand...'); render(); break;
      case 'sandRefresh': post('sandRefresh'); showToast('正在读取 Sand 状态...'); break;
      case 'acctOverageToggle': {
        const id = el.getAttribute('data-id') || '';
        const mode = el.getAttribute('data-mode') || 'unlimited';
        const acc = (state.accounts || []).find((x) => x.id === id) || {};
        dialog = { type: 'confirmOverage', id, mode, email: acc.email || '' };
        render();
      } break;
      case 'acctOverageConfirm':
        if (dialog && dialog.type === 'confirmOverage') {
          const closing = dialog.mode === 'disabled';
          post('accountSetHardLimit', { id: dialog.id, mode: dialog.mode || 'unlimited', confirmed: true });
          dialog = null;
          showToast(closing ? '正在关闭超额...' : '正在开启无限超额...');
          render();
        }
        break;
      case 'cancelDialog':
        if (dialog && dialog.type === 'acctImportPreview')
          post('accountImportCancel');
        dialog = null;
        render();
        break;
      case 'retryRestartLater': retryRestart = null; restarting = false; render(); break;
      case 'retryRestartNow':
        if (restarting) break;
        restarting = true;
        if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
        toast = '';
        post('restartCursor');
        render();
        break;
    }
  }

  function showToast(text) {
    if (retryRestart || restarting) return;
    toast = text;
    render();
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast = ''; render(); }, 2200);
  }

  post('ready');
})();
