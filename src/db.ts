import { createClient, type Client } from "@libsql/client";
let client: Client | undefined;
export async function getDb(): Promise<Client> {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken || !url.startsWith("libsql://")) throw new Error("Turso credentials required; local DB fallback is disabled");
  return client ??= createClient({ url, authToken, fetch: (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => fetch(input, {
    ...init,
    signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(init?.signal ? [init.signal] : [])]),
  }) });
}
// Schema belongs to the private ETL project. Never migrate it from this crawler.
export const getDbWithSchema = getDb;
export function closeDb() { client?.close(); }
