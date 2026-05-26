// ===== 設定（後で実際の値に差し替え） =====
var LIFF_ID  = 'YOUR_LIFF_ID_HERE';
var GAS_URL  = 'YOUR_GAS_WEBAPP_URL_HERE'; // /exec URL

// ===== 状態 =====
var state = {
  lineUserId:  null,
  displayName: null,
  driver:      null,
  selectedFile: null,
  selectedFileType: null, // 'image' or 'pdf'
};

// ===== 初期化 =====
document.addEventListener('DOMContentLoaded', function() {
  initApp();
});

function initApp() {
  // 年月のデフォルトを当月に設定
  var now = new Date();
  var yyyy = now.getFullYear();
  var mm   = String(now.getMonth() + 1).padStart(2, '0');
  document.getElementById('input-yearmonth').value = yyyy + '-' + mm;

  liff.init({ liffId: LIFF_ID })
    .then(function() {
      if (!liff.isLoggedIn()) {
        liff.login();
        return;
      }
      return liff.getProfile();
    })
    .then(function(profile) {
      if (!profile) return;
      state.lineUserId  = profile.userId;
      state.displayName = profile.displayName;
      return fetchDriverProfile(profile.userId);
    })
    .then(function() {
      showScreen('main');
      loadReportHistory();
      setupEventListeners();
    })
    .catch(function(err) {
      showToast('初期化に失敗しました: ' + err.message);
      // 開発時はここでmain画面に進めることもある
    });
}

// ===== API呼び出し =====

function fetchDriverProfile(lineUserId) {
  return gasPost({ action: 'getMyReports', lineUserId: lineUserId })
    .then(function(res) {
      // ドライバー名はgetMyReportsのレスポンスから取れないので
      // ここではLINE表示名で代替し、マスタ登録チェックのみ行う
      // TODO: getProfileエンドポイントをCode.gsに追加したら差し替える
      updateDriverInfo(state.displayName, '');
    });
}

function loadReportHistory() {
  gasPost({ action: 'getMyReports', lineUserId: state.lineUserId })
    .then(function(res) {
      renderReportList(res.reports || []);
    })
    .catch(function() {
      renderReportList([]);
    });
}

function uploadReport(yearMonth, file) {
  return new Promise(function(resolve, reject) {
    var reader = new FileReader();
    reader.onload = function(e) {
      var base64 = e.target.result.split(',')[1]; // data:...;base64,<ここ>
      var fileType = file.type.indexOf('pdf') >= 0 ? 'pdf' : 'image';
      gasPost({
        action:      'uploadReport',
        lineUserId:  state.lineUserId,
        yearMonth:   yearMonth,
        fileType:    fileType,
        fileBase64:  base64,
        fileName:    file.name,
      }).then(resolve).catch(reject);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function gasPost(payload) {
  return fetch(GAS_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'text/plain' }, // GASはapplication/jsonだとCORSプリフライトが発生する
    body:    JSON.stringify(payload),
    redirect: 'follow',
  }).then(function(res) {
    return res.json();
  }).then(function(json) {
    if (json.error) throw new Error(json.error);
    return json;
  });
}

// ===== イベントリスナー =====

function setupEventListeners() {
  // カメラボタン（capture='environment'で背面カメラ優先）
  document.getElementById('btn-camera').addEventListener('click', function() {
    var input = document.getElementById('file-input');
    input.setAttribute('capture', 'environment');
    input.setAttribute('accept', 'image/*');
    input.click();
  });

  // ファイル選択ボタン
  document.getElementById('btn-file').addEventListener('click', function() {
    var input = document.getElementById('file-input');
    input.removeAttribute('capture');
    input.setAttribute('accept', 'image/*,application/pdf');
    input.click();
  });

  // ファイル選択時
  document.getElementById('file-input').addEventListener('change', function(e) {
    var file = e.target.files[0];
    if (!file) return;
    handleFileSelected(file);
  });

  // 選択し直す
  document.getElementById('btn-cancel-file').addEventListener('click', function() {
    clearFileSelection();
  });

  // 送信ボタン
  document.getElementById('btn-submit').addEventListener('click', function() {
    handleSubmit();
  });

  // 完了→戻るボタン
  document.getElementById('btn-back').addEventListener('click', function() {
    showScreen('main');
    loadReportHistory();
  });
}

// ===== ファイル選択処理 =====

function handleFileSelected(file) {
  state.selectedFile     = file;
  state.selectedFileType = file.type.indexOf('pdf') >= 0 ? 'pdf' : 'image';

  document.getElementById('upload-area').classList.add('hidden');
  document.getElementById('preview-area').classList.remove('hidden');
  document.getElementById('preview-filename').textContent = file.name;

  if (state.selectedFileType === 'image') {
    var url = URL.createObjectURL(file);
    var img = document.getElementById('preview-image');
    img.src = url;
    img.classList.remove('hidden');
  } else {
    document.getElementById('preview-image').classList.add('hidden');
  }

  document.getElementById('btn-submit').disabled = false;
}

function clearFileSelection() {
  state.selectedFile     = null;
  state.selectedFileType = null;
  document.getElementById('file-input').value = '';
  document.getElementById('upload-area').classList.remove('hidden');
  document.getElementById('preview-area').classList.add('hidden');
  document.getElementById('preview-image').classList.add('hidden');
  document.getElementById('btn-submit').disabled = true;
}

// ===== 送信処理 =====

function handleSubmit() {
  var yearMonth = document.getElementById('input-yearmonth').value;
  if (!yearMonth) {
    showToast('対象年月を選択してください');
    return;
  }
  if (!state.selectedFile) {
    showToast('ファイルを選択してください');
    return;
  }

  showOverlay(true);

  uploadReport(yearMonth, state.selectedFile)
    .then(function() {
      showOverlay(false);
      var ym = yearMonth.replace('-', '年') + '月';
      document.getElementById('done-message').textContent = ym + '分の月報を送信しました';
      showScreen('done');
    })
    .catch(function(err) {
      showOverlay(false);
      showToast('送信に失敗しました: ' + err.message);
    });
}

// ===== 提出履歴レンダリング =====

function renderReportList(reports) {
  var container = document.getElementById('report-list');
  if (!reports.length) {
    container.innerHTML = '<p class="empty-text">提出済みの月報はありません</p>';
    return;
  }

  reports.sort(function(a, b) { return b.yearMonth.localeCompare(a.yearMonth); });

  container.innerHTML = reports.map(function(r) {
    var statusClass = 'status-' + r.status;
    var fileLabel   = r.fileType === 'pdf' ? 'PDF' : '写真';
    return [
      '<div class="report-item">',
      '  <div class="report-item-left">',
      '    <div class="yearmonth">' + r.yearMonth + '</div>',
      '    <div class="filetype">' + fileLabel + '</div>',
      '  </div>',
      '  <span class="status-badge ' + statusClass + '">' + r.status + '</span>',
      '</div>',
    ].join('');
  }).join('');
}

// ===== UI ヘルパー =====

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(function(s) {
    s.classList.remove('active');
  });
  document.getElementById('screen-' + name).classList.add('active');
}

function updateDriverInfo(name, site) {
  var text = name || '---';
  if (site) text += ' / ' + site;
  document.getElementById('driver-info').textContent = text;
}

function showOverlay(visible) {
  var el = document.getElementById('overlay-uploading');
  visible ? el.classList.remove('hidden') : el.classList.add('hidden');
}

var toastTimer = null;
function showToast(msg) {
  var el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(function() {
    el.classList.add('hidden');
  }, 3000);
}
