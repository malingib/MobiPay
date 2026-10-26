import { createHash } from "node:crypto";

export type ImportedStatementRow = {
  providerReference: string;
  merchantReference: string;
  amountMinor: number;
  currency: string;
  occurredAt: string | null;
  raw: Record<string, string>;
};

function parseCsvMatrix(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i=0; i<input.length; i++) {
    const char=input[i]!;
    if (quoted) {
      if (char === '"') {
        if (input[i+1] === '"') { field += '"'; i++; }
        else quoted=false;
      } else field += char;
      continue;
    }
    if (char === '"' && field.length === 0) quoted=true;
    else if (char === ",") { row.push(field); field=""; }
    else if (char === "\n") { row.push(field.replace(/\r$/, "")); rows.push(row); row=[]; field=""; }
    else field += char;
  }
  if (quoted) throw new Error("CSV contains an unterminated quoted field");
  if (field.length || row.length) { row.push(field.replace(/\r$/, "")); rows.push(row); }
  return rows.filter((r) => !(r.length===1 && r[0]?.trim()===""));
}

export function parseStatementCsv(input: string): ImportedStatementRow[] {
  if (!input.trim()) throw new Error("CSV content is empty");
  const matrix=parseCsvMatrix(input);
  if (matrix.length<2) throw new Error("CSV must contain a header and at least one data row");
  if (matrix.length>5001) throw new Error("CSV exceeds the 5000 row import limit");
  const headers=matrix[0]!.map((h)=>h.trim().toLowerCase());
  const required=["provider_reference","merchant_reference","amount_minor","currency"];
  for (const name of required) if (!headers.includes(name)) throw new Error(`CSV is missing required column: ${name}`);
  if (new Set(headers).size!==headers.length || headers.some((h)=>!h)) throw new Error("CSV headers must be non-empty and unique");
  const rows: ImportedStatementRow[]=[];
  for (let i=1;i<matrix.length;i++) {
    const cells=matrix[i]!;
    if (cells.length!==headers.length) throw new Error(`CSV row ${i+1} has a different number of columns than the header`);
    const raw=Object.fromEntries(headers.map((h,j)=>[h,cells[j]!.trim()]));
    const amountMinor=Number(raw.amount_minor);
    const currency=raw.currency.toUpperCase();
    if (!Number.isSafeInteger(amountMinor) || amountMinor<=0) throw new Error(`CSV row ${i+1} has an invalid amount_minor`);
    if (!/^[A-Z]{3}$/.test(currency)) throw new Error(`CSV row ${i+1} has an invalid currency`);
    const occurredAt=raw.occurred_at || null;
    if (occurredAt && Number.isNaN(Date.parse(occurredAt))) throw new Error(`CSV row ${i+1} has an invalid occurred_at date`);
    rows.push({
      providerReference: raw.provider_reference,
      merchantReference: raw.merchant_reference,
      amountMinor,
      currency,
      occurredAt,
      raw,
    });
  }
  return rows;
}

export function sha256Statement(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}
