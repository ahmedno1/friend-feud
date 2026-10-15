import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DataSourceOptions } from 'typeorm';

export function createDatabaseOptions(databasePath?: string): DataSourceOptions {
  const repositoryRoot = resolve(__dirname, '../../../..');
  const database = resolve(repositoryRoot, databasePath ?? 'data/friend-feud.sqlite');

  mkdirSync(dirname(database), { recursive: true });

  return {
    type: 'better-sqlite3',
    database,
    entities: [],
    migrations: [join(__dirname, 'migrations', '*{.ts,.js}')],
    migrationsRun: false,
    synchronize: false,
  };
}
