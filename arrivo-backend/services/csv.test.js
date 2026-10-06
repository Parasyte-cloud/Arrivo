const test = require("node:test");
const assert = require("node:assert/strict");
const { csvCell, csvLine, UTF8_BOM } = require("./csv");

test("plain values pass through and nulls are empty", () => {
  assert.equal(csvCell("Adebayo"), "Adebayo");
  assert.equal(csvCell(null), "");
  assert.equal(csvCell(undefined), "");
  assert.equal(csvCell(5000), "5000");
  assert.equal(csvCell(true), "yes");
  assert.equal(csvCell(false), "no");
});

test("commas, quotes and line breaks are quoted so columns do not shift", () => {
  assert.equal(csvCell("Lekki, Lagos"), '"Lekki, Lagos"');
  assert.equal(csvCell('He said "go"'), '"He said ""go"""');
  assert.equal(csvCell("line one\nline two"), '"line one\nline two"');
  assert.equal(csvCell("a\r\nb"), '"a\r\nb"');
});

test("formula injection is neutralised in text from the public", () => {
  assert.equal(csvCell('=HYPERLINK("http://x","y")'), `"'=HYPERLINK(""http://x"",""y"")"`);
  assert.equal(csvCell("=1+1"), "'=1+1");
  assert.equal(csvCell("@SUM(A1)"), "'@SUM(A1)");
  assert.equal(csvCell("+cmd|' /C calc'!A0"), `'+cmd|' /C calc'!A0`);
  assert.equal(csvCell("-2+3+cmd"), "'-2+3+cmd");
  assert.equal(csvCell("\tTabbed"), "'\tTabbed");
  assert.equal(csvCell("\rCarriage"), "\"'\rCarriage\"");
});

test("phone numbers and negative amounts are not mangled", () => {
  assert.equal(csvCell("+234 801 234 5678"), "+234 801 234 5678");
  assert.equal(csvCell("+2348012345678"), "+2348012345678");
  assert.equal(csvCell("-5000"), "-5000");
  assert.equal(csvCell("-5000.50"), "-5000.50");
  assert.equal(csvCell(-5000), "-5000");
  assert.equal(csvCell("(0801) 234-5678"), "(0801) 234-5678");
});

test("dates and objects are written sensibly", () => {
  assert.equal(csvCell(new Date("2026-10-06T14:00:00Z")), "2026-10-06T14:00:00.000Z");
  assert.equal(csvCell({ a: 1 }), '"{""a"":1}"');
});

test("a line ends with CRLF and joins cells with commas", () => {
  assert.equal(csvLine(["a", "b,c", null]), 'a,"b,c",\r\n');
});

test("the BOM is the UTF-8 marker Excel needs", () => {
  assert.equal(UTF8_BOM, "﻿");
});
