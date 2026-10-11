/**
 * Opening the control plane's database at start: the adapter the
 * environment names (PGlite in INVISIBLE_DOTS_HOME/db, or DATABASE_URL),
 * migrated, and checked against a master key that was lost.
 */
import { Database, databaseTarget, describeDatabaseTarget } from "@invisible-dots/database";
import { errorMessage, type Logger } from "@invisible-dots/shared";

export interface OpenDatabaseOptions {
  env: Record<string, string | undefined>;
  masterKey: Uint8Array;
  logger: Logger;
}

/** Open and migrate; a failure names the database and is never left half open. */
export async function openControlPlaneDatabase(options: OpenDatabaseOptions): Promise<Database> {
  const target = databaseTarget(options.env);
  const where = describeDatabaseTarget(target);
  // Both adapters already name the database they could not open (pg without
  // its password), so the error is passed on as it is.
  const db = await Database.open({ target, masterKey: options.masterKey });
  try {
    // Before anything reads or writes: a second server on the same database
    // (another INVISIBLE_DOTS_HOME with the same DATABASE_URL) would take
    // over the first one's Dots.
    if (!(await db.holdInstanceLock())) {
      throw new Error(`another invisible-dots server already uses the ${where}; stop it first (one server per database)`);
    }
  } catch (error) {
    await db.close().catch(() => {});
    throw error;
  }
  try {
    const migrated = await db.migrate({ log: (line) => options.logger.info(line) });
    options.logger.info("database ready", {
      database: where,
      applied: migrated.applied.length,
      total: migrated.applied.length + migrated.alreadyApplied.length,
    });
  } catch (error) {
    await db.close().catch(() => {});
    throw new Error(`cannot migrate the ${where}: ${errorMessage(error)}`, { cause: error });
  }
  return db;
}

/**
 * Refuse a newly generated master key for a database that already holds
 * values encrypted under another one: the key file was lost or deleted,
 * and going on would leave every Dot token and secret unreadable.
 */
export async function assertNothingEncrypted(db: Database, masterKeyPath: string): Promise<void> {
  if (await db.holdsEncryptedValues()) {
    throw new Error(
      `${masterKeyPath} does not exist, but the database holds Dot tokens or secrets encrypted under a master key: ` +
        `restore the original master.key (a new one cannot read them), then start again`,
    );
  }
}
