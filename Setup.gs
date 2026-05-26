// 初回セットアップ用。実行後は削除してOK。

function setupSheets() {
  var ss = SpreadsheetApp.openById(SHEET_ID);

  var schemas = [
    {
      name: SHEET_RECEIVED,
      headers: ['タイムスタンプ', 'LINEユーザーID', 'ドライバー名', '年月', 'ファイル種別', 'DriveファイルID', 'DriveURL', 'ステータス', 'OCR実行日時']
    },
    {
      name: SHEET_OCR,
      headers: ['LINEユーザーID', 'ドライバー名', '年月', '日', '開始時間', '終了時間', '稼働フラグ', '立替経費フラグ', '備考フラグ', '確認ステータス', '修正後開始時間', '修正後終了時間', '受信ファイルID']
    },
    {
      name: SHEET_DRIVER,
      headers: ['LINEユーザーID', 'ドライバー名', '現場名', '単価(税別)', '基準拘束時間(分)', '休憩時間(分)']
    },
    {
      name: SHEET_MONTHLY,
      headers: ['LINEユーザーID', 'ドライバー名', '年月', '稼働日数', '実働時間合計(分)', '超過時間合計(分)', '単価', '請求金額', '確定日時']
    }
  ];

  schemas.forEach(function(schema) {
    var sheet = ss.getSheetByName(schema.name);
    if (!sheet) {
      sheet = ss.insertSheet(schema.name);
    }
    sheet.getRange(1, 1, 1, schema.headers.length).setValues([schema.headers]);
    sheet.getRange(1, 1, 1, schema.headers.length)
      .setFontWeight('bold')
      .setBackground('#e8f0fe');
  });

  // デフォルトの「シート1」を削除
  var defaultSheet = ss.getSheetByName('シート1');
  if (defaultSheet && ss.getSheets().length > 1) {
    ss.deleteSheet(defaultSheet);
  }

  Logger.log('シート作成完了: ' + schemas.map(function(s){ return s.name; }).join(', '));
}
