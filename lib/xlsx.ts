/**
 * A one-sheet .xlsx from a header and typed rows, without a dependency: the
 * Office Open XML parts in a stored (uncompressed) ZIP.
 *
 * Why not a CSV: Drive converts a CSV with the spreadsheet locale of the
 * account (data@ may be fr_FR), so « 1245.3 » can land as text or a date and
 * « 1245,3 » breaks in en_US. An .xlsx cell carries its type: a number is a
 * number (`<v>1245.3</v>`, always a dot, per the spec) whatever the locale of
 * the account or of the reader, and a text is a text — « =… » is never read
 * as a formula. Drive converts it to a Google Sheet just the same.
 */

import type { SheetCell } from "@/lib/sheet-values";

export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// XML 1.0 forbids most control characters, even escaped.
const INVALID_XML_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g;
export const xmlEscape = (s: string): string =>
  s.replace(INVALID_XML_RE, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** 0 → A, 25 → Z, 26 → AA. */
export function columnName(index: number): string {
  let n = index + 1;
  let out = "";
  while (n > 0) { const r = (n - 1) % 26; out = String.fromCharCode(65 + r) + out; n = Math.floor((n - 1) / 26); }
  return out;
}

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const NS_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships";

/** How one data cell looks in the sheet: a fill and a text colour (RRGGBB), bold. */
export interface XlsxCellStyle { fill?: string; color?: string; bold?: boolean }
/** Styles of the data rows, by row then column (same shape as `rows`; holes = plain). */
export type XlsxStyles = Array<Array<XlsxCellStyle | undefined> | undefined>;

const HEX = /^[0-9A-Fa-f]{6}$/;
/** The fonts, fills and cell formats a sheet uses: 0 = plain, 1 = header (bold); the rest is added as cells ask for it. */
function styleRegistry() {
  const fonts = ['<font><sz val="10"/><name val="Arial"/></font>', '<font><b/><sz val="10"/><name val="Arial"/></font>'];
  const fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
  const xfs = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>', '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>'];
  const fontIds = new Map<string, number>(); const fillIds = new Map<string, number>(); const xfIds = new Map<string, number>();
  const idOf = (st: XlsxCellStyle | undefined): number => {
    const fill = st?.fill && HEX.test(st.fill) ? st.fill.toUpperCase() : ""; const color = st?.color && HEX.test(st.color) ? st.color.toUpperCase() : ""; const bold = st?.bold === true;
    if (!fill && !color && !bold) return 0;
    const key = `${fill}|${color}|${bold ? 1 : 0}`;
    const known = xfIds.get(key);
    if (known !== undefined) return known;
    let fontId = 0;
    if (color || bold) {
      const fk = `${color}|${bold ? 1 : 0}`;
      fontId = fontIds.get(fk) ?? (fontIds.set(fk, fonts.length), fonts.push(`<font>${bold ? "<b/>" : ""}<sz val="10"/>${color ? `<color rgb="FF${color}"/>` : ""}<name val="Arial"/></font>`) - 1);
    }
    let fillId = 0;
    if (fill) fillId = fillIds.get(fill) ?? (fillIds.set(fill, fills.length), fills.push(`<fill><patternFill patternType="solid"><fgColor rgb="FF${fill}"/><bgColor indexed="64"/></patternFill></fill>`) - 1);
    const id = xfs.push(`<xf numFmtId="0" fontId="${fontId}" fillId="${fillId}" borderId="0" xfId="0"${fontId ? ' applyFont="1"' : ""}${fillId ? ' applyFill="1"' : ""}/>`) - 1;
    xfIds.set(key, id);
    return id;
  };
  const xml = () => `${XML_HEAD}<styleSheet xmlns="${NS_MAIN}"><fonts count="${fonts.length}">${fonts.join("")}</fonts><fills count="${fills.length}">${fills.join("")}</fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${xfs.length}">${xfs.join("")}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
  return { idOf, xml };
}

/** The worksheet, shared-strings and styles XML of a header (bold, frozen, with filter buttons when asked) and rows. */
export function worksheetXml(columns: string[], rows: SheetCell[][], opts: { styles?: XlsxStyles; autoFilter?: boolean } = {}): { sheet: string; sharedStrings: string; styles: string } {
  const strings: string[] = [];
  const index = new Map<string, number>();
  const sst = (s: string) => {
    let i = index.get(s);
    if (i === undefined) { i = strings.length; strings.push(s); index.set(s, i); }
    return i;
  };
  const registry = styleRegistry();
  const width = columns.length;
  const cell = (v: SheetCell | undefined, ref: string, styleId: number) => {
    const style = styleId ? ` s="${styleId}"` : "";
    // An empty cell is written only when it carries a style (a coloured blank).
    if (v === null || v === undefined || v === "") return styleId ? `<c r="${ref}"${style}/>` : "";
    if (typeof v === "number") return Number.isFinite(v) ? `<c r="${ref}"${style}><v>${v}</v></c>` : "";
    return `<c r="${ref}"${style} t="s"><v>${sst(v)}</v></c>`;
  };
  const rowXml = (cells: Array<SheetCell | undefined>, r: number, styleOf: (j: number) => number) =>
    `<row r="${r}">${Array.from({ length: width }, (_, j) => cell(cells[j], `${columnName(j)}${r}`, styleOf(j))).join("")}</row>`;
  const body = [rowXml(columns, 1, () => 1), ...rows.map((row, i) => rowXml(row, i + 2, (j) => registry.idOf(opts.styles?.[i]?.[j])))].join("");
  const filter = opts.autoFilter && width > 0 ? `<autoFilter ref="A1:${columnName(width - 1)}${rows.length + 1}"/>` : "";
  const sheet = `${XML_HEAD}<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetData>${body}</sheetData>${filter}</worksheet>`;
  const sharedStrings = `${XML_HEAD}<sst xmlns="${NS_MAIN}" count="${strings.length}" uniqueCount="${strings.length}">${strings.map((s) => `<si><t xml:space="preserve">${xmlEscape(s)}</t></si>`).join("")}</sst>`;
  return { sheet, sharedStrings, styles: registry.xml() };
}

/** A sheet name Excel and Sheets accept: ≤ 31 characters, none of []:*?/\. */
export const safeSheetName = (name: string): string => name.replace(/[[\]:*?/\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 31) || "Tableau";

/** The .xlsx parts (path → XML). */
export function xlsxParts(columns: string[], rows: SheetCell[][], sheetName = "Tableau", opts: { styles?: XlsxStyles; autoFilter?: boolean } = {}): Record<string, string> {
  const { sheet, sharedStrings, styles } = worksheetXml(columns, rows, opts);
  return {
    "[Content_Types].xml": `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`,
    "_rels/.rels": `${XML_HEAD}<Relationships xmlns="${NS_PKG_REL}"><Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml": `${XML_HEAD}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><sheets><sheet name="${xmlEscape(safeSheetName(sheetName))}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `${XML_HEAD}<Relationships xmlns="${NS_PKG_REL}"><Relationship Id="rId1" Type="${NS_REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${NS_REL}/styles" Target="styles.xml"/><Relationship Id="rId3" Type="${NS_REL}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
    "xl/styles.xml": styles,
    "xl/worksheets/sheet1.xml": sheet,
    "xl/sharedStrings.xml": sharedStrings,
  };
}

// ── ZIP (stored) ────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A ZIP archive of the files as they are (method 0, UTF-8 names): enough for an .xlsx. */
export function zipStored(files: Record<string, string | Buffer>, at: Date = new Date()): Buffer {
  const time = ((at.getHours() << 11) | (at.getMinutes() << 5) | Math.floor(at.getSeconds() / 2)) & 0xffff;
  const date = (((Math.max(at.getFullYear(), 1980) - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate()) & 0xffff;
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = typeof content === "string" ? Buffer.from(content, "utf8") : content;
    const fname = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(fname.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, fname, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // made by
    central.writeUInt16LE(20, 6); // needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(fname.length, 28);
    // extra, comment, disk, internal attrs, external attrs: 0
    central.writeUInt32LE(offset, 42);
    centrals.push(central, fname);
    offset += 30 + fname.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  const count = Object.keys(files).length;
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** The .xlsx bytes of a header and typed rows. */
export function toXlsx(columns: string[], rows: SheetCell[][], sheetName?: string, opts: { styles?: XlsxStyles; autoFilter?: boolean } = {}): Buffer {
  return zipStored(xlsxParts(columns, rows, sheetName, opts));
}
