// ===== 定数 =====
var SHEET_ID        = '1UPf356re1SXfTDT00djtvHiUWJJRNvd4nKvK1MpSgaA';
var DRIVE_FOLDER_ID = '1ZHLd8OvR1eZHaqbBu7Mv_ia-xR5bN8ui';

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
      case 'bootstrap':     return handleBootstrap(payload);
      case 'getProfile':    return handleGetProfile(payload);
      case 'uploadReport':  return handleUploadReport(payload);
      case 'getMyReports':  return handleGetMyReports(payload);
      case 'adminGetOverview':
      case 'adminGetDriverList':
      case 'adminGetOcrDetail':
      case 'adminSaveCorrection':
      case 'adminConfirmMonth':
      case 'adminExportData':
        return handleAdminPost(payload);
      default:
        return jsonResponse({ error: 'invalid action' });
    }
  } catch (err) {
    return jsonResponse({ error: err.message });
  }
}

// ===== ドライバー向けAPI =====

// 起動時に1回のリクエストでプロフィール＋提出履歴を返す
function handleBootstrap(payload) {
  var driver = getDriverByUserId(payload.lineUserId);
  if (!driver) return jsonResponse({ error: 'unauthorized' });

  var reports = getReportsByUserId_(driver.lineUserId);
  return jsonResponse({
    driver:  driver,
    reports: reports
  });
}

function handleGetProfile(payload) {
  var driver = getDriverByUserId(payload.lineUserId);
  if (!driver) return jsonResponse({ error: 'unauthorized' });
  return jsonResponse({ driver: driver });
}

function handleUploadReport(payload) {
  // payload: { action, lineUserId, yearMonth, mimeType, fileBase64, fileName,
  //            fileBase64Left, fileBase64Right }  ← 画像は左右分割で送信
  var driver = getDriverByUserId(payload.lineUserId);
  if (!driver) return jsonResponse({ error: 'unauthorized' });

  var yearMonth = payload.yearMonth;
  var mimeType  = payload.mimeType || 'image/jpeg';
  var base64    = payload.fileBase64;
  var fileName  = payload.fileName || ('report_' + yearMonth);
  var fileType  = mimeType === 'application/pdf' ? 'pdf' : 'image';

  // Drive に元ファイルを保存
  var fileId  = saveFileToDrive_(driver, yearMonth, mimeType, base64, fileName);
  var fileUrl = 'https://drive.google.com/file/d/' + fileId + '/view';

  var ss    = SpreadsheetApp.openById(SHEET_ID);
  var sheet = ss.getSheetByName(SHEET_RECEIVED);
  sheet.appendRow([
    new Date(),
    driver.lineUserId,
    driver.name,
    yearMonth,
    fileType,
    fileId,
    fileUrl,
    '未処理',
    ''
  ]);

  // OCR実行（失敗してもアップロード自体は成功扱い）
  var ocrResult = null;
  try {
    if (fileType === 'pdf') {
      ocrResult = runOcr(fileId, yearMonth, driver.lineUserId, null, null, base64);
    } else {
      var firstBase64  = payload.fileBase64First  || base64;
      var secondBase64 = payload.fileBase64Second || base64;
      ocrResult = runOcr(fileId, yearMonth, driver.lineUserId, firstBase64, secondBase64, null);
    }
  } catch (ocrErr) {
    Logger.log('OCR error: ' + ocrErr.message);
  }

  return jsonResponse({
    status:      'ok',
    fileId:      fileId,
    fileUrl:     fileUrl,
    workingDays: ocrResult ? ocrResult.workingDays : null,
  });
}

function handleGetMyReports(payload) {
  var driver = getDriverByUserId(payload.lineUserId);
  if (!driver) return jsonResponse({ error: 'unauthorized' });
  return jsonResponse({ reports: getReportsByUserId_(driver.lineUserId) });
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
        lineUserId:      data[i][0],
        name:            data[i][1],
        site:            data[i][2],
        unitPrice:       data[i][3],
        baseWorkMinutes: data[i][4],
        // breakMinutes: data[i][5], // スタブ：休憩時間（未決定）
      };
    }
  }
  return null;
}

function getReportsByUserId_(lineUserId) {
  var ss    = SpreadsheetApp.openById(SHEET_ID);
  var sheet = ss.getSheetByName(SHEET_RECEIVED);
  var data  = sheet.getDataRange().getValues();

  var reports = [];
  for (var i = 1; i < data.length; i++) {
    if (data[i][1] === lineUserId) {
      reports.push({
        timestamp: data[i][0] ? new Date(data[i][0]).toISOString() : '',
        yearMonth: data[i][3],
        fileType:  data[i][4],
        fileUrl:   data[i][6],
        status:    data[i][7]
      });
    }
  }
  return reports;
}

function saveFileToDrive_(driver, yearMonth, mimeType, base64, fileName) {
  var blob = Utilities.newBlob(
    Utilities.base64Decode(base64),
    mimeType,
    fileName
  );

  var rootFolder   = DriveApp.getFolderById(DRIVE_FOLDER_ID);
  var monthFolder  = getOrCreateFolder_(rootFolder, yearMonth);
  var driverFolder = getOrCreateFolder_(monthFolder, driver.name);

  return driverFolder.createFile(blob).getId();
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
