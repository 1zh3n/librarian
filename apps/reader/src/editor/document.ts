export type TextEdit = { readonly from: number; readonly to: number; readonly insert: string };

export type SourceDocument = {
  readonly value: string;
  // Offsets of the line breaks represented by two code units in the original.
  readonly crlf: readonly number[];
};

export function readSource(value: string): SourceDocument {
  const crlf: number[] = [];
  for (const match of value.matchAll(/\r\n/g)) {
    crlf.push(match.index - crlf.length);
  }
  return { value, crlf };
}

export function editorText(source: string): string {
  return source.replace(/\r\n?/g, "\n");
}

function countBefore(
  crlf: readonly number[],
  offset: number,
  originalCoordinates: boolean,
): number {
  let from = 0;
  let to = crlf.length;
  while (from < to) {
    const mid = Math.floor((from + to) / 2);
    const newline = crlf[mid]!;
    if (newline + (originalCoordinates ? mid : 0) < offset) {
      from = mid + 1;
    } else {
      to = mid;
    }
  }
  return from;
}

export function originalOffset(source: SourceDocument, offset: number): number {
  return offset + countBefore(source.crlf, offset, false);
}

export function editorOffset(source: SourceDocument, offset: number): number {
  return offset - countBefore(source.crlf, offset, true);
}

export function applyTextEdits(source: string, edits: readonly TextEdit[]): string {
  const chunks: string[] = [];
  let end = 0;
  for (const { from, to, insert } of edits) {
    if (
      !Number.isInteger(from) ||
      !Number.isInteger(to) ||
      from < end ||
      to < from ||
      to > source.length
    ) {
      throw new RangeError("Markdown edits must be ordered, non-overlapping source ranges");
    }
    chunks.push(source.slice(end, from), insert);
    end = to;
  }
  chunks.push(source.slice(end));
  return chunks.join("");
}
