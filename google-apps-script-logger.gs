// Google Apps Script: Pantry Anomaly Logger v2
// Deploy as: Web App (Execute as: Me, Access: Anyone)
//
// SETUP:
// 1. Create a Google Sheet
// 2. Open Extensions > Apps Script
// 3. Paste this code, run setupSheet() once
// 4. Deploy > New Deployment > Web App
// 5. Copy the URL into the Pantry Monitor Settings tab
//
// Dashboard POSTs:
// { "entries": [{ "detectedAt", "deviceId", "severity", "type", "msg", "group" }] }

function setupSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("AnomalyLog") || ss.insertSheet("AnomalyLog");

  var headers = ["Timestamp", "Pantry", "Severity", "Group", "Type", "Details", "Logged At"];
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.getRange(1, 1, 1, headers.length).setFontWeight("bold");
  sheet.setFrozenRows(1);
  for (var i = 1; i <= headers.length; i++) sheet.autoResizeColumn(i);

  // Conditional formatting on severity column (C)
  var range = sheet.getRange("C:C");
  var rules = sheet.getConditionalFormatRules();
  rules.push(
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo("critical").setBackground("#f4cccc").setFontColor("#990000").setRanges([range]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo("warning").setBackground("#fce5cd").setFontColor("#b45309").setRanges([range]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo("ok").setBackground("#d9ead3").setFontColor("#137333").setRanges([range]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo("info").setBackground("#cfe2f3").setFontColor("#1155cc").setRanges([range]).build()
  );
  sheet.setConditionalFormatRules(rules);

  // Summary sheet
  var summary = ss.getSheetByName("Summary") || ss.insertSheet("Summary");
  summary.getRange("A1").setValue("Pantry Anomaly Summary").setFontWeight("bold").setFontSize(14);

  summary.getRange("A3:B3").setValues([["Metric", "Value"]]).setFontWeight("bold");
  summary.getRange("A4").setValue("Total anomalies");
  summary.getRange("B4").setFormula('=COUNTA(AnomalyLog!A:A)-1');
  summary.getRange("A5").setValue("Critical");
  summary.getRange("B5").setFormula('=COUNTIF(AnomalyLog!C:C,"critical")');
  summary.getRange("A6").setValue("Warnings");
  summary.getRange("B6").setFormula('=COUNTIF(AnomalyLog!C:C,"warning")');
  summary.getRange("A7").setValue("Info");
  summary.getRange("B7").setFormula('=COUNTIF(AnomalyLog!C:C,"info")');
  summary.getRange("A8").setValue("Last logged");
  summary.getRange("B8").setFormula('=MAX(AnomalyLog!G:G)');
  summary.getRange("B8").setNumberFormat("MMM d, yyyy HH:mm");

  // Per-group counts
  summary.getRange("A10").setValue("By Group").setFontWeight("bold");
  var groups = ["Connectivity","Power","Environment","Scales","Doors","Events","Time Series","System"];
  for (var g = 0; g < groups.length; g++) {
    summary.getRange("A" + (11 + g)).setValue(groups[g]);
    summary.getRange("B" + (11 + g)).setFormula('=COUNTIF(AnomalyLog!D:D,"' + groups[g] + '")');
  }

  // Per-device counts
  summary.getRange("D3").setValue("By Device").setFontWeight("bold");
  summary.getRange("D4:E4").setValues([["Device", "Count"]]).setFontWeight("bold");
  // These will need manual update as devices are discovered, or use a pivot table

  Logger.log("Setup complete.");
}

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    var entries = data.entries || [];
    if (entries.length === 0) {
      return ContentService.createTextOutput(JSON.stringify({ status: "ok", message: "No entries" }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("AnomalyLog");
    if (!sheet) { setupSheet(); sheet = ss.getSheetByName("AnomalyLog"); }

    var rows = entries.map(function(entry) {
      return [
        entry.detectedAt || new Date().toISOString(),
        entry.deviceId || "unknown",
        entry.severity || "info",
        entry.group || "",
        entry.type || "unknown",
        entry.msg || "",
        new Date().toISOString()
      ];
    });

    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);

    return ContentService.createTextOutput(JSON.stringify({ status: "ok", logged: rows.length }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ status: "error", message: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function doGet(e) {
  return ContentService.createTextOutput(JSON.stringify({
    status: "ok",
    message: "Pantry Anomaly Logger v2. POST to log entries. Run setupSheet() to initialize."
  })).setMimeType(ContentService.MimeType.JSON);
}
