import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { DataSource } from 'typeorm';
import { createDatabaseOptions } from './database.options';
import { M001RoomDeviceSessionSchema1792022400000 } from './migrations/1792022400000-M001RoomDeviceSessionSchema';
import { M002QuestionLibrary1792108800000 } from './migrations/1792108800000-M002QuestionLibrary';
import { M003Surveys1792195200000 } from './migrations/1792195200000-M003Surveys';
import { M004MatchesAndRounds1792281600000 } from './migrations/1792281600000-M004MatchesAndRounds';
import { M005MatchEventsAndScores1792368000000 } from './migrations/1792368000000-M005MatchEventsAndScores';

const MIGRATION_NAME = 'M001RoomDeviceSessionSchema1792022400000';
const REPOSITORY_ROOT = resolve(__dirname, '../../../..');
const MIGRATION_FILE = join(__dirname, 'migrations', '*{.ts,.js}');

describe('M001 room/device/session migration', () => {
  let temporaryDirectory: string;
  let databasePath: string;

  beforeAll(() => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'friend-feud-m001-'));
    databasePath = join(temporaryDirectory, 'isolated.sqlite');
    seedExistingDatabase(databasePath);
    runProjectMigration(databasePath);
  });

  afterAll(() => {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  it('runs through the project TypeORM CLI and preserves existing migration/SQLite/unrelated tables', () => {
    expect(isAbsoluteTemporaryPath(databasePath)).toBe(true);
    const configuredOptions = createDatabaseOptions(databasePath);
    expect(configuredOptions.migrations).toEqual([MIGRATION_FILE]);
    expect(configuredOptions.synchronize).toBe(false);
    expect(configuredOptions.migrationsRun).toBe(false);

    runProjectMigration(databasePath);

    const database = new Database(databasePath);
    try {
      const tableNames = database.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      ).all() as Array<{ name: string }>;
      expect(tableNames.map((row) => row.name)).toEqual([
        'device_sessions',
        'devices',
        'external_test_data',
        'match_commands',
        'match_events',
        'match_round_answers',
        'match_rounds',
        'match_score_entries',
        'matches',
        'migrations',
        'question_revision_answers',
        'question_revisions',
        'question_sources',
        'questions',
        'room_members',
        'rooms',
        'sequence_probe',
        'sqlite_sequence',
        'survey_answer_variants',
        'survey_responses',
        'survey_review_events',
        'surveys',
      ]);

      const migrationRows = database.prepare('SELECT id, timestamp, name FROM migrations ORDER BY id').all();
      expect(migrationRows).toEqual([
        { id: 7, timestamp: 1000, name: 'ExistingMigrationBeforeM001' },
        { id: 8, timestamp: 1792022400000, name: MIGRATION_NAME },
        { id: 9, timestamp: 1792108800000, name: 'M002QuestionLibrary1792108800000' },
        { id: 10, timestamp: 1792195200000, name: 'M003Surveys1792195200000' },
        { id: 11, timestamp: 1792281600000, name: 'M004MatchesAndRounds1792281600000' },
        { id: 12, timestamp: 1792368000000, name: 'M005MatchEventsAndScores1792368000000' },
      ]);
      expect(database.prepare('SELECT id, value FROM external_test_data').all()).toEqual([
        { id: 1, value: 'must remain unchanged' },
      ]);
      expect(database.prepare("SELECT name, seq FROM sqlite_sequence ORDER BY name").all()).toEqual([
        { name: 'migrations', seq: 12 },
        { name: 'sequence_probe', seq: 3 },
      ]);

      expect(indexNames(database, 'rooms')).toContain('ux_rooms_join_code_hash');
      expect(indexNames(database, 'room_members')).toEqual(expect.arrayContaining([
        'ux_room_members_room_device',
        'ux_room_members_id_device',
        'ux_room_members_one_owner_per_room',
        'ux_room_members_one_current_host_per_room',
      ]));
      expect(indexNames(database, 'device_sessions')).toContain('ux_device_sessions_token_hash');
      expect(columnNames(database, 'rooms')).toEqual(expect.arrayContaining([
        'id', 'join_code_hash', 'status', 'created_at', 'empty_since_at', 'cleanup_after', 'deactivated_at',
      ]));
      expect(columnNames(database, 'devices')).toEqual(['id', 'created_at']);
      expect(columnNames(database, 'room_members')).toEqual(expect.arrayContaining([
        'room_id', 'device_id', 'device_role', 'team', 'status', 'is_owner', 'is_current_host',
      ]));
      expect(columnNames(database, 'device_sessions')).toEqual(expect.arrayContaining([
        'device_id', 'room_member_id', 'token_hash', 'created_at', 'last_seen_at', 'expires_at', 'revoked_at',
      ]));
      expect(database.pragma('foreign_key_check')).toEqual([]);
    } finally {
      database.close();
    }
  });

  it('enforces uniqueness, partial owner/host indexes, domain checks, and membership uniqueness', () => {
    const database = new Database(databasePath);
    try {
      insertRoom(database, 'room-one', 'hash-one');
      insertDevice(database, 'device-one');
      insertDevice(database, 'device-two');
      insertMember(database, 'member-one', 'room-one', 'device-one', {
        deviceRole: 'host_ui',
        isOwner: 1,
        isCurrentHost: 1,
      });

      expect(() => insertRoom(database, 'room-two', 'hash-one')).toThrow();
      expect(() => insertMember(database, 'member-one-duplicate', 'room-one', 'device-one')).toThrow();
      expect(() => insertMember(database, 'member-second-owner', 'room-one', 'device-two', { isOwner: 1 })).toThrow();
      expect(() => insertMember(database, 'member-second-host', 'room-one', 'device-two', { isCurrentHost: 1 })).toThrow();
      expect(() => insertMember(database, 'member-bad-status', 'room-one', 'device-two', { status: 'online' })).toThrow();
      expect(() => insertMember(database, 'member-bad-role', 'room-one', 'device-two', { deviceRole: 'admin' })).toThrow();
      expect(() => insertMember(database, 'member-team-without-team', 'room-one', 'device-two', { deviceRole: 'team_ui' })).toThrow();
      expect(() => insertMember(database, 'member-team-bad-value', 'room-one', 'device-two', { deviceRole: 'team_ui', team: 'team_three' })).toThrow();
      expect(() => insertMember(database, 'member-bad-boolean', 'room-one', 'device-two', { isOwner: 2 })).toThrow();
      expect(() => insertMember(database, 'member-host-not-active', 'room-one', 'device-two', {
        status: 'left',
        endedAt: 1100,
        isCurrentHost: 1,
      })).toThrow();
      expect(() => database.prepare(`
        INSERT INTO rooms (id, join_code_hash, status, created_at, deactivated_at)
        VALUES ('bad-room', 'hash-bad', 'open', 1000, 1100)
      `).run()).toThrow();
      expect(() => database.prepare(`
        INSERT INTO rooms (id, join_code_hash, status, created_at, empty_since_at, cleanup_after)
        VALUES ('bad-cleanup', 'hash-cleanup', 'open', 1000, 1001, 61000)
      `).run()).toThrow();
    } finally {
      database.close();
    }
  });

  it('enables foreign keys on separate TypeORM connections and rejects mismatched session member/device pairs', async () => {
    const firstDataSource = await createTestDataSource(databasePath).initialize();
    const secondDataSource = await createTestDataSource(databasePath).initialize();
    try {
      expect(await firstDataSource.query('PRAGMA foreign_keys')).toEqual([{ foreign_keys: 1 }]);
      expect(await secondDataSource.query('PRAGMA foreign_keys')).toEqual([{ foreign_keys: 1 }]);

      await firstDataSource.query(`
        INSERT INTO rooms (id, join_code_hash, status, created_at)
        VALUES ('session-room', 'session-room-hash', 'open', 1000)
      `);
      await firstDataSource.query(`INSERT INTO devices (id, created_at) VALUES ('session-device-one', 1000)`);
      await firstDataSource.query(`INSERT INTO devices (id, created_at) VALUES ('session-device-two', 1000)`);
      await firstDataSource.query(`
        INSERT INTO room_members (id, room_id, device_id, device_role, team, created_at)
        VALUES ('session-member-one', 'session-room', 'session-device-one', 'team_ui', 'team_one', 1000)
      `);

      await expect(firstDataSource.query(`
        INSERT INTO device_sessions
          (id, device_id, room_member_id, token_hash, created_at, last_seen_at, expires_at)
        VALUES ('bad-session', 'session-device-two', 'session-member-one', 'session-token-bad', 1000, 1000, 2000)
      `)).rejects.toThrow();

      await firstDataSource.query(`
        INSERT INTO device_sessions
          (id, device_id, room_member_id, token_hash, created_at, last_seen_at, expires_at)
        VALUES ('session-one', 'session-device-one', 'session-member-one', 'session-token-one', 1000, 1100, 2000)
      `);
      await expect(firstDataSource.query(`
        INSERT INTO device_sessions
          (id, device_id, room_member_id, token_hash, created_at, last_seen_at, expires_at)
        VALUES ('session-two', 'session-device-one', 'session-member-one', 'session-token-one', 1000, 1100, 2000)
      `)).rejects.toThrow();
      await expect(firstDataSource.query(`
        INSERT INTO device_sessions
          (id, device_id, room_member_id, token_hash, created_at, last_seen_at, expires_at)
        VALUES ('session-expired-before-created', 'session-device-one', 'session-member-one', 'session-token-two', 1000, 1000, 1000)
      `)).rejects.toThrow();

      expect(await firstDataSource.query('PRAGMA foreign_key_check')).toEqual([]);
    } finally {
      await firstDataSource.destroy();
      await secondDataSource.destroy();
    }
  });

  it('reverses the full migration chain on the isolated database and preserves legacy tables/data', async () => {
    const dataSource = await createTestDataSource(databasePath).initialize();
    try {
      await dataSource.query(`INSERT INTO rooms (id, join_code_hash, status, created_at) VALUES ('down-room', 'down-hash', 'open', 1000)`);
      await dataSource.undoLastMigration();
      await dataSource.undoLastMigration();
      await dataSource.undoLastMigration();
      await dataSource.undoLastMigration();
      await dataSource.undoLastMigration();
    } finally {
      await dataSource.destroy();
    }

    const database = new Database(databasePath);
    try {
      const tableRows = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as Array<{ name: string }>;
      const tables = tableRows.map((row) => row.name);
      expect(tables).toEqual(['external_test_data', 'migrations', 'sequence_probe', 'sqlite_sequence']);
      expect(database.prepare('SELECT id, value FROM external_test_data').all()).toEqual([
        { id: 1, value: 'must remain unchanged' },
      ]);
      expect(database.prepare('SELECT id, timestamp, name FROM migrations ORDER BY id').all()).toEqual([
        { id: 7, timestamp: 1000, name: 'ExistingMigrationBeforeM001' },
      ]);
    } finally {
      database.close();
    }
  });
});

function seedExistingDatabase(databasePath: string): void {
  const database = new Database(databasePath);
  try {
    database.exec(`
      CREATE TABLE migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        timestamp BIGINT NOT NULL,
        name VARCHAR NOT NULL
      );
      INSERT INTO migrations (id, timestamp, name) VALUES (7, 1000, 'ExistingMigrationBeforeM001');
      CREATE TABLE external_test_data (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO external_test_data (id, value) VALUES (1, 'must remain unchanged');
      CREATE TABLE sequence_probe (id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT NOT NULL);
      INSERT INTO sequence_probe (id, value) VALUES (3, 'sequence must remain');
    `);
  } finally {
    database.close();
  }
}

function runProjectMigration(databasePath: string): void {
  const npmCommand = process.platform === 'win32' ? 'npm.cmd run db:migrate' : 'npm run db:migrate';
  execSync(npmCommand, {
    cwd: REPOSITORY_ROOT,
    env: { ...process.env, DATABASE_PATH: databasePath },
    stdio: 'pipe',
  });
}

function createTestDataSource(databasePath: string): DataSource {
  const options = createDatabaseOptions(databasePath);
  return new DataSource({
    ...options,
    migrations: [
      M001RoomDeviceSessionSchema1792022400000,
      M002QuestionLibrary1792108800000,
      M003Surveys1792195200000,
      M004MatchesAndRounds1792281600000,
      M005MatchEventsAndScores1792368000000,
    ],
  });
}

function insertRoom(database: Database.Database, id: string, joinCodeHash: string): void {
  database.prepare(`
    INSERT INTO rooms (id, join_code_hash, status, created_at)
    VALUES (?, ?, 'open', 1000)
  `).run(id, joinCodeHash);
}

function insertDevice(database: Database.Database, id: string): void {
  database.prepare('INSERT INTO devices (id, created_at) VALUES (?, 1000)').run(id);
}

function insertMember(
  database: Database.Database,
  id: string,
  roomId: string,
  deviceId: string,
  overrides: {
    deviceRole?: string;
    team?: string | null;
    status?: string;
    isOwner?: number;
    isCurrentHost?: number;
    endedAt?: number | null;
  } = {},
): void {
  database.prepare(`
    INSERT INTO room_members
      (id, room_id, device_id, device_role, team, status, is_owner, is_current_host, created_at, ended_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1000, ?)
  `).run(
    id,
    roomId,
    deviceId,
    overrides.deviceRole ?? 'display_ui',
    overrides.team ?? null,
    overrides.status ?? 'active',
    overrides.isOwner ?? 0,
    overrides.isCurrentHost ?? 0,
    overrides.endedAt ?? null,
  );
}

function indexNames(database: Database.Database, tableName: string): string[] {
  const indexes = database.pragma(`index_list('${tableName}')`) as Array<{ name: string }>;
  return indexes.map((row) => row.name);
}

function columnNames(database: Database.Database, tableName: string): string[] {
  const columns = database.pragma(`table_info('${tableName}')`) as Array<{ name: string }>;
  return columns.map((row) => row.name);
}

function isAbsoluteTemporaryPath(databasePath: string): boolean {
  return resolve(databasePath) === databasePath && databasePath.startsWith(resolve(tmpdir()));
}
