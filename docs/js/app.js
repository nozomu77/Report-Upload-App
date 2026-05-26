// ===== 設定（後で実際の値に差し替え） =====
var LIFF_ID = '2010200152-mmBc5K3D';
var GAS_URL = 'https://script.google.com/macros/s/AKfycby2iYCqY-8ewAC0uMITrhjxNqe_toZEXLySC6dQNvuA371a8pX41d6Xxn3N1ayHW_W5/exec';

// ===== 状態 =====
var state = {
  lineUserId:  null,
  displayName: null,
  driver:      null,
  selectedFile: null,
  selectedMimeType: null,
};

// ===== 初期化 =====
document.addEventListener('DOMContentLoaded', function() {
  initApp();
});

function initApp() {
  var now  = new Date();
  var yyyy = now.getFullYear();
  var mm   = String(now.getMonth() + 1).padStart(2, '0');
  document.getElementById('input-yearmonth').value = yyyy + '-' + mm;

  liff.init({ liffId: LIFF_ID })
    .then(function() {
      if (!liff.isLoggedIn()) {
        liff.login();
        return Promise.reject('not_logged_in');
      }
      return liff.getProfile();
    })
    .then(function(profile) {
      state.lineUserId  = profile.userId;
      state.displayName = profile.displayName;
      // プロフィール＋履歴を1回のAPIで取得
      return gasPost({ action: 'bootstrap', lineUserId: profile.userId });
    })
    .then(function(res) {
      state.driver = res.driver;
      updateDriverInfo(res.driver);
      renderReportList(res.reports || []);
      setupEventListeners();
      showScreen('main');
    })
    .catch(function(err) {
      if (err === 'not_logged_in') return;
      showScreen('main');
      showToast('認証に失敗しました。マスタ登録を確認してください。');
      setupEventListeners();
    });
}

// ===== API呼び出し =====

function uploadReport(yearMonth, file) {
  var isPdf = file.type === 'application/pdf';

  if (isPdf) {
    return new Promise(function(resolve, reject) {
      var reader = new FileReader();
      reader.onload = function(e) {
        var base64 = e.target.result.split(',')[1];
        gasPost({
          action:     'uploadReport',
          lineUserId: state.lineUserId,
          yearMonth:  yearMonth,
          mimeType:   'application/pdf',
          fileBase64: base64,
          fileName:   file.name,
        }).then(resolve).catch(reject);
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  // 画像: Canvas で左右分割してから送信（縦解像度を確保し精度を上げる）
  return splitImageHalves(file).then(function(halves) {
    return gasPost({
      action:          'uploadReport',
      lineUserId:      state.lineUserId,
      yearMonth:       yearMonth,
      mimeType:        'image/jpeg',
      fileBase64:      halves.full,
      fileBase64Left:  halves.left,
      fileBase64Right: halves.right,
      fileName:        file.name,
    });
  });
}

// Canvas を使って画像を左右半分に分割し base64 で返す
function splitImageHalves(file) {
  return new Promise(function(resolve, reject) {
    var img = new Image();
    var url = URL.createObjectURL(file);
    img.onload = function() {
      URL.revokeObjectURL(url);

      // 長辺が2000pxを超える場合は縮小（GAS転送サイズ削減）
      var MAX = 2000;
      var scale = Math.min(1, MAX / Math.max(img.width, img.height));
      var w = Math.round(img.width  * scale);
      var h = Math.round(img.height * scale);
      var midX = Math.round(w / 2);

      // フル画像
      var canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      var full = canvas.toDataURL('image/jpeg', 0.85).split(',')[1];

      // 左半分
      var cL = document.createElement('canvas');
      cL.width = midX; cL.height = h;
      cL.getContext('2d').drawImage(img, 0, 0, w, h, 0, 0, w, h);
      // 右端を切り捨て（左半分のみ表示）
      var cL2 = document.createElement('canvas');
      cL2.width = midX; cL2.height = h;
      cL2.getContext('2d').drawImage(canvas, 0, 0, midX, h, 0, 0, midX, h);
      var left = cL2.toDataURL('image/jpeg', 0.85).split(',')[1];

      // 右半分
      var cR = document.createElement('canvas');
      cR.width = w - midX; cR.height = h;
      cR.getContext('2d').drawImage(canvas, midX, 0, w - midX, h, 0, 0, w - midX, h);
      var right = cR.toDataURL('image/jpeg', 0.85).split(',')[1];

      resolve({ full: full, left: left, right: right });
    };
    img.onerror = reject;
    img.src = url;
  });
}

function gasPost(payload) {
  return fetch(GAS_URL, {
    method:   'POST',
    // GASはapplication/jsonだとCORSプリフライトが発生するためtext/plainで送る
    headers:  { 'Content-Type': 'text/plain' },
    body:     JSON.stringify(payload),
    redirect: 'follow',
  })
  .then(function(res) { return res.json(); })
  .then(function(json) {
    if (json.error) throw new Error(json.error);
    return json;
  });
}

// ===== イベントリスナー =====

function setupEventListeners() {
  document.getElementById('btn-camera').addEventListener('click', function() {
    var input = document.getElementById('file-input');
    input.setAttribute('capture', 'environment');
    input.setAttribute('accept', 'image/*');
    input.click();
  });

  document.getElementById('btn-file').addEventListener('click', function() {
    var input = document.getElementById('file-input');
    input.removeAttribute('capture');
    input.setAttribute('accept', 'image/*,application/pdf');
    input.click();
  });

  document.getElementById('file-input').addEventListener('change', function(e) {
    var file = e.target.files[0];
    if (file) handleFileSelected(file);
  });

  document.getElementById('btn-cancel-file').addEventListener('click', clearFileSelection);
  document.getElementById('btn-submit').addEventListener('click', handleSubmit);
  document.getElementById('btn-back').addEventListener('click', function() {
    showScreen('main');
    gasPost({ action: 'getMyReports', lineUserId: state.lineUserId })
      .then(function(res) { renderReportList(res.reports || []); })
      .catch(function() {});
  });
}

// ===== ファイル選択 =====

function handleFileSelected(file) {
  state.selectedFile     = file;
  state.selectedMimeType = file.type;

  document.getElementById('upload-area').classList.add('hidden');
  document.getElementById('preview-area').classList.remove('hidden');
  document.getElementById('preview-filename').textContent = file.name;

  var img = document.getElementById('preview-image');
  if (file.type.startsWith('image/')) {
    img.src = URL.createObjectURL(file);
    img.classList.remove('hidden');
  } else {
    img.classList.add('hidden');
  }

  document.getElementById('btn-submit').disabled = false;
}

function clearFileSelection() {
  state.selectedFile     = null;
  state.selectedMimeType = null;
  document.getElementById('file-input').value = '';
  document.getElementById('upload-area').classList.remove('hidden');
  document.getElementById('preview-area').classList.add('hidden');
  document.getElementById('preview-image').classList.add('hidden');
  document.getElementById('btn-submit').disabled = true;
}

// ===== 送信 =====

function handleSubmit() {
  var yearMonth = document.getElementById('input-yearmonth').value;
  if (!yearMonth)          { showToast('対象年月を選択してください'); return; }
  if (!state.selectedFile) { showToast('ファイルを選択してください'); return; }
  if (!state.lineUserId)   { showToast('ログインし直してください'); return; }

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
      showToast('送信失敗: ' + err.message);
    });
}

// ===== 提出履歴 =====

function renderReportList(reports) {
  var container = document.getElementById('report-list');
  if (!reports.length) {
    container.innerHTML = '<p class="empty-text">提出済みの月報はありません</p>';
    return;
  }

  reports.sort(function(a, b) { return b.yearMonth.localeCompare(a.yearMonth); });

  container.innerHTML = reports.map(function(r) {
    var fileLabel = r.fileType === 'pdf' ? 'PDF' : '写真';
    return [
      '<div class="report-item">',
      '  <div class="report-item-left">',
      '    <div class="yearmonth">' + r.yearMonth + '</div>',
      '    <div class="filetype">' + fileLabel + '</div>',
      '  </div>',
      '  <span class="status-badge status-' + r.status + '">' + r.status + '</span>',
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

function updateDriverInfo(driver) {
  var text = driver ? (driver.name + ' / ' + driver.site) : state.displayName || '---';
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
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function() { el.classList.add('hidden'); }, 3000);
}
