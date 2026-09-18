import assert from "node:assert/strict";
import test from "node:test";

import {
  firstUsefulLine,
  toPlainText,
} from "../../site/scripts/apply-budget-ocr-text.mjs";

test("予算表のMarkdownを1行1行の平文にする", () => {
  const markdown = [
    "- 4 -",
    "",
    "### 第 一 表　歳 入 歳 出 予 算",
    "",
    "| 款 | 項 | 金 額 (千円) |",
    "| :--- | :--- | ---: |",
    "| 1. 市 税 | | 9,911,450 |",
    "| | 1. 市 民 税 | 4,423,410 |",
  ].join("\n");

  assert.equal(
    toPlainText(markdown),
    [
      "- 4 -",
      "",
      "第 一 表 歳 入 歳 出 予 算",
      "",
      "| 款 | 項 | 金 額 (千円) |",
      "| 1. 市 税 |  | 9,911,450 |",
      "|  | 1. 市 民 税 | 4,423,410 |",
    ].join("\n")
  );
});

test("空セルを落とさないので列位置が変わらない", () => {
  const markdown = [
    "| 目 | 本年度予算額 | 前年度予算額 | 比較 | 節 区分 | 節 金額 | 説 明 |",
    "| :--- | ---: | ---: | ---: | :--- | ---: | :--- |",
    "| 1 個 人 | 3,824,034 | 3,578,175 | 245,859 | 1 現年課税分 | 3,806,670 | 納税義務者数 38,570人 |",
    "| | | | | 2 滞納繰越分 | 17,364 | 税額 49,898 収納率 34.8% |",
  ].join("\n");

  const lines = toPlainText(markdown).split("\n");

  assert.deepEqual(lines, [
    "| 目 | 本年度予算額 | 前年度予算額 | 比較 | 節 区分 | 節 金額 | 説 明 |",
    "| 1 個 人 | 3,824,034 | 3,578,175 | 245,859 | 1 現年課税分 | 3,806,670 | 納税義務者数 38,570人 |",
    "|  |  |  |  | 2 滞納繰越分 | 17,364 | 税額 49,898 収納率 34.8% |",
  ]);
  // 「2 滞納繰越分」が節区分（5列目）に残っていること
  assert.equal(lines[2].split("|")[5].trim(), "2 滞納繰越分");
  // 見出し行と明細行の列数が一致すること
  assert.equal(lines[0].split("|").length, lines[2].split("|").length);
});

test("セル内のHTMLと強調を落として列を保つ", () => {
  const markdown = "| **1 議会費** | 177,853 | <br><table><tr><td>報酬 90,840</td></tr></table> |";

  assert.equal(toPlainText(markdown), "| 1 議会費 | 177,853 | 報酬 90,840 |");
});

test("エスケープされた記号と見出し記号を戻す", () => {
  const markdown = ["#### 歳\\-入", "\\- 301 \\-"].join("\n");

  assert.equal(toPlainText(markdown), ["歳-入", "- 301 -"].join("\n"));
});

test("ページ番号だけの行は見出しにしない", () => {
  const text = ["－ 4 －", "- 5 -", "199", "第 一 表 歳 入 歳 出 予 算", "1. 市 税"].join("\n");

  assert.equal(firstUsefulLine(text, 10), "第 一 表 歳 入 歳 出 予 算");
  assert.equal(firstUsefulLine("－ 4 －", 10), "10ページ");
});
