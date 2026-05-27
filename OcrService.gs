// Claude API を使った月報OCRサービス
// Script Properties に CLAUDE_API_KEY を設定しておくこと

var CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
var CLAUDE_MODEL   = 'claude-sonnet-4-6';

var OCR_PROMPT_BASE = [
  'これはドライバーの月次稼働報告書の画像です。',
  '日付ごとのデータを読み取り、以下のJSON形式のみで返してください。',
  '',
  '{"days":[',
  '  {"day":1,"start":"08:00","end":"17:30","expense":false,"note":false},',
  '  {"day":2,"start":null,"end":null,"expense":false,"note":false},',
  '  ...',
  ']}',
  '',
  '【各フィールドのルール】',
  '- day: 日付の数字（1〜31の整数）',
  '- start/end: HH:MM形式。開始時間が記入されていない日はnull',
  '- expense: その日の行に立替経費・費用の記入があればtrue',
  '- note: その日の行に申し送り・備考の記入（塗りつぶしや文字）があればtrue',
  '',
  '【共通ルール】',
  '- 合計行・集計欄は無視する',
  '- サマリ値は使わず日別データだけを返す',
  '- JSONブロックのみを返し説明文は不要',
].join('\n');

// ===== メイン関数 =====

// Code.gsのhandleUploadReportから呼ばれる
function runOcr(fileId, yearMonth, lineUserId, leftBase64, rightBase64, pdfBase64) {
  var driver = getDriverByUserId(lineUserId);
  if (!driver) throw new Error('Driver not found: ' + lineUserId);

  updateReceivedFileStatus_(fileId, 'OCR中');

  try {
    var days;

    if (pdfBase64) {
      var raw = callClaudeApi_(pdfBase64, 'application/pdf', OCR_PROMPT_BASE);
      days = parseDays_(raw);
    } else {
      // フル画像で送信（左右分割は帳票の向きに依存するため一旦無効化）
      var fullRaw = callClaudeApi_(leftBase64 || rightBase64, 'image/jpeg', OCR_PROMPT_BASE);
      days = parseDays_(fullRaw);
    }

    writeOcrResults_(lineUserId, driver.name, yearMonth, fileId, days);
    updateReceivedFileStatus_(fileId, '確認待ち');
    updateReceivedOcrTime_(fileId);

    return { workingDays: countWorkingDays_(days), days: days };

  } catch (err) {
    updateReceivedFileStatus_(fileId, 'OCRエラー');
    throw err;
  }
}

// ===== Claude API呼び出し =====

function callClaudeApi_(base64, mimeType, prompt) {
  var apiKey = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
  if (!apiKey) throw new Error('CLAUDE_API_KEY not set in Script Properties');

  var contentItem = mimeType === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
    : { type: 'image',    source: { type: 'base64', media_type: mimeType,           data: base64 } };

  var body = {
    model:      CLAUDE_MODEL,
    max_tokens: 2048,
    messages: [{
      role: 'user',
      content: [contentItem, { type: 'text', text: prompt }]
    }]
  };

  var res = UrlFetchApp.fetch(CLAUDE_API_URL, {
    method:           'post',
    headers: {
      'x-api-key':          apiKey,
      'anthropic-version':  '2023-06-01',
      'content-type':       'application/json',
    },
    payload:          JSON.stringify(body),
    muteHttpExceptions: true,
  });

  var json = JSON.parse(res.getContentText());
  if (json.error) throw new Error('Claude API error: ' + json.error.message);

  return json.content[0].text;
}

// ===== パース・マージ =====

function parseDays_(text) {
  var match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('OCRレスポンスからJSONを取得できませんでした: ' + text.substring(0, 200));
  var parsed = JSON.parse(match[0]);
  return parsed.days || [];
}

function mergeHalves_(leftDays, rightDays) {
  var map = {};

  // 両方の結果をマージ。同じ日は start が非nullの方を優先
  leftDays.concat(rightDays).forEach(function(d) {
    if (!map[d.day] || (d.start !== null && map[d.day].start === null)) {
      map[d.day] = d;
    }
  });

  var result = [];
  for (var day = 1; day <= 31; day++) {
    if (map[day]) result.push(map[day]);
  }
  return result;
}

// 稼働日数 = 開始時間が記入されている日の数（APIサマリ値は使用しない）
function countWorkingDays_(days) {
  return days.filter(function(d) { return d.start !== null; }).length;
}

// ===== Sheets書き込み =====

function writeOcrResults_(lineUserId, driverName, yearMonth, fileId, days) {
  var ss    = SpreadsheetApp.openById(SHEET_ID);
  var sheet = ss.getSheetByName(SHEET_OCR);

  // 同じ lineUserId + yearMonth の既存行を削除
  var data = sheet.getDataRange().getValues();
  for (var i = data.length - 1; i >= 1; i--) {
    if (data[i][0] === lineUserId && data[i][2] === yearMonth) {
      sheet.deleteRow(i + 1);
    }
  }

  if (days.length === 0) return;

  var rows = days.map(function(d) {
    return [
      lineUserId,            // LINEユーザーID
      driverName,            // ドライバー名
      yearMonth,             // 年月
      d.day,                 // 日
      d.start || '',         // 開始時間
      d.end   || '',         // 終了時間
      d.start !== null,      // 稼働フラグ
      d.expense === true,    // 立替経費フラグ
      d.note    === true,    // 備考フラグ
      '未確認',               // 確認ステータス
      '',                    // 修正後開始時間
      '',                    // 修正後終了時間
      fileId                 // 受信ファイルID
    ];
  });

  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
}

function updateReceivedFileStatus_(fileId, status) {
  var ss    = SpreadsheetApp.openById(SHEET_ID);
  var sheet = ss.getSheetByName(SHEET_RECEIVED);
  var data  = sheet.getDataRange().getValues();

  for (var i = 1; i < data.length; i++) {
    if (data[i][5] === fileId) {
      sheet.getRange(i + 1, 8).setValue(status);
      return;
    }
  }
}

function updateReceivedOcrTime_(fileId) {
  var ss    = SpreadsheetApp.openById(SHEET_ID);
  var sheet = ss.getSheetByName(SHEET_RECEIVED);
  var data  = sheet.getDataRange().getValues();

  for (var i = 1; i < data.length; i++) {
    if (data[i][5] === fileId) {
      sheet.getRange(i + 1, 9).setValue(new Date());
      return;
    }
  }
}
