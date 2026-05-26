// Claude API を使った月報OCRサービス
// Script Properties に CLAUDE_API_KEY を設定しておくこと

var CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
var CLAUDE_MODEL   = 'claude-sonnet-4-6';

var OCR_PROMPT = [
  '以下は運送ドライバーの月次稼働報告書です。',
  '日別の「開始時間」と「終了時間」のみを読み取ってください。',
  '',
  '出力形式（JSON）:',
  '{',
  '  "days": [',
  '    { "day": 1, "start": "08:00", "end": "17:30" },',
  '    { "day": 2, "start": null,    "end": null    },',
  '    ...',
  '  ]',
  '}',
  '',
  '注意:',
  '- 稼働○×は判定に使わない。開始時間が記入されている日のみ稼働と判定する。',
  '- 読み取れない場合は null を入れる。',
  '- サマリ行（合計欄）は無視する。',
  '- day は月の日付（1〜31の整数）。',
].join('\n');

function runOcr(receivedFileId) {
  var ss         = SpreadsheetApp.openById(SHEET_ID);
  var recvSheet  = ss.getSheetByName(SHEET_RECEIVED);
  var data       = recvSheet.getDataRange().getValues();

  // 受信ファイルシートから対象行を探す
  var rowIndex = -1;
  var rowData;
  for (var i = 1; i < data.length; i++) {
    if (data[i][5] === receivedFileId) { // DriveファイルID列
      rowIndex = i + 1; // 1-indexed for sheet
      rowData  = data[i];
      break;
    }
  }
  if (rowIndex === -1) throw new Error('File not found: ' + receivedFileId);

  var lineUserId  = rowData[1];
  var driverName  = rowData[2];
  var yearMonth   = rowData[3]; // "2026-05"
  var fileType    = rowData[4];
  var driveFileId = rowData[5];

  // ステータスを「OCR中」に更新
  recvSheet.getRange(rowIndex, 8).setValue('OCR中');

  try {
    var file     = DriveApp.getFileById(driveFileId);
    var blob     = file.getBlob();
    var results  = callClaudeOcr_(blob, fileType, driverName, yearMonth);

    // OCR結果をシートに書き込み
    writeOcrResults_(lineUserId, driverName, yearMonth, receivedFileId, results);

    // ステータスを「確認待ち」に更新
    recvSheet.getRange(rowIndex, 8).setValue('確認待ち');
    recvSheet.getRange(rowIndex, 9).setValue(new Date()); // OCR実行日時
  } catch (err) {
    recvSheet.getRange(rowIndex, 8).setValue('OCRエラー');
    throw err;
  }
}

function callClaudeOcr_(blob, fileType, driverName, yearMonth) {
  var apiKey = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
  if (!apiKey) throw new Error('CLAUDE_API_KEY not set in Script Properties');

  var days = [];

  if (fileType === 'image') {
    // 左右分割して2回送信（縦解像度を確保）
    var halves = splitImageLeftRight_(blob);
    var leftResult  = sendToClaudeVision_(apiKey, halves[0], 'image/jpeg', OCR_PROMPT + '\n（左半分のページです）');
    var rightResult = sendToClaudeVision_(apiKey, halves[1], 'image/jpeg', OCR_PROMPT + '\n（右半分のページです）');
    days = mergeHalves_(leftResult, rightResult);
  } else {
    // PDFはそのまま送信
    var pdfResult = sendToClaudeVision_(apiKey, blob, 'application/pdf', OCR_PROMPT);
    days = pdfResult.days || [];
  }

  return days;
}

function sendToClaudeVision_(apiKey, blob, mimeType, prompt) {
  var base64 = Utilities.base64Encode(blob.getBytes());

  var sourceType = mimeType === 'application/pdf' ? 'base64' : 'base64';
  var mediaTypeForApi = mimeType;

  var requestBody = {
    model: CLAUDE_MODEL,
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: mediaTypeForApi,
            data: base64
          }
        },
        {
          type: 'text',
          text: prompt
        }
      ]
    }]
  };

  var response = UrlFetchApp.fetch(CLAUDE_API_URL, {
    method: 'post',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    payload: JSON.stringify(requestBody),
    muteHttpExceptions: true
  });

  var result = JSON.parse(response.getContentText());
  if (result.error) throw new Error('Claude API error: ' + result.error.message);

  var text = result.content[0].text;

  // JSONブロックを抽出
  var match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Could not parse OCR response: ' + text);
  return JSON.parse(match[0]);
}

function splitImageLeftRight_(blob) {
  // GASにはCanvas APIがないため、UrlFetchAppで外部サービスを呼ぶか
  // 画像をそのまま2枚複製して送信する簡易スタブ
  // TODO: 実際の左右分割実装（サーバーサイド画像処理 or Cloudinary等）
  return [blob, blob];
}

function mergeHalves_(leftResult, rightResult) {
  // 左半分・右半分のOCR結果をマージ
  // 左: 1〜15日付近、右: 16〜31日付近が多いが帳票に依存
  // 実際の帳票を見て調整する
  var merged = [];
  var allDays = (leftResult.days || []).concat(rightResult.days || []);

  // 同じ日が重複したら後者（右半分）で上書き
  var map = {};
  allDays.forEach(function(d) {
    if (!map[d.day] || (d.start !== null)) {
      map[d.day] = d;
    }
  });

  for (var day = 1; day <= 31; day++) {
    if (map[day]) merged.push(map[day]);
  }
  return merged;
}

function writeOcrResults_(lineUserId, driverName, yearMonth, receivedFileId, days) {
  var ss    = SpreadsheetApp.openById(SHEET_ID);
  var sheet = ss.getSheetByName(SHEET_OCR);

  // 同じ lineUserId + yearMonth の既存行を削除
  var data = sheet.getDataRange().getValues();
  for (var i = data.length - 1; i >= 1; i--) {
    if (data[i][0] === lineUserId && data[i][2] === yearMonth) {
      sheet.deleteRow(i + 1);
    }
  }

  // 新しい行を追加
  days.forEach(function(d) {
    var isWorking = d.start !== null; // 開始時間あり = 稼働日
    sheet.appendRow([
      lineUserId,       // LINEユーザーID
      driverName,       // ドライバー名
      yearMonth,        // 年月
      d.day,            // 日
      d.start || '',    // 開始時間
      d.end   || '',    // 終了時間
      isWorking,        // 稼働フラグ
      false,            // 立替経費フラグ（TODO）
      false,            // 備考フラグ（TODO）
      '未確認',          // 確認ステータス
      '',               // 修正後開始時間
      '',               // 修正後終了時間
      receivedFileId    // 受信ファイルID
    ]);
  });
}

// 稼働日数を日別データから自前カウント（APIサマリ値は使用しない）
function countWorkingDays(lineUserId, yearMonth) {
  var ss    = SpreadsheetApp.openById(SHEET_ID);
  var sheet = ss.getSheetByName(SHEET_OCR);
  var data  = sheet.getDataRange().getValues();

  var count = 0;
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === lineUserId && data[i][2] === yearMonth && data[i][6] === true) {
      count++;
    }
  }
  return count;
}
