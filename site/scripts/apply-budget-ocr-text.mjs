#!/usr/bin/env node
/**
 * 外部OCRで作った予算書ページ本文を data/{city}/budgets/{year}/ と site/data/ へ適用する。
 *
 * PDFテキスト層が無い予算書（A3横長の表が中心の資料）は pdftotext でも tesseract でも
 * 表の中身が取れない。そうした資料はページ画像を外部のOCR（レイアウトを保つ指示つきのVLM等）に
 * 通し、ページ単位のMarkdownを用意してこのスクリプトで取り込む。
 *
 * 既にテキストが取れているページ（既定で100文字以上）は上書きしないので、
 * 読めたページの品質を落とさずに欠落ページだけを埋められる。
 *
 * 使い方（リポジトリ直下でも site/ 配下でも実行できる）:
 *   node site/scripts/apply-budget-ocr-text.mjs \
 *     --sources site/scripts/budget-ocr-sources/eniwa-2026.json \
 *     --ocr-dir /path/to/ocr-markdown \
 *     [--min-ocr-chars 100] [--min-current-chars 100] [--dry-run]
 *
 * OCRファイルの名前: <sources[].file から拡張子を除いた名前>.p001.md
 *   sources は元PDFの連結順。3桁ゼロ埋めの番号は各PDF内のページ番号で、
 *   連結した通し番号が data/{city}/budgets/{year}/manifest.json の page に対応する。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const DATA_ROOTS = [path.join(REPO_ROOT, "data"), path.join(REPO_ROOT, "site", "data")];

function printHelp() {
  console.log(`Usage:
  node site/scripts/apply-budget-ocr-text.mjs --sources <json> --ocr-dir <dir> [options]

Options:
  --sources <path>         sources記述子（site/scripts/budget-ocr-sources/ 配下）
  --ocr-dir <dir>          OCRテキスト（Markdown）を置いたディレクトリ
  --min-ocr-chars <n>      OCRテキストを採用する最小文字数（既定 100）
  --min-current-chars <n>  この文字数以上の既存ページは上書きしない（既定 100）
  --dry-run                書き込まずに対象件数とサンプルだけ表示する
  --help
`);
}

function parseArgs(argv) {
  const options = { minOcrChars: 100, minCurrentChars: 100, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg.startsWith("--")) {
      const rawKey = arg.slice(2);
      const key = rawKey.replace(/-([a-z])/gu, (_, char) => char.toUpperCase());
      const value = argv[++i];
      if (value == null || value.startsWith("--")) throw new Error(`Missing value for --${rawKey}`);
      options[key] = key.endsWith("Chars") ? Number(value) : value;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.help && (!options.sources || !options.ocrDir)) {
    throw new Error("--sources and --ocr-dir are required");
  }
  return options;
}

/** ページ番号だけの行（全角・半角・各種ダッシュ）を本文の見出しと誤認しないための判定。 */
function isPageNumberLine(line) {
  return /^[-\u2212\uFF0D\u30FC\s]*\d+[-\u2212\uFF0D\u30FC\s]*$/u.test(line);
}

/** 表のセル内のHTML断片を、` | ` 区切りの1行に収まる平文へ落とす。 */
function cellToText(value) {
  return value
    .replace(/<br\s*\/?>/giu, " / ")
    .replace(/<\/(?:td|th|tr)>/giu, " / ")
    .replace(/<[^>]*>/gu, "")
    .replace(/&nbsp;/gu, " ")
    .replace(/&amp;/gu, "&")
    .replace(/\*\*(.+?)\*\*/gu, "$1")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^(?:\/\s*)+/u, "")
    .replace(/(?:\s*\/)+$/u, "")
    .replace(/(?:\s*\/\s*){2,}/gu, " / ");
}

/**
 * OCRのMarkdownを、サイトのOCR表示（等幅の <pre>）と行単位の検索に合わせた平文へ整える。
 * 表は「1行=1行」を保ち、列は ` | ` で区切り、外側も `|` で囲む。
 * 空セルは落とさない（落とすと「節」列の行が「目」列に見えるなど列位置の情報が壊れるため）。
 */
function toPlainText(markdown) {
  const lines = [];
  for (const rawLine of markdown.replace(/\r\n/gu, "\n").split("\n")) {
    const unescaped = rawLine.replace(/\\([\\`*_{}[\]()#+\-.!|>])/gu, "$1");
    if (/^\s*\|/u.test(unescaped)) {
      const cells = unescaped
        .replace(/^\s*\|/u, "")
        .replace(/\|\s*$/u, "")
        .split("|")
        .map(cellToText);
      if (cells.every((cell) => /^:?-{2,}:?$/u.test(cell))) continue;
      lines.push(`| ${cells.join(" | ")} |`.replace(/\s+$/u, ""));
      continue;
    }
    // ページ番号の行はそのまま残す（先頭のダッシュを箇条書き記号として落とさない）
    const trimmed = unescaped.trim();
    if (isPageNumberLine(trimmed)) {
      lines.push(trimmed);
      continue;
    }
    lines.push(
      cellToText(
        unescaped
          .replace(/^\s{0,3}#{1,6}\s*/u, "")
          .replace(/\*\*(.+?)\*\*/gu, "$1")
          .replace(/^\s*[-*]\s+/u, "")
      )
    );
  }

  return lines
    .join("\n")
    .replace(/[ \t]+$/gmu, "")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function firstUsefulLine(text, pageNumber) {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length >= 3 && !isPageNumberLine(line)) ?? `${pageNumber}ページ`
  );
}

function previewText(text) {
  return text.replace(/\s+/gu, " ").trim().slice(0, 180);
}

function readManifest(dataRoot, city, year) {
  const manifestPath = path.join(dataRoot, city, "budgets", year, "manifest.json");
  return { manifestPath, manifest: JSON.parse(fs.readFileSync(manifestPath, "utf-8")) };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const descriptor = JSON.parse(fs.readFileSync(options.sources, "utf-8"));
  const { city, year, document: documentName, engine, sources } = descriptor;
  const ocrFileNameSuffix = descriptor.ocr_file_suffix ?? "";
  if (!city || !year || !documentName || !engine || !Array.isArray(sources) || !sources.length) {
    throw new Error(`invalid sources descriptor: ${options.sources}`);
  }

  // OCRテキストを sources の順に連結し、通しページ番号へ割り当てる
  const ocrPages = new Map();
  let pageNumber = 0;
  const ranges = [];
  for (const source of sources) {
    const prefix = path.basename(source.file, path.extname(source.file));
    const rangeStart = pageNumber + 1;
    for (let index = 1; index <= source.pages; index += 1) {
      pageNumber += 1;
      const fileName = `${prefix}.p${String(index).padStart(3, "0")}${ocrFileNameSuffix}.md`;
      const ocrPath = path.join(options.ocrDir, fileName);
      if (!fs.existsSync(ocrPath)) throw new Error(`missing OCR text: ${ocrPath}`);
      const text = toPlainText(fs.readFileSync(ocrPath, "utf-8"));
      ocrPages.set(pageNumber, { text, sourceFileName: source.file, length: text.length });
    }
    ranges.push({ sourceFileName: source.file, pageStart: rangeStart, pageEnd: pageNumber });
  }

  const generatedAt = new Date().toISOString();
  const summary = [];

  for (const dataRoot of DATA_ROOTS) {
    const { manifestPath, manifest } = readManifest(dataRoot, city, year);
    if (manifest.page_count !== pageNumber) {
      throw new Error(
        `page count mismatch: ${path.relative(REPO_ROOT, manifestPath)} has ${manifest.page_count}, descriptor has ${pageNumber}`
      );
    }

    const pagesDir = path.join(dataRoot, city, "budgets", year, "pages");
    const appliedPerSource = new Map();
    let applied = 0;
    const samples = [];

    for (const page of manifest.pages) {
      const ocr = ocrPages.get(page.page);
      if (!ocr) throw new Error(`page not found in descriptor: ${page.page}`);
      if (ocr.length < options.minOcrChars) continue;
      // 読み取れているページは触らない。同じエンジンで入れたページは再実行時に更新する（冪等）。
      if (page.text_length >= options.minCurrentChars && page.ocr?.engine !== engine) continue;

      const fileName = `page-${String(page.page).padStart(3, "0")}.md`;
      if (!options.dryRun) {
        fs.writeFileSync(
          path.join(pagesDir, fileName),
          `---\npage: ${page.page}\nsource: ${documentName}\nocr: ${engine}\nocr_source: ${ocr.sourceFileName}\n---\n\n${ocr.text}\n`,
          "utf-8"
        );
      }
      page.title = firstUsefulLine(ocr.text, page.page);
      page.preview = previewText(ocr.text);
      page.text_length = ocr.length;
      page.ocr = { engine, source_file_name: ocr.sourceFileName };
      appliedPerSource.set(ocr.sourceFileName, (appliedPerSource.get(ocr.sourceFileName) ?? 0) + 1);
      applied += 1;
      if (samples.length < 3) samples.push({ page: page.page, title: page.title });
    }

    if (!options.dryRun) {
      const previousPatches = Array.isArray(manifest.ocr_patches) ? manifest.ocr_patches : [];
      manifest.ocr_patches = [
        ...previousPatches.filter((patch) => patch.engine !== engine),
        ...ranges
          .filter((range) => appliedPerSource.has(range.sourceFileName))
          .map((range) => ({
            source_file_name: range.sourceFileName,
            page_start: range.pageStart,
            page_end: range.pageEnd,
            engine,
            applied_pages: appliedPerSource.get(range.sourceFileName),
            generated_at: generatedAt,
          })),
      ];
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
    }

    summary.push({ dataRoot: path.relative(REPO_ROOT, dataRoot), applied, samples });
  }

  console.log(`${city}/${year}: ${pageNumber}ページ（${sources.length}ファイル）を照合`);
  for (const entry of summary) {
    console.log(`- ${entry.dataRoot}: OCRで補完 ${entry.applied}ページ`);
    for (const sample of entry.samples) console.log(`    p.${sample.page} ${sample.title}`);
  }
  console.log(options.dryRun ? "dry-run: 書き込みなし" : "書き込み完了");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

export { toPlainText, firstUsefulLine };
