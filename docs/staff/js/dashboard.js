var GAS_URL = 'https://script.google.com/macros/s/AKfycby2iYCqY-8ewAC0uMITrhjxNqe_toZEXLySC6dQNvuA371a8pX41d6Xxn3N1ayHW_W5/exec';

// ===== 状態 =====
var state = {
  token:          null,
  yearMonth:      null,
  selectedDriver: null,
  exportData:     null,
};

// ===== 初期化 =====
document.addEventListener('DOMContentLoaded', function() {
  var now = new Date();
  var ym  = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
  document.getElementById('input-yearmonth').value = ym;
  state.yearMonth = ym;

  var savedToken = sessionStorage.getItem('adminToken');
  if (savedToken) {
    state.token = savedToken;
    showScreen('main');
    loadDashboard();
  }

  setupEvents();
});

function setupEvents() {
  document.getElementById('btn-login').addEventListener('click', handleLogin);
  document.getElementById('input-token').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') handleLogin();
  });

  document.getElementById('btn-logout').addEventListener('click', function() {
    sessionStorage.removeItem('adminToken');
    state.token = null;
    showScreen('login');
  });

  document.getElementById('input-yearmonth').addEventListener('change', function(e) {
    state.yearMonth = e.target.value;
    loadDashboard();
  });

  document.getElementById('btn-refresh').addEventListener('click', loadDashboard);

  document.getElementById('btn-back-to-list').addEventListener('click', function() {
    showScreen('main');
    loadDashboard();
  });

  document.getElementById('btn-save-correction').addEventListener('click', handleSaveCorrection);
  document.getElementById('btn-confirm-month').addEventListener('click', handleConfirmMonth);

  document.getElementById('btn-export').addEventListener('click', handleExport);
  document.getElementById('btn-modal-close').addEventListener('click', closeModal);
  document.getElementById('modal-overlay').addEventListener('click', closeModal);
  document.getElementById('btn-download-csv').addEventListener('click', downloadCsv);
}

// ===== ログイン =====
function handleLogin() {
  var token = document.getElementById('input-token').value.trim();
  if (!token) return;

  // トークン確認のためにoverview APIを叩く
  adminPost({ action: 'adminGetOverview', adminToken: token, yearMonth: state.yearMonth })
    .then(function() {
      state.token = token;
      sessionStorage.setItem('adminToken', token);
      document.getElementById('login-error').classList.add('hidden');
      showScreen('main');
      loadDashboard();
    })
    .catch(function() {
      document.getElementById('login-error').classList.remove('hidden');
    });
}

// ===== ダッシュボード読み込み =====
function loadDashboard() {
  var ym = state.yearMonth;

  adminPost({ action: 'adminGetOverview', adminToken: state.token, yearMonth: ym })
    .then(function(res) {
      document.getElementById('stat-total').textContent     = res.stats.total;
      document.getElementById('stat-pending').textContent   = res.stats.pending;
      document.getElementById('stat-confirmed').textContent = res.stats.confirmed;
      document.getElementById('stat-error').textContent     = res.stats.ocrError;
    });

  adminPost({ action: 'adminGetDriverList', adminToken: state.token, yearMonth: ym })
    .then(function(res) { renderDriverTable(res.drivers); });
}

// ===== ドライバー一覧レンダリング =====
function renderDriverTable(drivers) {
  var tbody = document.getElementById('driver-tbody');
  if (!drivers.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-cell">この月の提出データはありません</td></tr>';
    return;
  }

  tbody.innerHTML = drivers.map(function(d) {
    var badgeClass  = 'badge-' + d.status;
    var billingText = d.billingAmount ? '¥' + d.billingAmount.toLocaleString() : '-';
    var ocrTime     = d.ocrTime ? d.ocrTime.replace('T', ' ').substring(0, 16) : '-';
    var btnLabel    = d.isConfirmed ? '確認済み' : '確認する';
    var btnDisabled = d.status !== '確認待ち' && d.status !== '確定' ? 'disabled' : '';
    return [
      '<tr>',
      '<td><strong>' + escHtml(d.driverName) + '</strong></td>',
      '<td>' + escHtml(d.site) + '</td>',
      '<td>' + (d.workingDays || '-') + ' 日</td>',
      '<td>' + billingText + '</td>',
      '<td><span class="badge ' + badgeClass + '">' + d.status + '</span></td>',
      '<td style="color:var(--text-sub);font-size:12px">' + ocrTime + '</td>',
      '<td><button class="btn btn-sm btn-outline btn-review" ' + btnDisabled +
          ' data-uid="' + escHtml(d.lineUserId) + '"' +
          ' data-name="' + escHtml(d.driverName) + '">' + btnLabel + '</button></td>',
      '</tr>',
    ].join('');
  }).join('');

  // 確認ボタンのイベントを一括登録
  tbody.querySelectorAll('.btn-review').forEach(function(btn) {
    btn.addEventListener('click', function() {
      openOcrScreen(btn.dataset.uid, btn.dataset.name);
    });
  });
}

// ===== OCR確認画面 =====
function openOcrScreen(lineUserId, driverName) {
  state.selectedDriver = { lineUserId: lineUserId, driverName: driverName };
  document.getElementById('ocr-header-title').textContent = driverName + '　' + state.yearMonth;
  document.getElementById('btn-confirm-month').disabled = true;

  adminPost({
    action:      'adminGetOcrDetail',
    adminToken:  state.token,
    lineUserId:  lineUserId,
    yearMonth:   state.yearMonth,
  }).then(function(res) {
    document.getElementById('ocr-file-link').href = res.fileUrl || '#';
    renderOcrTable(res.days, res.driver);
    showScreen('ocr');
  });
}

function renderOcrTable(days, driver) {
  var unitPrice = driver.unitPrice || 0;
  var tbody     = document.getElementById('ocr-tbody');

  tbody.innerHTML = days.map(function(d) {
    var displayStart = d.fixedStart || d.start || '';
    var displayEnd   = d.fixedEnd   || d.end   || '';
    var isWorking    = displayStart !== '';
    var dotClass     = isWorking ? 'yes' : 'no';
    var startModified = d.fixedStart ? ' modified' : '';
    var endModified   = d.fixedEnd   ? ' modified' : '';
    var expenseHtml  = d.expenseFlag ? '<span class="flag-badge expense" title="立替経費あり">￥</span>' : '';
    var noteHtml     = d.noteFlag    ? '<span class="flag-badge note"    title="備考あり">📝</span>'    : '';
    return [
      '<tr>',
      '<td style="font-weight:600;color:var(--text-sub)">' + d.day + '</td>',
      '<td><input type="text" class="time-input' + startModified + '" data-day="' + d.day + '" data-field="start"' +
          ' value="' + displayStart + '" placeholder="--:--"></td>',
      '<td><input type="text" class="time-input' + endModified   + '" data-day="' + d.day + '" data-field="end"' +
          ' value="' + displayEnd + '" placeholder="--:--"></td>',
      '<td><span class="working-dot ' + dotClass + '"></span></td>',
      '<td>' + expenseHtml + '</td>',
      '<td>' + noteHtml + '</td>',
      '</tr>',
    ].join('');
  }).join('');

  // 入力変更時に稼働ドットと集計をリアルタイム更新
  tbody.querySelectorAll('.time-input').forEach(function(input) {
    input.addEventListener('input', function() {
      input.classList.add('modified');
      updateOcrSummary(unitPrice);
    });
  });

  updateOcrSummary(unitPrice);
  document.getElementById('btn-confirm-month').disabled = false;
}

function updateOcrSummary(unitPrice) {
  var rows      = document.querySelectorAll('#ocr-tbody tr');
  var working   = 0;
  rows.forEach(function(row) {
    var startInput = row.querySelector('[data-field="start"]');
    var dotEl      = row.querySelector('.working-dot');
    if (!startInput) return;
    var isWorking = startInput.value.trim() !== '';
    if (isWorking) working++;
    if (dotEl) {
      dotEl.className = 'working-dot ' + (isWorking ? 'yes' : 'no');
    }
  });
  document.getElementById('ocr-working-days').textContent = working;
  document.getElementById('ocr-billing').textContent = '¥' + (working * unitPrice).toLocaleString();
}

// ===== 修正保存 =====
function handleSaveCorrection() {
  var corrections = [];
  document.querySelectorAll('#ocr-tbody tr').forEach(function(row) {
    var startInput = row.querySelector('[data-field="start"]');
    var endInput   = row.querySelector('[data-field="end"]');
    if (!startInput) return;
    corrections.push({
      day:        parseInt(startInput.dataset.day, 10),
      fixedStart: startInput.value.trim(),
      fixedEnd:   endInput.value.trim(),
    });
  });

  adminPost({
    action:      'adminSaveCorrection',
    adminToken:  state.token,
    lineUserId:  state.selectedDriver.lineUserId,
    yearMonth:   state.yearMonth,
    corrections: corrections,
  }).then(function() {
    showToast('修正を保存しました');
  });
}

// ===== 月次確定 =====
function handleConfirmMonth() {
  if (!confirm(state.selectedDriver.driverName + ' の ' + state.yearMonth + ' を確定します。よろしいですか？')) return;

  // 修正を先に保存してから確定
  handleSaveCorrection();

  adminPost({
    action:     'adminConfirmMonth',
    adminToken: state.token,
    lineUserId: state.selectedDriver.lineUserId,
    yearMonth:  state.yearMonth,
  }).then(function(res) {
    showToast('確定しました。稼働' + res.workingDays + '日 / ¥' + res.billingAmount.toLocaleString());
    document.getElementById('btn-confirm-month').disabled = true;
    document.getElementById('btn-confirm-month').textContent = '確定済み';
  });
}

// ===== CSV出力 =====
function handleExport() {
  adminPost({
    action:     'adminExportData',
    adminToken: state.token,
    yearMonth:  state.yearMonth,
  }).then(function(res) {
    state.exportData = res.rows;
    renderExportTable(res.rows);
    document.getElementById('export-yearmonth-label').textContent = state.yearMonth + ' の確定済みデータ';
    document.getElementById('modal-export').classList.remove('hidden');
    document.getElementById('modal-overlay').classList.remove('hidden');
  });
}

function renderExportTable(rows) {
  var tbody = document.getElementById('export-tbody');
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-cell">確定済みデータはありません</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map(function(r) {
    return [
      '<tr>',
      '<td>' + escHtml(r.driverName) + '</td>',
      '<td>' + escHtml(r.site) + '</td>',
      '<td>' + r.workingDays + '</td>',
      '<td>' + r.totalHours + '</td>',
      '<td>¥' + (r.unitPrice || 0).toLocaleString() + '</td>',
      '<td>¥' + (r.billingAmount || 0).toLocaleString() + '</td>',
      '</tr>',
    ].join('');
  }).join('');
}

function downloadCsv() {
  if (!state.exportData) return;
  var rows    = state.exportData;
  var headers = ['ドライバー名', '現場', '稼働日数', '実働時間(h)', '単価', '請求金額', '確定日時'];
  var csv     = [headers.join(',')];
  rows.forEach(function(r) {
    csv.push([
      '"' + (r.driverName    || '') + '"',
      '"' + (r.site          || '') + '"',
      r.workingDays  || 0,
      r.totalHours   || 0,
      r.unitPrice    || 0,
      r.billingAmount || 0,
      '"' + (r.confirmedAt   || '') + '"',
    ].join(','));
  });
  var blob = new Blob(['﻿' + csv.join('\n')], { type: 'text/csv;charset=utf-8' });
  var url  = URL.createObjectURL(blob);
  var a    = document.createElement('a');
  a.href     = url;
  a.download = '月報集計_' + state.yearMonth + '.csv';
  a.click();
  URL.revokeObjectURL(url);
}

function closeModal() {
  document.getElementById('modal-export').classList.add('hidden');
  document.getElementById('modal-overlay').classList.add('hidden');
}

// ===== API =====
function adminPost(payload) {
  return fetch(GAS_URL, {
    method:   'POST',
    headers:  { 'Content-Type': 'text/plain' },
    body:     JSON.stringify(payload),
    redirect: 'follow',
  })
  .then(function(res) { return res.json(); })
  .then(function(json) {
    if (json.error === 'unauthorized') throw new Error('unauthorized');
    if (json.error) throw new Error(json.error);
    return json;
  });
}

// ===== ユーティリティ =====
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(function(s) { s.classList.remove('active'); });
  document.getElementById('screen-' + name).classList.add('active');
}

var toastTimer = null;
function showToast(msg) {
  var el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function() { el.classList.add('hidden'); }, 3000);
}

function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
