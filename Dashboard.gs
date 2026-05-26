// 事務員向け管理API
// Script Properties に ADMIN_TOKEN を設定しておくこと

function validateAdminToken_(token) {
  var stored = PropertiesService.getScriptProperties().getProperty('ADMIN_TOKEN');
  return stored && token === stored;
}

function handleAdminPost(payload) {
  if (!validateAdminToken_(payload.adminToken)) {
    return jsonResponse({ error: 'unauthorized' });
  }
  switch (payload.action) {
    case 'adminGetOverview':    return handleAdminGetOverview_(payload);
    case 'adminGetDriverList':  return handleAdminGetDriverList_(payload);
    case 'adminGetOcrDetail':   return handleAdminGetOcrDetail_(payload);
    case 'adminSaveCorrection': return handleAdminSaveCorrection_(payload);
    case 'adminConfirmMonth':   return handleAdminConfirmMonth_(payload);
    case 'adminExportData':     return handleAdminExportData_(payload);
    default: return jsonResponse({ error: 'invalid admin action' });
  }
}

// ===== 概要統計 =====

function handleAdminGetOverview_(payload) {
  var yearMonth = payload.yearMonth;
  var ss        = SpreadsheetApp.openById(SHEET_ID);
  var data      = ss.getSheetByName(SHEET_RECEIVED).getDataRange().getValues();

  var stats = { total: 0, pending: 0, confirmed: 0, ocrError: 0 };
  data.slice(1).forEach(function(row) {
    if (row[3] !== yearMonth) return;
    stats.total++;
    if      (row[7] === '確認待ち')  stats.pending++;
    else if (row[7] === '確定')      stats.confirmed++;
    else if (row[7] === 'OCRエラー') stats.ocrError++;
  });

  return jsonResponse({ stats: stats, yearMonth: yearMonth });
}

// ===== ドライバー別提出状況一覧 =====

function handleAdminGetDriverList_(payload) {
  var yearMonth = payload.yearMonth;
  var ss        = SpreadsheetApp.openById(SHEET_ID);

  var recvData    = ss.getSheetByName(SHEET_RECEIVED).getDataRange().getValues();
  var driverData  = ss.getSheetByName(SHEET_DRIVER).getDataRange().getValues();
  var ocrData     = ss.getSheetByName(SHEET_OCR).getDataRange().getValues();
  var monthlyData = ss.getSheetByName(SHEET_MONTHLY).getDataRange().getValues();

  var driverMap = {};
  driverData.slice(1).forEach(function(row) {
    if (row[0]) driverMap[row[0]] = { name: row[1], site: row[2], unitPrice: row[3] };
  });

  // 対象年月の受信ファイルをドライバーごとに集約（最新1件）
  var submissionMap = {};
  recvData.slice(1).forEach(function(row) {
    if (row[3] !== yearMonth) return;
    var uid = row[1];
    var ts  = row[0] ? new Date(row[0]).getTime() : 0;
    if (!submissionMap[uid] || ts > submissionMap[uid].ts) {
      submissionMap[uid] = {
        ts:        ts,
        fileUrl:   row[6],
        fileType:  row[4],
        status:    row[7],
        ocrTime:   row[8] ? new Date(row[8]).toISOString() : '',
      };
    }
  });

  // 稼働日数（修正後を優先）
  var workingDaysMap = {};
  ocrData.slice(1).forEach(function(row) {
    if (row[2] !== yearMonth) return;
    var uid       = row[0];
    var startVal  = row[10] || row[4]; // 修正後開始時間 or OCR開始時間
    var isWorking = startVal !== '' && startVal !== null;
    if (isWorking) workingDaysMap[uid] = (workingDaysMap[uid] || 0) + 1;
  });

  // 月次確定データ
  var confirmedMap = {};
  monthlyData.slice(1).forEach(function(row) {
    if (row[2] === yearMonth) confirmedMap[row[0]] = { billingAmount: row[7] };
  });

  var list = Object.keys(submissionMap).map(function(uid) {
    var sub = submissionMap[uid];
    var d   = driverMap[uid] || {};
    var wd  = workingDaysMap[uid] || 0;
    var up  = d.unitPrice || 0;
    return {
      lineUserId:    uid,
      driverName:    d.name || '',
      site:          d.site || '',
      unitPrice:     up,
      fileUrl:       sub.fileUrl,
      fileType:      sub.fileType,
      status:        sub.status,
      ocrTime:       sub.ocrTime,
      workingDays:   wd,
      billingAmount: confirmedMap[uid] ? confirmedMap[uid].billingAmount : wd * up,
      isConfirmed:   !!confirmedMap[uid],
    };
  });

  list.sort(function(a, b) { return a.driverName.localeCompare(b.driverName, 'ja'); });
  return jsonResponse({ drivers: list, yearMonth: yearMonth });
}

// ===== OCR詳細（日別データ） =====

function handleAdminGetOcrDetail_(payload) {
  var lineUserId = payload.lineUserId;
  var yearMonth  = payload.yearMonth;
  var ss         = SpreadsheetApp.openById(SHEET_ID);

  var ocrData = ss.getSheetByName(SHEET_OCR).getDataRange().getValues();
  var days = [];
  ocrData.slice(1).forEach(function(row) {
    if (row[0] !== lineUserId || row[2] !== yearMonth) return;
    days.push({
      day:         row[3],
      start:       row[4]  || '',
      end:         row[5]  || '',
      isWorking:   row[6],
      expenseFlag: row[7],
      noteFlag:    row[8],
      status:      row[9],
      fixedStart:  row[10] || '',
      fixedEnd:    row[11] || '',
    });
  });
  days.sort(function(a, b) { return a.day - b.day; });

  var recvData = ss.getSheetByName(SHEET_RECEIVED).getDataRange().getValues();
  var fileUrl  = '';
  recvData.slice(1).forEach(function(row) {
    if (row[1] === lineUserId && row[3] === yearMonth) fileUrl = row[6];
  });

  return jsonResponse({
    days:     days,
    fileUrl:  fileUrl,
    driver:   getDriverByUserId(lineUserId) || {},
    yearMonth: yearMonth,
  });
}

// ===== OCR修正保存 =====

function handleAdminSaveCorrection_(payload) {
  var lineUserId  = payload.lineUserId;
  var yearMonth   = payload.yearMonth;
  var corrections = payload.corrections; // [{ day, fixedStart, fixedEnd }]

  var ss    = SpreadsheetApp.openById(SHEET_ID);
  var sheet = ss.getSheetByName(SHEET_OCR);
  var data  = sheet.getDataRange().getValues();

  var corrMap = {};
  corrections.forEach(function(c) { corrMap[c.day] = c; });

  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    if (row[0] !== lineUserId || row[2] !== yearMonth) continue;
    var c = corrMap[row[3]];
    if (!c) continue;
    var isWorking = c.fixedStart !== '';
    sheet.getRange(i + 1, 7).setValue(isWorking);     // 稼働フラグ
    sheet.getRange(i + 1, 10).setValue('修正済み');    // 確認ステータス
    sheet.getRange(i + 1, 11).setValue(c.fixedStart); // 修正後開始時間
    sheet.getRange(i + 1, 12).setValue(c.fixedEnd);   // 修正後終了時間
  }

  return jsonResponse({ status: 'ok' });
}

// ===== 月次確定 =====

function handleAdminConfirmMonth_(payload) {
  var lineUserId = payload.lineUserId;
  var yearMonth  = payload.yearMonth;
  var driver     = getDriverByUserId(lineUserId);
  if (!driver) return jsonResponse({ error: 'driver not found' });

  var ss      = SpreadsheetApp.openById(SHEET_ID);
  var ocrData = ss.getSheetByName(SHEET_OCR).getDataRange().getValues();

  var workingDays  = 0;
  var totalMinutes = 0;
  ocrData.slice(1).forEach(function(row) {
    if (row[0] !== lineUserId || row[2] !== yearMonth) return;
    var startStr = row[10] || row[4];
    var endStr   = row[11] || row[5];
    if (!startStr) return;
    workingDays++;
    var s = timeToMinutes_(startStr);
    var e = timeToMinutes_(endStr);
    if (s !== null && e !== null && e > s) totalMinutes += e - s;
  });

  var billingAmount = workingDays * (driver.unitPrice || 0);

  // 月次確定シートへ書き込み（既存行は上書き）
  var monthSheet = ss.getSheetByName(SHEET_MONTHLY);
  var monthData  = monthSheet.getDataRange().getValues();
  var targetRow  = -1;
  for (var i = 1; i < monthData.length; i++) {
    if (monthData[i][0] === lineUserId && monthData[i][2] === yearMonth) {
      targetRow = i + 1; break;
    }
  }
  var rowValues = [
    lineUserId, driver.name, yearMonth, workingDays,
    totalMinutes, 0, driver.unitPrice, billingAmount, new Date()
  ];
  if (targetRow > 0) {
    monthSheet.getRange(targetRow, 1, 1, rowValues.length).setValues([rowValues]);
  } else {
    monthSheet.appendRow(rowValues);
  }

  // 受信ファイルのステータスを「確定」に更新
  var recvSheet = ss.getSheetByName(SHEET_RECEIVED);
  var recvData  = recvSheet.getDataRange().getValues();
  for (var j = 1; j < recvData.length; j++) {
    if (recvData[j][1] === lineUserId && recvData[j][3] === yearMonth) {
      recvSheet.getRange(j + 1, 8).setValue('確定');
    }
  }

  return jsonResponse({ status: 'ok', workingDays: workingDays, billingAmount: billingAmount });
}

// ===== 集計データ出力 =====

function handleAdminExportData_(payload) {
  var yearMonth   = payload.yearMonth;
  var ss          = SpreadsheetApp.openById(SHEET_ID);
  var monthlyData = ss.getSheetByName(SHEET_MONTHLY).getDataRange().getValues();
  var driverData  = ss.getSheetByName(SHEET_DRIVER).getDataRange().getValues();

  var driverMap = {};
  driverData.slice(1).forEach(function(row) {
    if (row[0]) driverMap[row[0]] = { site: row[2] };
  });

  var rows = monthlyData.slice(1)
    .filter(function(row) { return row[2] === yearMonth; })
    .map(function(row) {
      return {
        driverName:    row[1],
        site:          (driverMap[row[0]] || {}).site || '',
        yearMonth:     row[2],
        workingDays:   row[3],
        totalHours:    row[4] ? Math.round(row[4] / 60 * 10) / 10 : 0,
        unitPrice:     row[6],
        billingAmount: row[7],
        confirmedAt:   row[8] ? Utilities.formatDate(new Date(row[8]), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm') : '',
      };
    });

  rows.sort(function(a, b) { return a.driverName.localeCompare(b.driverName, 'ja'); });
  return jsonResponse({ rows: rows, yearMonth: yearMonth });
}

// ===== ユーティリティ =====

function timeToMinutes_(timeStr) {
  if (!timeStr) return null;
  var parts = String(timeStr).split(':');
  if (parts.length < 2) return null;
  var h = parseInt(parts[0], 10);
  var m = parseInt(parts[1], 10);
  if (isNaN(h) || isNaN(m)) return null;
  return h * 60 + m;
}
