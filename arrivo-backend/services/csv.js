// CSV writing for the operations exports.
//
// Two things matter here beyond "put commas between values".
//
// 1. Quoting. A name with a comma, a quote or a line break in it has to be
//    wrapped in quotes with inner quotes doubled, or the row splits in the
//    wrong place and every column after it shifts.
//
// 2. Spreadsheet formula injection. Excel and Google Sheets run a cell as a
//    formula when it starts with = + - or @. Rider names, addresses and
//    notes are typed by the public, so someone could register as
//    =HYPERLINK("http://evil","click") and have it run on whichever staff
//    member opens the export. Prefixing a single quote makes the sheet show
//    the text as text. Phone numbers and negative amounts legitimately start
//    with + or -, so a value that looks like a plain number is left alone.

const NUMBER_LIKE = /^[+-]?[\d\s().,-]+$/;
const ALWAYS_DANGEROUS = /^[=@\t\r]/;
const SIGN_PREFIX = /^[+-]/;

function csvCell(value) {
  if (value === null || value === undefined) return "";

  let text;
  if (value instanceof Date) text = value.toISOString();
  else if (typeof value === "boolean") text = value ? "yes" : "no";
  else if (typeof value === "object") text = JSON.stringify(value);
  else text = String(value);

  if (typeof value !== "number") {
    if (ALWAYS_DANGEROUS.test(text)) text = `'${text}`;
    else if (SIGN_PREFIX.test(text) && !NUMBER_LIKE.test(text)) text = `'${text}`;
  }

  if (/[",\r\n]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

function csvLine(values) {
  return values.map(csvCell).join(",") + "\r\n";
}

// Excel assumes a legacy code page for a CSV with no byte order mark and
// garbles names like "Adébáyò". The BOM makes it read the file as UTF-8.
const UTF8_BOM = "﻿";

module.exports = { csvCell, csvLine, UTF8_BOM };
