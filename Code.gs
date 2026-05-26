// ===== 定数（後で実際の値に差し替え） =====
var SHEET_ID = 'YOUR_SPREADSHEET_ID_HERE';
var DRIVE_FOLDER_ID = 'YOUR_DRIVE_FOLDER_ID_HERE'; // 月報保管用ルートフォルダ

var SHEET_RECEIVED = '月報受信ファイル';
var SHEET_OCR      = 'OCR結果データ';
var SHEET_DRIVER   = 'ドライバーマスタ';
var SHEET_MONTHLY  = '月次確定';

// ===== ルーティング =====

function doGet(e) {
  var action = (e.parameter && e.parameter.action) || '';
  switch (action) {
    case 'health':
      return jsonResponse({ status: 'ok', ts: new Date().toISOString() });
    default:
      return jsonResponse({ error: 'invalid action' });
  }
}

function doPost(e) {
  try {
    var payload = JSON.parse(e.postData.contents);
    var action  = payload.action || '';
    switch (action) {
      case 'uploadReport':   return handleUploadReport(payload);
      case 'getMyReports':   return handleGetMyReports(payload);
      default:
        return jsonResponse({ error: 'invalid action' });
    }
  } catch (err) {
    return jsonResponse({ error: err.message });
  }
}

// ===== ドライバー向けAPI =====

function handleUploadReport(payload) {
  // payload: { action, lineUserId, yearMonth, fileType, fileBase64, fileName }
  var driver = getDriverByUserId(payload.lineUserId);
  if (!driver) return jsonResponse({ error: 'unauthorized' });

  var yearMonth = payload.yearMonth; // 例: "2026-05"
  var fileType  = payload.fileType;  // "image" or "pdf"
  var base64    = payload.fileBase64;
  var fileName  = payload.fileName || ('report_' + yearMonth);

  // Drive保存
  var fileId  = saveFileToDrive_(driver, yearMonth, fileType, base64, fileName);
  var fileUrl = 'https://drive.google.com/file/d/' + fileId + '/view';

  // 受信ファイルシートに記録
  var ss    = SpreadsheetApp.openById(SHEET_ID);
  var sheet = ss.getSheetByName(SHEET_RECEIVED);
  sheet.appendRow([
    new Date(),        // タイムスタンプ
    driver.lineUserId, // LINEユーザーID
    driver.name,       // ドライバー名
    yearMonth,         // 年月
    fileType,          // ファイル種別
    fileId,            // DriveファイルID
    fileUrl,           // DriveURL
    '未処理',           // ステータス
    ''                 // OCR実行日時
  ]);

  return jsonResponse({ status: 'ok', fileId: fileId });
}

function handleGetMyReports(payload) {
  // payload: { action, lineUserId }
  var driver = getDriverByUserId(payload.lineUserId);
  if (!driver) return jsonResponse({ error: 'unauthorized' });

  var ss    = SpreadsheetApp.openById(SHEET_ID);
  var sheet = ss.getSheetByName(SHEET_RECEIVED);
  var data  = sheet.getDataRange().getValues();

  var reports = [];
  for (var i = 1; i < data.length; i++) {
    if (data[i][1] === driver.lineUserId) {
      reports.push({
        timestamp: data[i][0],
        yearMonth: data[i][3],
        fileType:  data[i][4],
        fileUrl:   data[i][6],
        status:    data[i][7]
      });
    }
  }

  return jsonResponse({ reports: reports });
}

// ===== ヘルパー =====

function getDriverByUserId(userId) {
  if (!userId) return null;
  var ss    = SpreadsheetApp.openById(SHEET_ID);
  var sheet = ss.getSheetByName(SHEET_DRIVER);
  var data  = sheet.getDataRange().getValues();

  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === userId) {
      return {
        lineUserId:        data[i][0],
        name:              data[i][1],
        site:              data[i][2],
        unitPrice:         data[i][3],
        baseWorkMinutes:   data[i][4], // 荷主基準拘束時間（分）
        // breakMinutes:   data[i][5], // 休憩時間（スタブ：未決定）
      };
    }
  }
  return null;
}

function saveFileToDrive_(driver, yearMonth, fileType, base64, fileName) {
  var mimeType = fileType === 'pdf'
    ? MimeType.PDF
    : MimeType.JPEG; // 画像はとりあえずJPEGで受け取る想定

  var blob = Utilities.newBlob(
    Utilities.base64Decode(base64),
    mimeType,
    fileName
  );

  // /月報/{YYYY-MM}/{ドライバー名}/ フォルダ構造を維持
  var rootFolder   = DriveApp.getFolderById(DRIVE_FOLDER_ID);
  var monthFolder  = getOrCreateFolder_(rootFolder, yearMonth);
  var driverFolder = getOrCreateFolder_(monthFolder, driver.name);

  var file = driverFolder.createFile(blob);
  return file.getId();
}

function getOrCreateFolder_(parent, name) {
  var iter = parent.getFoldersByName(name);
  if (iter.hasNext()) return iter.next();
  return parent.createFolder(name);
}

function jsonResponse(data) {
  var output = ContentService.createTextOutput(JSON.stringify(data));
  output.setMimeType(ContentService.MimeType.JSON);
  return output;
}
