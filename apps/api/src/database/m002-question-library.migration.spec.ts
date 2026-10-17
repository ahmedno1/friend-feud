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

const M001_NAME = 'M001RoomDeviceSessionSchema1792022400000';
const M002_NAME = 'M002QuestionLibrary1792108800000';
const REPOSITORY_ROOT = resolve(__dirname, '../../../..');

describe('M002 question library migration in the full migration chain', () => {
  let temporaryDirectory: string;
  let databasePath: string;
  let database: Database.Database;

  beforeAll(() => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'friend-feud-m002-'));
    databasePath = join(temporaryDirectory, 'isolated-m002.sqlite');
    seedLegacyDatabase(databasePath);
    runProjectMigrations(databasePath);
    database = new Database(databasePath);
    database.pragma('foreign_keys = ON');
    seedRoomMember(database);
  });

  afterAll(() => {
    database?.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  it('applies M001 through M005 through the project CLI and preserves legacy/M001/M002 data', () => {
    expect(databasePath.startsWith(resolve(tmpdir()))).toBe(true);
    expect(createDatabaseOptions(databasePath)).toMatchObject({ synchronize: false, migrationsRun: false });
    expect(tableNames(database)).toEqual([
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
    expect(database.prepare('SELECT id, value FROM external_test_data').all()).toEqual([
      { id: 1, value: 'legacy row must remain unchanged' },
    ]);
    expect(database.prepare('SELECT id, join_code_hash, status FROM rooms WHERE id = ?').all('legacy-room')).toEqual([
      { id: 'legacy-room', join_code_hash: 'legacy-room-hash', status: 'open' },
    ]);
    expect(database.prepare('SELECT id, device_role FROM room_members WHERE id = ?').all('legacy-member')).toEqual([
      { id: 'legacy-member', device_role: 'host_ui' },
    ]);
    expect(database.prepare('SELECT timestamp, name FROM migrations ORDER BY id').all()).toEqual([
      { timestamp: 1000, name: 'LegacyMigrationBeforeM001' },
      { timestamp: 1792022400000, name: M001_NAME },
      { timestamp: 1792108800000, name: M002_NAME },
      { timestamp: 1792195200000, name: 'M003Surveys1792195200000' },
      { timestamp: 1792281600000, name: 'M004MatchesAndRounds1792281600000' },
      { timestamp: 1792368000000, name: 'M005MatchEventsAndScores1792368000000' },
    ]);
    expect(database.pragma('foreign_key_check')).toEqual([]);
  });

  it('rejects revisions that reference missing questions and duplicate revision numbers', () => {
    insertSource(database, 'source-fk');
    expect(() => insertRevision(database, 'missing-question-revision', 'missing-question', 1)).toThrow();

    insertQuestion(database, 'question-revision-unique', 'source-fk');
    insertRevision(database, 'revision-one', 'question-revision-unique', 1);
    expect(() => insertRevision(database, 'revision-one-duplicate', 'question-revision-unique', 1)).toThrow();
  });

  it('enforces answer ordering, normalized uniqueness, and safe non-negative points', () => {
    insertSource(database, 'source-answers');
    insertQuestion(database, 'question-answers', 'source-answers');
    insertRevision(database, 'revision-answers', 'question-answers', 1);
    insertAnswer(database, 'answer-one', 'revision-answers', 'Text A', 'text-a', 1, 10);

    expect(() => insertAnswer(database, 'answer-order-duplicate', 'revision-answers', 'Text B', 'text-b', 1, 20)).toThrow();
    expect(() => insertAnswer(database, 'answer-normalized-duplicate', 'revision-answers', 'Same meaning', 'text-a', 2, 20)).toThrow();
    expect(() => insertAnswer(database, 'answer-negative', 'revision-answers', 'Negative', 'negative', 3, -1)).toThrow();
    expect(() => insertAnswer(database, 'answer-too-large', 'revision-answers', 'Too large', 'too-large', 3, Number.MAX_SAFE_INTEGER + 1)).toThrow();
    insertAnswer(
      database,
      'answer-exact-safe-total',
      'revision-answers',
      'Exact safe total',
      'exact-safe-total',
      3,
      Number.MAX_SAFE_INTEGER - 10,
    );
    expect(() => insertAnswer(database, 'answer-total-overflow', 'revision-answers', 'Overflow', 'overflow', 4, 1)).toThrow();
    insertAnswer(database, 'answer-zero', 'revision-answers', 'Zero points', 'zero-points', 2, 0);
    expect(database.prepare('SELECT points FROM question_revision_answers WHERE id = ?').get('answer-zero')).toEqual({ points: 0 });
    expect(database.prepare('SELECT SUM(points) AS total FROM question_revision_answers WHERE revision_id = ?').get('revision-answers'))
      .toEqual({ total: Number.MAX_SAFE_INTEGER });
  });

  it('requires an answer before approval and prevents update/delete of approved revisions and answers', () => {
    insertSource(database, 'source-immutable');
    insertQuestion(database, 'question-immutable', 'source-immutable');
    insertRevision(database, 'revision-immutable-empty', 'question-immutable', 1);
    expect(() => approveRevision(database, 'revision-immutable-empty')).toThrow(/at least one answer/);

    insertAnswer(database, 'answer-immutable', 'revision-immutable-empty', 'Immutable', 'immutable', 1, 15);
    approveRevision(database, 'revision-immutable-empty');
    expect(() => database.prepare('UPDATE question_revisions SET question_text = ? WHERE id = ?').run('changed', 'revision-immutable-empty')).toThrow(/immutable/);
    expect(() => database.prepare('UPDATE question_revisions SET status = ? WHERE id = ?').run('rejected', 'revision-immutable-empty')).toThrow(/immutable/);
    expect(() => database.prepare('DELETE FROM question_revisions WHERE id = ?').run('revision-immutable-empty')).toThrow(/cannot be deleted/);
    expect(() => database.prepare('UPDATE question_revision_answers SET points = 30 WHERE id = ?').run('answer-immutable')).toThrow(/immutable/);
    expect(() => database.prepare('DELETE FROM question_revision_answers WHERE id = ?').run('answer-immutable')).toThrow(/cannot be deleted/);
    expect(() => insertAnswer(database, 'answer-after-approval', 'revision-immutable-empty', 'Late', 'late', 2, 1)).toThrow(/immutable/);
  });

  it('publishes the selected approved revision and keeps previous approved versions unchanged', () => {
    insertSource(database, 'source-publish');
    insertQuestion(database, 'question-publish', 'source-publish');
    insertRevision(database, 'revision-publish-one', 'question-publish', 1, 'Original prompt');
    insertAnswer(database, 'answer-publish-one', 'revision-publish-one', 'First', 'first', 1, 25);
    approveRevision(database, 'revision-publish-one');
    publishRevision(database, 'question-publish', 'revision-publish-one', 1200);

    insertRevision(database, 'revision-publish-two', 'question-publish', 2, 'Updated prompt');
    insertAnswer(database, 'answer-publish-two', 'revision-publish-two', 'Second', 'second', 1, 35);
    approveRevision(database, 'revision-publish-two');
    publishRevision(database, 'question-publish', 'revision-publish-two', 1400);

    expect(database.prepare(`
      SELECT q.status, q.current_published_revision_id, r.revision_number, r.question_text
      FROM questions q
      JOIN question_revisions r
        ON r.question_id = q.id AND r.id = q.current_published_revision_id
      WHERE q.id = ?
    `).get('question-publish')).toEqual({
      status: 'published',
      current_published_revision_id: 'revision-publish-two',
      revision_number: 2,
      question_text: 'Updated prompt',
    });
    expect(database.prepare('SELECT id, status, question_text FROM question_revisions WHERE question_id = ? ORDER BY revision_number').all('question-publish')).toEqual([
      { id: 'revision-publish-one', status: 'approved', question_text: 'Original prompt' },
      { id: 'revision-publish-two', status: 'approved', question_text: 'Updated prompt' },
    ]);
    expect(() => publishRevision(database, 'question-publish', 'revision-immutable-empty', 1500)).toThrow();
  });

  it('allows optional license/fetch metadata but rejects fetched time on non-import source types', () => {
    database.prepare(`
      INSERT INTO question_sources (id, source_type, name, created_by_member_id, created_at)
      VALUES ('custom-without-license', 'host_custom', 'Custom', 'legacy-member', 1000)
    `).run();
    database.prepare(`
      INSERT INTO question_sources (id, source_type, name, external_reference, source_url, license_name, created_at)
      VALUES ('import-with-partial-license', 'approved_import', 'Import', 'import-ref-1', 'https://example.invalid/source', 'License metadata only', 1000)
    `).run();
    database.prepare(`
      INSERT INTO question_sources (id, source_type, name, fetched_at, created_at)
      VALUES ('import-fetched', 'approved_import', 'Fetched import', 1100, 1000)
    `).run();
    expect(() => database.prepare(`
      INSERT INTO question_sources (id, source_type, name, fetched_at, created_at)
      VALUES ('custom-fetched', 'host_custom', 'Custom fetched', 1100, 1000)
    `).run()).toThrow();
    expect(() => database.prepare(`
      INSERT INTO question_sources (id, source_type, name, external_reference, created_at)
      VALUES ('duplicate-external', 'approved_import', 'Import copy', 'import-ref-1', 1000)
    `).run()).toThrow();
  });

  it('rolls back M005 through M002 and preserves M001 plus legacy tables and data', async () => {
    const dataSource = await createTemporaryMigrationDataSource(databasePath).initialize();
    try {
      await dataSource.undoLastMigration();
      await dataSource.undoLastMigration();
      await dataSource.undoLastMigration();
      await dataSource.undoLastMigration();
    } finally {
      await dataSource.destroy();
    }

    const tables = tableNames(database);
    expect(tables).toEqual([
      'device_sessions',
      'devices',
      'external_test_data',
      'migrations',
      'room_members',
      'rooms',
      'sequence_probe',
      'sqlite_sequence',
    ]);
    expect(database.prepare('SELECT id, value FROM external_test_data').all()).toEqual([
      { id: 1, value: 'legacy row must remain unchanged' },
    ]);
    expect(database.prepare('SELECT id, join_code_hash FROM rooms WHERE id = ?').get('legacy-room')).toEqual({
      id: 'legacy-room', join_code_hash: 'legacy-room-hash',
    });
    expect(database.prepare('SELECT timestamp, name FROM migrations ORDER BY id').all()).toEqual([
      { timestamp: 1000, name: 'LegacyMigrationBeforeM001' },
      { timestamp: 1792022400000, name: M001_NAME },
    ]);
    expect(database.pragma('foreign_key_check')).toEqual([]);
  });
});

function seedLegacyDatabase(databasePath: string): void {
  const legacy = new Database(databasePath);
  try {
    legacy.exec(`
      CREATE TABLE migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        timestamp BIGINT NOT NULL,
        name VARCHAR NOT NULL
      );
      INSERT INTO migrations (id, timestamp, name) VALUES (7, 1000, 'LegacyMigrationBeforeM001');
      CREATE TABLE external_test_data (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO external_test_data (id, value) VALUES (1, 'legacy row must remain unchanged');
      CREATE TABLE sequence_probe (id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT NOT NULL);
      INSERT INTO sequence_probe (id, value) VALUES (3, 'sequence must remain');
    `);
  } finally {
    legacy.close();
  }
}

function runProjectMigrations(databasePath: string): void {
  const npmCommand = process.platform === 'win32' ? 'npm.cmd run db:migrate' : 'npm run db:migrate';
  execSync(npmCommand, {
    cwd: REPOSITORY_ROOT,
    env: { ...process.env, DATABASE_PATH: databasePath },
    stdio: 'pipe',
  });
}

function createTemporaryMigrationDataSource(databasePath: string): DataSource {
  return new DataSource({
    ...createDatabaseOptions(databasePath),
    migrations: [
      M001RoomDeviceSessionSchema1792022400000,
      M002QuestionLibrary1792108800000,
      M003Surveys1792195200000,
      M004MatchesAndRounds1792281600000,
      M005MatchEventsAndScores1792368000000,
    ],
  });
}

function seedRoomMember(database: Database.Database): void {
  database.pragma('foreign_keys = ON');
  database.exec(`
    INSERT INTO rooms (id, join_code_hash, status, created_at)
    VALUES ('legacy-room', 'legacy-room-hash', 'open', 1000);
    INSERT INTO devices (id, created_at) VALUES ('legacy-device', 1000);
    INSERT INTO room_members (id, room_id, device_id, device_role, status, is_owner, is_current_host, created_at)
    VALUES ('legacy-member', 'legacy-room', 'legacy-device', 'host_ui', 'active', 1, 1, 1000);
  `);
}

function insertSource(database: Database.Database, id: string): void {
  database.prepare(`
    INSERT INTO question_sources (id, source_type, name, created_by_member_id, created_at)
    VALUES (?, 'host_custom', ?, 'legacy-member', 1100)
  `).run(id, `Source ${id}`);
}

function insertQuestion(database: Database.Database, id: string, sourceId: string): void {
  database.prepare(`
    INSERT INTO questions (id, source_id, status, created_at, updated_at)
    VALUES (?, ?, 'draft', 1200, 1200)
  `).run(id, sourceId);
}

function insertRevision(
  database: Database.Database,
  id: string,
  questionId: string,
  revisionNumber: number,
  questionText = `Prompt ${id}`,
): void {
  database.prepare(`
    INSERT INTO question_revisions
      (id, question_id, revision_number, question_text, locale, status, created_at, authored_by_member_id)
    VALUES (?, ?, ?, ?, 'ar', 'draft', 1300, 'legacy-member')
  `).run(id, questionId, revisionNumber, questionText);
}

function insertAnswer(
  database: Database.Database,
  id: string,
  revisionId: string,
  text: string,
  normalizedKey: string,
  order: number,
  points: number,
): void {
  database.prepare(`
    INSERT INTO question_revision_answers
      (id, revision_id, answer_text, normalized_key, normalization_version, answer_order, points)
    VALUES (?, ?, ?, ?, 1, ?, ?)
  `).run(id, revisionId, text, normalizedKey, order, points);
}

function approveRevision(database: Database.Database, revisionId: string): void {
  database.prepare(`
    UPDATE question_revisions
    SET status = 'approved', approved_at = 1400, approved_by_actor_id = 'admin-test'
    WHERE id = ?
  `).run(revisionId);
}

function publishRevision(database: Database.Database, questionId: string, revisionId: string, publishedAt: number): void {
  database.prepare(`
    UPDATE questions
    SET status = 'published', current_published_revision_id = ?, current_published_at = ?, updated_at = ?
    WHERE id = ?
  `).run(revisionId, publishedAt, publishedAt, questionId);
}

function tableNames(database: Database.Database): string[] {
  const rows = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}
