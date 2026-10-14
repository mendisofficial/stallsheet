export type SaleRow = {
  weekend: string;
  item: string;
  priceCents: number;
  qtyMade: number;
  qtySold: number;
  weather: string;
  notes: string;
};

export function parseSalesCsv(text: string): SaleRow[] {
  const lines = text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length < 2) {
    throw new Error("CSV needs a header and at least one sale.");
  }

  const header = splitCsvLine(lines[0]).map((cell) => cell.trim().toLowerCase());
  const index = (name: string) => {
    const found = header.indexOf(name);
    if (found === -1) throw new Error(`CSV is missing a "${name}" column.`);
    return found;
  };
  const columns = {
    weekend: index("weekend"),
    item: index("item"),
    price: index("price"),
    qtyMade: index("qty_made"),
    qtySold: index("qty_sold"),
    weather: index("weather"),
    notes: header.indexOf("notes"),
  };

  return lines.slice(1).map((line, rowNumber) => {
    const cells = splitCsvLine(line);
    const price = Number(cells[columns.price]);
    const qtyMade = Number(cells[columns.qtyMade]);
    const qtySold = Number(cells[columns.qtySold]);
    if (!Number.isFinite(price) || !Number.isFinite(qtyMade) || !Number.isFinite(qtySold)) {
      throw new Error(`Row ${rowNumber + 2} has a price or quantity that is not a number.`);
    }
    const weekend = cells[columns.weekend]?.trim() ?? "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(weekend)) {
      throw new Error(`Row ${rowNumber + 2} weekend must be YYYY-MM-DD.`);
    }
    return {
      weekend,
      item: (cells[columns.item] ?? "").trim(),
      priceCents: Math.round(price * 100),
      qtyMade: Math.round(qtyMade),
      qtySold: Math.round(qtySold),
      weather: (cells[columns.weather] ?? "").trim().toLowerCase(),
      notes: columns.notes === -1 ? "" : (cells[columns.notes] ?? "").trim(),
    };
  });
}

function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}
