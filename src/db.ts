import pg from "pg";
import { config } from "./config.js";
import { EMBEDDING_DIMS, embedText, toVectorLiteral } from "./embed.js";
import type { SaleRow } from "./csv.js";

const { Pool } = pg;

let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = config().databaseUrl;
    const needsSsl = /sslmode=(require|verify-ca|verify-full)/.test(connectionString);
    const url = new URL(connectionString);
    url.searchParams.delete("sslmode");
    url.searchParams.delete("uselibpqcompat");
    pool = new Pool({
      connectionString: url.toString(),
      ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
    });
  }
  return pool;
}

export async function migrate(): Promise<void> {
  const db = getPool();
  await db.query("CREATE EXTENSION IF NOT EXISTS vector");
  await db.query(`
    CREATE TABLE IF NOT EXISTS sales (
      id bigserial PRIMARY KEY,
      market_id text NOT NULL,
      weekend date NOT NULL,
      item text NOT NULL,
      price_cents integer NOT NULL,
      qty_made integer NOT NULL,
      qty_sold integer NOT NULL,
      weather text NOT NULL,
      notes text NOT NULL DEFAULT '',
      search_text text NOT NULL,
      embedding vector(${EMBEDDING_DIMS}) NOT NULL
    )
  `);
  await db.query(`
    ALTER TABLE sales
    ADD COLUMN IF NOT EXISTS search_tsv tsvector
    GENERATED ALWAYS AS (to_tsvector('english', search_text)) STORED
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS sheets (
      id bigserial PRIMARY KEY,
      run_id text NOT NULL UNIQUE,
      market_id text NOT NULL,
      payload jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS sales_market_idx ON sales (market_id, weekend)
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS sales_tsv_idx ON sales USING gin (search_tsv)
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS sales_embedding_idx
    ON sales USING hnsw (embedding vector_cosine_ops)
  `).catch(() => undefined);
}

export async function replaceSales(marketId: string, rows: SaleRow[]): Promise<number> {
  const db = getPool();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM sales WHERE market_id = $1", [marketId]);
    for (const row of rows) {
      const searchText = `${row.item} ${row.weather} ${row.notes}`.trim();
      await client.query(
        `INSERT INTO sales
          (market_id, weekend, item, price_cents, qty_made, qty_sold, weather, notes, search_text, embedding)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::vector)`,
        [
          marketId,
          row.weekend,
          row.item,
          row.priceCents,
          row.qtyMade,
          row.qtySold,
          row.weather,
          row.notes,
          searchText,
          toVectorLiteral(embedText(searchText)),
        ],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return rows.length;
}

export async function listSales(marketId: string): Promise<SaleRow[]> {
  const result = await getPool().query<{
    weekend: Date;
    item: string;
    price_cents: number;
    qty_made: number;
    qty_sold: number;
    weather: string;
    notes: string;
  }>(
    `SELECT weekend, item, price_cents, qty_made, qty_sold, weather, notes
     FROM sales WHERE market_id = $1 ORDER BY weekend, item`,
    [marketId],
  );
  return result.rows.map((row) => ({
    weekend: row.weekend.toISOString().slice(0, 10),
    item: row.item,
    priceCents: row.price_cents,
    qtyMade: row.qty_made,
    qtySold: row.qty_sold,
    weather: row.weather,
    notes: row.notes,
  }));
}

export async function countSales(marketId: string): Promise<number> {
  const result = await getPool().query<{ count: string }>(
    "SELECT count(*)::text AS count FROM sales WHERE market_id = $1",
    [marketId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

export type SimilarWeekend = {
  weekend: string;
  weather: string;
  notes: string;
  score: number;
  highlight: string;
};

export async function hybridSearch(marketId: string, query: string): Promise<SimilarWeekend[]> {
  const embedding = toVectorLiteral(embedText(query));
  const hasBm25 = await extensionInstalled("pg_textsearch");
  const sql = hasBm25 ? bm25HybridSql() : tsvectorHybridSql();
  const result = await getPool().query<{
    weekend: Date;
    weather: string;
    notes: string;
    score: number;
    highlight: string;
  }>(sql, [marketId, embedding, query]);
  return result.rows.map((row) => ({
    weekend: row.weekend.toISOString().slice(0, 10),
    weather: row.weather,
    notes: row.notes,
    score: Number(row.score),
    highlight: row.highlight,
  }));
}

async function extensionInstalled(name: string): Promise<boolean> {
  const result = await getPool().query("SELECT 1 FROM pg_extension WHERE extname = $1", [name]);
  return result.rowCount !== null && result.rowCount > 0;
}

function tsvectorHybridSql(): string {
  return `
    WITH vector_hits AS (
      SELECT weekend, weather, notes, item, qty_sold,
             ROW_NUMBER() OVER (ORDER BY embedding <=> $2::vector) AS rank
      FROM sales
      WHERE market_id = $1
      ORDER BY embedding <=> $2::vector
      LIMIT 20
    ),
    keyword_hits AS (
      SELECT weekend, weather, notes, item, qty_sold,
             ROW_NUMBER() OVER (
               ORDER BY ts_rank(search_tsv, plainto_tsquery('english', $3)) DESC
             ) AS rank
      FROM sales
      WHERE market_id = $1
        AND search_tsv @@ plainto_tsquery('english', $3)
      LIMIT 20
    ),
    fused AS (
      SELECT rows.weekend, rows.weather, rows.notes, rows.item, rows.qty_sold,
             COALESCE(1.0 / (60 + v.rank), 0) + COALESCE(1.0 / (60 + k.rank), 0) AS score
      FROM (
        SELECT DISTINCT weekend, weather, notes, item, qty_sold FROM vector_hits
        UNION
        SELECT DISTINCT weekend, weather, notes, item, qty_sold FROM keyword_hits
      ) rows
      LEFT JOIN vector_hits v ON v.weekend = rows.weekend AND v.item = rows.item
      LEFT JOIN keyword_hits k ON k.weekend = rows.weekend AND k.item = rows.item
    )
    SELECT fused.weekend, fused.weather,
           string_agg(DISTINCT fused.notes, '; ') AS notes,
           max(fused.score) AS score,
           string_agg(fused.item || ' sold ' || fused.qty_sold, ', ' ORDER BY fused.qty_sold DESC) AS highlight
    FROM fused
    GROUP BY fused.weekend, fused.weather
    ORDER BY max(fused.score) DESC
    LIMIT 3
  `;
}

function bm25HybridSql(): string {
  return `
    WITH vector_hits AS (
      SELECT weekend, weather, notes, item, qty_sold,
             ROW_NUMBER() OVER (ORDER BY embedding <=> $2::vector) AS rank
      FROM sales
      WHERE market_id = $1
      ORDER BY embedding <=> $2::vector
      LIMIT 20
    ),
    keyword_hits AS (
      SELECT weekend, weather, notes, item, qty_sold,
             ROW_NUMBER() OVER (ORDER BY search_text <@> $3) AS rank
      FROM sales
      WHERE market_id = $1
      ORDER BY search_text <@> $3
      LIMIT 20
    ),
    fused AS (
      SELECT rows.weekend, rows.weather, rows.notes, rows.item, rows.qty_sold,
             COALESCE(1.0 / (60 + v.rank), 0) + COALESCE(1.0 / (60 + k.rank), 0) AS score
      FROM (
        SELECT DISTINCT weekend, weather, notes, item, qty_sold FROM vector_hits
        UNION
        SELECT DISTINCT weekend, weather, notes, item, qty_sold FROM keyword_hits
      ) rows
      LEFT JOIN vector_hits v ON v.weekend = rows.weekend AND v.item = rows.item
      LEFT JOIN keyword_hits k ON k.weekend = rows.weekend AND k.item = rows.item
    )
    SELECT fused.weekend, fused.weather,
           string_agg(DISTINCT fused.notes, '; ') AS notes,
           max(fused.score) AS score,
           string_agg(fused.item || ' sold ' || fused.qty_sold, ', ' ORDER BY fused.qty_sold DESC) AS highlight
    FROM fused
    GROUP BY fused.weekend, fused.weather
    ORDER BY max(fused.score) DESC
    LIMIT 3
  `;
}

export type SheetPayload = Record<string, unknown>;

export async function saveSheetOnce(
  runId: string,
  marketId: string,
  payload: SheetPayload,
): Promise<SheetPayload> {
  const inserted = await getPool().query<{ payload: SheetPayload }>(
    `INSERT INTO sheets (run_id, market_id, payload)
     VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (run_id) DO NOTHING
     RETURNING payload`,
    [runId, marketId, JSON.stringify(payload)],
  );
  if (inserted.rows[0]) return inserted.rows[0].payload;
  const existing = await getPool().query<{ payload: SheetPayload }>(
    "SELECT payload FROM sheets WHERE run_id = $1",
    [runId],
  );
  return existing.rows[0]?.payload ?? payload;
}
