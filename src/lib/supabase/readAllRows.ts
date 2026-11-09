// The Data API returns at most this many rows per request (supabase/config.toml
// `max_rows`), so longer lists are read in chunks of this size.
export const DATA_API_MAX_ROWS = 1000;

type RangeResult<Row> = PromiseLike<{
  data: Row[] | null;
  error: { message: string } | null;
}>;

/**
 * Reads every row of a list that may be longer than one Data API response.
 * `readRange(from, to)` must apply a stable order (e.g. ending with the id) so
 * chunks never overlap or skip rows. Chunks are read one after another until a
 * short one, so a list under DATA_API_MAX_ROWS costs a single request.
 */
export async function readAllRows<Row>(
  readRange: (fromRow: number, toRow: number) => RangeResult<Row>,
  failureLabel: string,
): Promise<Row[]> {
  const rows: Row[] = [];
  for (let fromRow = 0; ; fromRow += DATA_API_MAX_ROWS) {
    const { data, error } = await readRange(
      fromRow,
      fromRow + DATA_API_MAX_ROWS - 1,
    );
    if (error) throw new Error(`${failureLabel}: ${error.message}`);
    rows.push(...(data ?? []));
    if ((data ?? []).length < DATA_API_MAX_ROWS) return rows;
  }
}
