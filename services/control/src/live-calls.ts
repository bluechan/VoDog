import type {Db} from './db.js';

/**
 * S100: the one "call still in flight" predicate. It is the `call_records_live_idx` partial-index
 * predicate verbatim, so every query that splices it in keeps using that index.
 */
export const liveCallSql = (alias: string) => `${alias}.state NOT IN ('ending','ended','failed','unknown')`;

/** True while any gateway has a call in flight. */
export async function hasLiveCalls(db: Pick<Db, 'query'>): Promise<boolean> {
  return ((await db.query(`SELECT 1 FROM call_records call WHERE ${liveCallSql('call')} LIMIT 1`)).rowCount ?? 0) > 0;
}
