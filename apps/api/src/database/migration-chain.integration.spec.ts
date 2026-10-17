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

const REPOSITORY_ROOT = resolve(__dirname, '../../../..');
const MIGRATIONS = [
  M001RoomDeviceSessionSchema1792022400000,
  M002QuestionLibrary1792108800000,
  M003Surveys1792195200000,
  M004MatchesAndRounds1792281600000,
  M005MatchEventsAndScores1792368000000,
];

let temporaryDirectory: string;
let databasePath: string;
let database: Database.Database;
let centralQuestionId: string;
let centralRevisionId: string;
let centralAnswerId: string;
let matchId: string;
let matchRoomId: string;
let matchMemberId: string;
let roundIds: string[];
let roundAnswerIds: string[];

describe('M001-M005 database migration chain', () => {
  beforeAll(() => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'friend-feud-chain-'));
    databasePath = join(temporaryDirectory, 'migration-chain.sqlite');
    seedLegacyDatabase(databasePath);
    runProjectMigrations(databasePath);
    database = new Database(databasePath);
    database.pragma('foreign_keys = ON');
    seedBaseRoomAndMember(database);
  });

  afterAll(() => {
    database?.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  it('runs the actual CLI chain in timestamp order and preserves a pre-existing table', () => {
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
      { id: 1, value: 'preexisting migration data' },
    ]);
    const migrationRows = database.prepare('SELECT timestamp, name FROM migrations ORDER BY id')
      .all() as Array<{ timestamp: number; name: string }>;
    expect(migrationRows.map((row) => row.name)).toEqual([
        'LegacyMigrationBeforeM001',
        'M001RoomDeviceSessionSchema1792022400000',
        'M002QuestionLibrary1792108800000',
        'M003Surveys1792195200000',
        'M004MatchesAndRounds1792281600000',
        'M005MatchEventsAndScores1792368000000',
      ]);
    expect(database.pragma('foreign_key_check')).toEqual([]);

    const typeormDataSource = createFullChainDataSource(databasePath);
    return typeormDataSource.initialize().then(async (initialized) => {
      try {
        expect(await initialized.query('PRAGMA foreign_keys')).toEqual([{ foreign_keys: 1 }]);
      } finally {
        await initialized.destroy();
      }
    });
  });

  it('stores raw survey text immutably and enforces survey-scoped variants and review audit', () => {
    const surveySourceId = insertQuestionSource('survey-source-one', 'survey', 'Survey source one');
    const secondSurveySourceId = insertQuestionSource('survey-source-two', 'survey', 'Survey source two');
    insertSurvey('survey-one', surveySourceId, 'What did you use?');
    insertSurvey('survey-two', secondSurveySourceId, 'Another survey?');

    database.prepare(`
      UPDATE surveys SET status = 'open', opened_at = 1100 WHERE id = 'survey-one'
    `).run();
    database.prepare(`
      UPDATE surveys SET status = 'closed', closed_at = 1200 WHERE id = 'survey-one'
    `).run();

    insertVariant('variant-one', 'survey-one', 'Raw answer', 'raw-answer', 1);
    insertVariant('variant-two', 'survey-two', 'Other answer', 'other-answer', 1);
    database.prepare(`
      INSERT INTO survey_responses
        (id, survey_id, device_id, raw_text, normalized_key, normalization_version, candidate_variant_id, submitted_at)
      VALUES ('response-one', 'survey-one', 'legacy-device', '  Raw answer as typed  ', 'raw-answer', 1, 'variant-one', 1250)
    `).run();

    expect(() => database.prepare(`
      INSERT INTO survey_responses
        (id, survey_id, device_id, raw_text, submitted_at)
      VALUES ('response-duplicate', 'survey-one', 'legacy-device', 'second submission', 1260)
    `).run()).toThrow();
    expect(() => database.prepare(`
      INSERT INTO survey_responses
        (id, survey_id, device_id, raw_text, normalized_key, normalization_version, candidate_variant_id, submitted_at)
      VALUES ('response-cross-survey-variant', 'survey-one', 'second-device', 'Other answer', 'other-answer', 1, 'variant-two', 1270)
    `).run()).toThrow();
    expect(() => database.prepare(`UPDATE survey_responses SET raw_text = 'normalized replacement' WHERE id = 'response-one'`).run()).toThrow(/immutable/);
    database.prepare(`
      UPDATE survey_responses SET normalized_key = 'raw-answer-v2', normalization_version = 2, candidate_variant_id = NULL
      WHERE id = 'response-one'
    `).run();
    expect(database.prepare('SELECT raw_text FROM survey_responses WHERE id = ?').get('response-one')).toEqual({
      raw_text: '  Raw answer as typed  ',
    });

    insertVariant('merge-source', 'survey-one', 'Similar spelling', 'similar-spelling', 1);
    insertVariant('merge-target', 'survey-one', 'Canonical spelling', 'canonical-spelling', 1);
      insertSurveyReview('merge-source-event', 'survey-one', 'merge_variant', 'merge-source', 'merge-target');
    database.prepare(`
      UPDATE survey_answer_variants SET status = 'merged', merged_into_variant_id = 'merge-target'
      WHERE id = 'merge-source'
    `).run();
    expect(database.prepare('SELECT status, merged_into_variant_id FROM survey_answer_variants WHERE id = ?').get('merge-source'))
      .toEqual({ status: 'merged', merged_into_variant_id: 'merge-target' });
    expect(() => database.prepare(`UPDATE survey_review_events SET note = 'edited' WHERE id = 'merge-source-event'`).run()).toThrow(/append-only/);
    expect(() => database.prepare(`DELETE FROM survey_review_events WHERE id = 'merge-source-event'`).run()).toThrow(/cannot be deleted/);

      insertSurveyReview('merge-cycle-event', 'survey-one', 'merge_variant', 'merge-target', 'merge-source');
    expect(() => database.transaction(() => {
      database.prepare(`
        UPDATE survey_answer_variants SET status = 'merged', merged_into_variant_id = 'merge-source'
        WHERE id = 'merge-target'
      `).run();
    })()).toThrow(/merge target/);
    expect(database.prepare('SELECT status FROM survey_answer_variants WHERE id = ?').get('merge-target')).toEqual({ status: 'pending' });
  });

  it('requires review events to approve variants and links only approved library answers', () => {
    const surveySourceId = insertQuestionSource('survey-source-for-conversion', 'survey', 'Conversion source');
    insertSurvey('survey-for-conversion', surveySourceId, 'Survey prompt');
    database.prepare(`
      UPDATE surveys SET status = 'open', opened_at = 1500 WHERE id = 'survey-for-conversion'
    `).run();
    database.prepare(`
      UPDATE surveys SET status = 'closed', closed_at = 1600 WHERE id = 'survey-for-conversion'
    `).run();

    const questionId = 'survey-result-question';
    const revisionId = 'survey-result-revision';
    const answerId = 'survey-result-answer';
    insertQuestion(questionId, surveySourceId, 'draft');
    insertRevision(revisionId, questionId, 1, 'Result prompt');
    insertQuestionAnswer(answerId, revisionId, 'Canonical answer', 'canonical-key', 1, 20);
    approveQuestionRevision(revisionId);

    insertVariant('approved-variant', 'survey-for-conversion', 'Canonical answer', 'canonical-key', 1);
    expect(() => database.prepare(`
      UPDATE survey_answer_variants SET status = 'approved' WHERE id = 'approved-variant'
    `).run()).toThrow(/review event/);
    insertSurveyReview('approve-variant-event', 'survey-for-conversion', 'approve_variant', 'approved-variant');
    database.prepare(`
      UPDATE survey_answer_variants
      SET status = 'approved', approved_question_revision_answer_id = ?
      WHERE id = 'approved-variant'
    `).run(answerId);
    insertSurveyReview('reject-approved-variant-event', 'survey-for-conversion', 'reject_variant', 'approved-variant');
    expect(() => database.prepare(`
      UPDATE survey_answer_variants SET status = 'rejected' WHERE id = 'approved-variant'
    `).run()).toThrow(/final survey variant decisions are immutable/);
    expect(() => database.prepare(`
      UPDATE survey_answer_variants SET approved_question_revision_answer_id = 'missing-answer' WHERE id = 'approved-variant'
    `).run()).toThrow();

    const unrelatedImportSource = insertQuestionSource('unrelated-import-source', 'approved_import', 'Unrelated import');
    insertQuestion('unrelated-import-question', unrelatedImportSource, 'draft');
    insertRevision('unrelated-import-revision', 'unrelated-import-question', 1, 'Unrelated prompt');
    insertQuestionAnswer('unrelated-import-answer', 'unrelated-import-revision', 'Other answer', 'other-answer', 1, 20);
    approveQuestionRevision('unrelated-import-revision');
    insertSurveyReview('wrong-source-approval-event', 'survey-two', 'approve_variant', 'variant-two');
    expect(() => database.prepare(`
      UPDATE survey_answer_variants
      SET status = 'approved', approved_question_revision_answer_id = 'unrelated-import-answer'
      WHERE id = 'variant-two'
    `).run()).toThrow(/same survey|match normalization/);

    database.prepare(`
      UPDATE questions
      SET status = 'published', current_published_revision_id = ?, current_published_at = 1700, updated_at = 1700
      WHERE id = ?
    `).run(revisionId, questionId);
    database.prepare(`
      UPDATE surveys SET status = 'under_review' WHERE id = 'survey-for-conversion'
    `).run();
    database.prepare(`
      UPDATE surveys SET status = 'converted', resulting_question_id = ? WHERE id = 'survey-for-conversion'
    `).run(questionId);
    expect(database.prepare('SELECT status, resulting_question_id FROM surveys WHERE id = ?').get('survey-for-conversion'))
      .toEqual({ status: 'converted', resulting_question_id: questionId });
    expect(() => database.prepare(`
      UPDATE surveys SET resulting_question_id = 'question-from-another-source' WHERE id = 'survey-for-conversion'
    `).run()).toThrow();
  });

  it('preserves approved question snapshots, supports custom rounds, and enforces exactly three populated rounds before start', () => {
    const importedSourceId = insertQuestionSource('match-import-source', 'approved_import', 'Imported source');
    centralQuestionId = 'match-central-question';
    centralRevisionId = 'match-central-revision';
    centralAnswerId = 'match-central-answer';
    insertQuestion(centralQuestionId, importedSourceId, 'draft');
    insertRevision(centralRevisionId, centralQuestionId, 1, 'Central question snapshot');
    insertQuestionAnswer(centralAnswerId, centralRevisionId, 'Central answer', 'central-key', 1, 40);
    approveQuestionRevision(centralRevisionId);

    const shortRoom = createRoomWithMember('short-room', 'short-device', 'short-member');
    insertMatch('short-match', shortRoom.roomId, shortRoom.memberId);
    insertRound('short-round', 'short-match', shortRoom.roomId, 1, null, null, 'custom-short-question', 'Short snapshot');
    insertRoundAnswer('short-answer', 'short-round', 'short-answer-id', null, null, 'Short answer', null, null, 1, 1);
    expect(() => database.prepare(`
      UPDATE matches SET status = 'in_progress', current_round_number = 1, started_at = 2000 WHERE id = 'short-match'
    `).run()).toThrow(/exactly three rounds/);

    const dirtyStartRoom = createRoomWithMember('dirty-start-room', 'dirty-start-device', 'dirty-start-member');
    insertMatch('dirty-start-match', dirtyStartRoom.roomId, dirtyStartRoom.memberId);
    for (let number = 1; number <= 3; number += 1) {
      const roundId = `dirty-start-round-${number}`;
      insertRound(roundId, 'dirty-start-match', dirtyStartRoom.roomId, number, null, null, `custom-${number}`, `Question ${number}`);
      insertRoundAnswer(`dirty-start-answer-${number}`, roundId, `answer-snapshot-${number}`, null, null, `Answer ${number}`, null, null, 1, 0);
    }
    database.prepare(`UPDATE match_rounds SET phase = 'toss' WHERE id = 'dirty-start-round-1'`).run();
    expect(() => database.prepare(`
      UPDATE matches SET status = 'in_progress', current_round_number = 1, started_at = 2100 WHERE id = 'dirty-start-match'
    `).run()).toThrow(/every round/);

    const room = createRoomWithMember('match-room', 'match-device', 'match-member');
    matchRoomId = room.roomId;
    matchMemberId = room.memberId;
    matchId = 'domain-match';
    insertMatch(matchId, matchRoomId, matchMemberId);
    roundIds = ['domain-round-one', 'domain-round-two', 'domain-round-three'];
    roundAnswerIds = ['domain-answer-one', 'domain-answer-two', 'domain-answer-three'];

    expect(() => insertRound(
      'wrong-question-snapshot-round', matchId, matchRoomId, 1,
      centralQuestionId, centralRevisionId, centralQuestionId, 'Tampered question text',
    )).toThrow(/approved for the same question/);
    insertRound(roundIds[0], matchId, matchRoomId, 1, centralQuestionId, centralRevisionId, centralQuestionId, 'Central question snapshot');
    insertRoundAnswer(roundAnswerIds[0], roundIds[0], centralAnswerId, centralRevisionId, centralAnswerId, 'Central answer', 'central-key', 1, 1, 40);
    insertRound(roundIds[1], matchId, matchRoomId, 2, null, null, 'host-custom-question-2', 'Custom snapshot two');
    insertRoundAnswer('custom-answer-two', roundIds[1], 'custom-answer-id-two', null, null, 'Custom answer two', null, null, 1, 0);
    insertRound(roundIds[2], matchId, matchRoomId, 3, null, null, 'host-custom-question-3', 'Custom snapshot three');
    insertRoundAnswer('custom-answer-three', roundIds[2], 'custom-answer-id-three', null, null, 'Custom answer three', null, null, 1, 0);

    expect(() => insertRoundAnswer(
      'wrong-source-answer', roundIds[0], 'wrong-source-snapshot-id', centralRevisionId, 'missing-answer',
      'Wrong answer', 'central-key', 1, 2, 10,
    )).toThrow();
    expect(() => insertRoundAnswer(
      'duplicate-answer-order', roundIds[0], 'duplicate-order-snapshot', null, null,
      'Manual duplicate order', null, null, 1, 0,
    )).toThrow();
    expect(() => insertRoundAnswer(
      'round-answer-overflow', roundIds[0], 'overflow-answer-id', null, null,
      'Overflow answer', null, null, 2, Number.MAX_SAFE_INTEGER,
    )).toThrow(/safe integer range/);
    expect(() => database.prepare(`
      UPDATE match_round_answers SET answer_text_snapshot = 'Tampered source answer'
      WHERE id = ?
    `).run(roundAnswerIds[0])).toThrow(/source answer/);
    expect(() => database.prepare(`
      UPDATE match_rounds
      SET source_question_id = ?, source_revision_id = ?, question_identifier_snapshot = ?
      WHERE id = ?
    `).run(centralQuestionId, centralRevisionId, centralQuestionId, roundIds[1])).toThrow();

    database.prepare(`
      UPDATE matches SET status = 'in_progress', current_round_number = 1, started_at = 3000 WHERE id = ?
    `).run(matchId);
    expect(() => database.prepare(`
      UPDATE matches SET status = 'setup', current_round_number = NULL, started_at = NULL WHERE id = ?
    `).run(matchId)).toThrow(/invalid match status transition/);
    expect(() => database.prepare(`
      UPDATE match_rounds SET question_text_snapshot = 'tampered' WHERE id = ?
    `).run(roundIds[0])).toThrow(/immutable/);
    expect(() => database.prepare(`
      UPDATE match_round_answers SET answer_text_snapshot = 'tampered' WHERE id = ?
    `).run(roundAnswerIds[0])).toThrow(/immutable/);
    expect(() => insertRoundAnswer(
      'late-answer', roundIds[0], 'late-answer-id', centralRevisionId, centralAnswerId,
      'Central answer', 'central-key', 1, 2, 40,
    )).toThrow();
    expect(() => database.prepare(`
      UPDATE matches SET status = 'completed', current_round_number = 3, completed_at = 4000, outcome = 'tie' WHERE id = ?
    `).run(matchId)).toThrow(/all three rounds/);

    database.prepare(`
      UPDATE match_round_answers SET is_revealed = 1, active_reveal_id = 1, revealed_by_team = 'team_one'
      WHERE id = ?
    `).run(roundAnswerIds[0]);
    expect(database.prepare('SELECT answer_text_snapshot, is_revealed FROM match_round_answers WHERE id = ?').get(roundAnswerIds[0]))
      .toEqual({ answer_text_snapshot: 'Central answer', is_revealed: 1 });
  });

  it('records commands, multi-event revisions, immutable events, awards, reversals, idempotency, and transaction rollback', async () => {
    const dataSource = await createFullChainDataSource(databasePath).initialize();
    try {
      database.prepare(`
        UPDATE matches SET revision = 1, next_event_sequence = 2 WHERE id = ?
      `).run(matchId);
      insertCommand('cmd-start', 0, 1, 'accepted', null, '{}');
      insertEvent(1, 1, 1, 'match_started', 'cmd-start', null, null, null, '{}');

      expect(() => insertCommand('cmd-start', 0, 1, 'accepted', null, '{}')).toThrow();
      expect(() => database.prepare(`
        INSERT INTO match_commands
          (match_id, room_id, command_id, actor_room_member_id, request_hash, expected_revision, outcome, result_code, result_payload, executed_at)
        VALUES (?, ?, 'wrong-room-actor', 'legacy-member', 'hash', 1, 'rejected', 'forbidden', '{}', 3100)
      `).run(matchId, matchRoomId)).toThrow();

      database.prepare(`UPDATE matches SET revision = 2, next_event_sequence = 3 WHERE id = ?`).run(matchId);
      insertCommand('cmd-ownership', 1, 2, 'accepted', null, '{}');
      insertEvent(2, 2, 1, 'ownership_answered', 'cmd-ownership', 'team_one', null, null, '{}', 1);
      expect(() => database.prepare(`
        UPDATE match_rounds
        SET ownership_resolution_event_sequence = 20, ownership_resolution_team = 'team_one', phase = 'main_play'
        WHERE id = ?
      `).run(roundIds[0])).toThrow(/ownership event/);
      database.prepare(`
        UPDATE match_rounds
        SET ownership_resolution_event_sequence = 2, ownership_resolution_team = 'team_one',
            first_buzz_team = 'team_one', owner_team = 'team_one', answering_team = 'team_one', phase = 'main_play'
        WHERE id = ?
      `).run(roundIds[0]);

      database.prepare(`UPDATE matches SET revision = 3, next_event_sequence = 5 WHERE id = ?`).run(matchId);
      insertCommand('cmd-complete-round', 2, 3, 'accepted', null, '{}');
      database.prepare(`
        UPDATE match_rounds
        SET phase = 'completed', score_award_team = 'team_one', score_award_points = 40,
            score_award_reason = 'all_answers_revealed'
        WHERE id = ?
      `).run(roundIds[0]);
      insertEvent(3, 3, 1, 'answer_revealed', 'cmd-complete-round', 'team_one', 40, null, '{}');
      insertEvent(4, 3, 1, 'round_completed', 'cmd-complete-round', 'team_one', 40, 'all_answers_revealed', '{}');
      expect(() => insertEvent(4, 3, 1, 'round_completed', 'cmd-complete-round', 'team_one', 40, 'all_answers_revealed', '{}')).toThrow();
      insertScoreEntry('award-one', 'award-round-one', 1, 'award', 40, 'all_answers_revealed', 4, null);
      expect(() => insertScoreEntry('award-duplicate', 'award-round-one-duplicate', 1, 'award', 40, 'all_answers_revealed', 4, null)).toThrow();
      expect(() => database.prepare(`
        UPDATE match_events SET event_type = 'tampered' WHERE match_id = ? AND event_sequence = 4
      `).run(matchId)).toThrow(/append-only/);
      expect(() => database.prepare(`DELETE FROM match_events WHERE match_id = ? AND event_sequence = 4`).run(matchId)).toThrow(/cannot be deleted/);
      expect(() => database.prepare(`UPDATE match_score_entries SET points = 1 WHERE id = 'award-one'`).run()).toThrow(/append-only/);
      expect(() => database.prepare(`DELETE FROM match_score_entries WHERE id = 'award-one'`).run()).toThrow(/cannot be deleted/);

      insertCommand('stale-rejected-command', 2, null, 'rejected', 'stale_revision', '{"ok":false}');
      expect(database.prepare('SELECT revision, next_event_sequence FROM matches WHERE id = ?').get(matchId))
        .toEqual({ revision: 3, next_event_sequence: 5 });

      database.prepare(`
        UPDATE match_round_answers
        SET is_revealed = 0, active_reveal_id = NULL, revealed_by_team = NULL
        WHERE id = ?
      `).run(roundAnswerIds[0]);
      database.prepare(`
        UPDATE match_rounds
        SET phase = 'main_play', score_award_team = NULL, score_award_points = NULL, score_award_reason = NULL
        WHERE id = ?
      `).run(roundIds[0]);
      database.prepare(`UPDATE matches SET revision = 4, next_event_sequence = 6 WHERE id = ?`).run(matchId);
      insertCommand('cmd-undo-final-answer', 3, 4, 'accepted', null, '{}');
      insertEvent(5, 4, 1, 'answer_retracted', 'cmd-undo-final-answer', 'team_one', 40, null, '{}');
      insertScoreEntry('reversal-one', 'reverse-award-one', 1, 'reversal', 40, null, 5, 'award-one');
      expect(() => insertScoreEntry('reversal-duplicate', 'reverse-award-one-again', 1, 'reversal', 40, null, 5, 'award-one')).toThrow();
      expect(database.prepare(`
        SELECT COALESCE(SUM(CASE WHEN entry_type = 'award' THEN points ELSE -points END), 0) AS total
        FROM match_score_entries WHERE match_id = ? AND team = 'team_one'
      `).get(matchId)).toEqual({ total: 0 });

      database.prepare(`
        UPDATE match_round_answers SET is_revealed = 1, active_reveal_id = 2, revealed_by_team = 'team_one'
        WHERE id = ?
      `).run(roundAnswerIds[0]);
      database.prepare(`
        UPDATE match_rounds
        SET phase = 'completed', score_award_team = 'team_one', score_award_points = 40,
            score_award_reason = 'all_answers_revealed'
        WHERE id = ?
      `).run(roundIds[0]);
      database.prepare(`UPDATE matches SET revision = 5, next_event_sequence = 8 WHERE id = ?`).run(matchId);
      insertCommand('cmd-reaward-round-one', 4, 5, 'accepted', null, '{}');
      insertEvent(6, 5, 1, 'answer_revealed', 'cmd-reaward-round-one', 'team_one', 40, null, '{}');
      insertEvent(7, 5, 1, 'round_completed', 'cmd-reaward-round-one', 'team_one', 40, 'all_answers_revealed', '{}');
      insertScoreEntry('award-two', 'award-round-one-second', 1, 'award', 40, 'all_answers_revealed', 7, null);
      expect(database.prepare(`
        SELECT SUM(points) AS total FROM match_score_entries
        WHERE match_id = ? AND team = 'team_one' AND entry_type = 'award'
        AND reverses_entry_id IS NULL
      `).get(matchId)).toEqual({ total: 80 });

      const revisionBeforeRollback = database.prepare('SELECT revision, next_event_sequence FROM matches WHERE id = ?').get(matchId);
      expect(() => database.transaction(() => {
        database.prepare(`UPDATE matches SET revision = 6, next_event_sequence = 9 WHERE id = ?`).run(matchId);
        insertCommand('rolled-back-command', 5, 6, 'accepted', null, '{}');
        insertEvent(8, 6, null, 'test_event', 'rolled-back-command', null, null, null, '{not-json');
      })()).toThrow();
      expect(database.prepare('SELECT revision, next_event_sequence FROM matches WHERE id = ?').get(matchId)).toEqual(revisionBeforeRollback);
      expect(database.prepare(`SELECT command_id FROM match_commands WHERE command_id = 'rolled-back-command'`).get()).toBeUndefined();
      expect(database.prepare('SELECT event_sequence FROM match_events WHERE match_id = ? AND event_sequence = 8').get(matchId)).toBeUndefined();

      expect(database.pragma('foreign_key_check')).toEqual([]);
    } finally {
      await dataSource.destroy();
    }
  });

  it('rolls back M005 through M003 while preserving M001/M002 data, fully rolls back, then reapplies the chain', async () => {
    database.close();
    let dataSource = await createFullChainDataSource(databasePath).initialize();
    try {
      await dataSource.undoLastMigration();
      await dataSource.undoLastMigration();
      await dataSource.undoLastMigration();
    } finally {
      await dataSource.destroy();
    }

    database = new Database(databasePath);
    database.pragma('foreign_keys = ON');
    expect(tableNames(database)).toEqual([
      'device_sessions', 'devices', 'external_test_data', 'migrations',
      'question_revision_answers', 'question_revisions', 'question_sources', 'questions',
      'room_members', 'rooms', 'sequence_probe', 'sqlite_sequence',
    ]);
    expect(database.prepare('SELECT id FROM questions WHERE id = ?').get(centralQuestionId)).toEqual({ id: centralQuestionId });
    expect(database.prepare('SELECT id FROM rooms WHERE id = ?').get('legacy-room')).toEqual({ id: 'legacy-room' });
    expect(database.prepare('SELECT id, value FROM external_test_data').all()).toEqual([{ id: 1, value: 'preexisting migration data' }]);

    dataSource = await createFullChainDataSource(databasePath).initialize();
    try {
      await dataSource.undoLastMigration();
      await dataSource.undoLastMigration();
    } finally {
      await dataSource.destroy();
    }
    database.close();
    database = new Database(databasePath);
    database.pragma('foreign_keys = ON');
    expect(tableNames(database)).toEqual(['external_test_data', 'migrations', 'sequence_probe', 'sqlite_sequence']);
    expect(database.prepare('SELECT id, value FROM external_test_data').all()).toEqual([{ id: 1, value: 'preexisting migration data' }]);

    runProjectMigrations(databasePath);
    expect(tableNames(database)).toContain('match_score_entries');
    expect(database.pragma('foreign_key_check')).toEqual([]);
  });
});

function seedLegacyDatabase(path: string): void {
  const legacy = new Database(path);
  try {
    legacy.exec(`
      CREATE TABLE migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        timestamp BIGINT NOT NULL,
        name VARCHAR NOT NULL
      );
      INSERT INTO migrations (id, timestamp, name) VALUES (7, 1000, 'LegacyMigrationBeforeM001');
      CREATE TABLE external_test_data (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO external_test_data (id, value) VALUES (1, 'preexisting migration data');
      CREATE TABLE sequence_probe (id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT NOT NULL);
      INSERT INTO sequence_probe (id, value) VALUES (3, 'sequence remains');
    `);
  } finally {
    legacy.close();
  }
}

function runProjectMigrations(path: string): void {
  execSync(process.platform === 'win32' ? 'npm.cmd run db:migrate' : 'npm run db:migrate', {
    cwd: REPOSITORY_ROOT,
    env: { ...process.env, DATABASE_PATH: path },
    stdio: 'pipe',
  });
}

function seedBaseRoomAndMember(target: Database.Database): void {
  target.exec(`
    INSERT INTO rooms (id, join_code_hash, status, created_at)
    VALUES ('legacy-room', 'legacy-room-hash', 'open', 1000);
    INSERT INTO devices (id, created_at) VALUES ('legacy-device', 1000);
    INSERT INTO room_members
      (id, room_id, device_id, device_role, status, is_owner, is_current_host, created_at)
    VALUES ('legacy-member', 'legacy-room', 'legacy-device', 'host_ui', 'active', 1, 1, 1000);
  `);
}

function insertQuestionSource(id: string, type: 'approved_import' | 'host_custom' | 'survey', name: string): string {
  database.prepare(`
    INSERT INTO question_sources (id, source_type, name, created_by_member_id, fetched_at, created_at)
    VALUES (?, ?, ?, ?, ?, 1000)
  `).run(id, type, name, type === 'host_custom' ? 'legacy-member' : null, type === 'approved_import' ? 1000 : null);
  return id;
}

function insertSurvey(id: string, sourceId: string, prompt: string): void {
  database.prepare(`
    INSERT INTO surveys (id, question_source_id, prompt, language, created_by_actor_id, created_at)
    VALUES (?, ?, ?, 'ar', NULL, 1100)
  `).run(id, sourceId, prompt);
}

function insertVariant(id: string, surveyId: string, text: string, key: string, version: number): void {
  database.prepare(`
    INSERT INTO survey_answer_variants (id, survey_id, display_text, normalized_key, normalization_version, created_at)
    VALUES (?, ?, ?, ?, ?, 1200)
  `).run(id, surveyId, text, key, version);
}

function insertSurveyReview(
  id: string,
  surveyId: string,
  action: 'approve_variant' | 'merge_variant' | 'reject_variant',
  sourceVariantId: string,
  targetVariantId: string | null = null,
): void {
  database.prepare(`
    INSERT INTO survey_review_events
      (id, survey_id, reviewer_actor_id, action_type, source_variant_id, target_variant_id, created_at)
    VALUES (?, ?, 'reviewer-test', ?, ?, ?, 1300)
  `).run(id, surveyId, action, sourceVariantId, targetVariantId);
}

function insertQuestion(id: string, sourceId: string, status: 'draft' | 'published' = 'draft'): void {
  database.prepare(`
    INSERT INTO questions (id, source_id, status, created_at, updated_at)
    VALUES (?, ?, ?, 1200, 1200)
  `).run(id, sourceId, status);
}

function insertRevision(id: string, questionId: string, number: number, prompt: string): void {
  database.prepare(`
    INSERT INTO question_revisions
      (id, question_id, revision_number, question_text, locale, status, created_at, authored_by_member_id)
    VALUES (?, ?, ?, ?, 'ar', 'draft', 1300, 'legacy-member')
  `).run(id, questionId, number, prompt);
}

function insertQuestionAnswer(id: string, revisionId: string, text: string, key: string, order: number, points: number): void {
  database.prepare(`
    INSERT INTO question_revision_answers
      (id, revision_id, answer_text, normalized_key, normalization_version, answer_order, points)
    VALUES (?, ?, ?, ?, 1, ?, ?)
  `).run(id, revisionId, text, key, order, points);
}

function approveQuestionRevision(id: string): void {
  database.prepare(`
    UPDATE question_revisions SET status = 'approved', approved_at = 1400, approved_by_actor_id = 'admin-test'
    WHERE id = ?
  `).run(id);
}

function createRoomWithMember(roomId: string, deviceId: string, memberId: string): { roomId: string; memberId: string } {
  database.prepare(`INSERT INTO rooms (id, join_code_hash, status, created_at) VALUES (?, ?, 'open', 1500)`)
    .run(roomId, `${roomId}-hash`);
  database.prepare('INSERT INTO devices (id, created_at) VALUES (?, 1500)').run(deviceId);
  database.prepare(`
    INSERT INTO room_members (id, room_id, device_id, device_role, status, is_owner, is_current_host, created_at)
    VALUES (?, ?, ?, 'host_ui', 'active', 1, 1, 1500)
  `).run(memberId, roomId, deviceId);
  return { roomId, memberId };
}

function insertMatch(id: string, roomId: string, memberId: string | null): void {
  database.prepare(`
    INSERT INTO matches (id, room_id, created_by_room_member_id, status, revision, next_event_sequence, state_schema_version, created_at)
    VALUES (?, ?, ?, 'setup', 0, 1, 1, 2000)
  `).run(id, roomId, memberId);
}

function insertRound(
  id: string,
  match: string,
  room: string,
  number: number,
  questionId: string | null,
  revisionId: string | null,
  identifier: string,
  prompt: string,
): void {
  database.prepare(`
    INSERT INTO match_rounds
      (id, match_id, room_id, round_number, source_question_id, source_revision_id,
       question_identifier_snapshot, question_text_snapshot)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, match, room, number, questionId, revisionId, identifier, prompt);
}

function insertRoundAnswer(
  id: string,
  roundId: string,
  snapshotId: string,
  sourceRevisionId: string | null,
  sourceAnswerId: string | null,
  text: string,
  key: string | null,
  normalizationVersion: number | null,
  order: number,
  points: number,
): void {
  database.prepare(`
    INSERT INTO match_round_answers
      (id, match_round_id, answer_id_snapshot, source_revision_id, source_answer_id,
       answer_text_snapshot, normalized_key_snapshot, normalization_version_snapshot,
       answer_order_snapshot, points_snapshot)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, roundId, snapshotId, sourceRevisionId, sourceAnswerId, text, key, normalizationVersion, order, points);
}

function insertCommand(
  commandId: string,
  expectedRevision: number,
  resultRevision: number | null,
  outcome: 'accepted' | 'rejected',
  resultCode: string | null,
  payload: string,
): void {
  database.prepare(`
    INSERT INTO match_commands
      (match_id, room_id, command_id, actor_room_member_id, request_hash, expected_revision,
       resulting_revision, outcome, result_code, result_payload, executed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 3000)
  `).run(matchId, matchRoomId, commandId, matchMemberId, `request-${commandId}`, expectedRevision,
    resultRevision, outcome, resultCode, payload);
}

function insertEvent(
  sequence: number,
  revision: number,
  roundNumber: number | null,
  eventType: string,
  commandId: string | null,
  team: string | null,
  points: number | null,
  reason: string | null,
  payload: string,
  correct: number | null = null,
): void {
  database.prepare(`
    INSERT INTO match_events
      (match_id, room_id, event_sequence, revision, round_number, event_type, actor_room_member_id,
       team, correct, points, reason, command_id, event_schema_version, event_payload, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 3100)
  `).run(matchId, matchRoomId, sequence, revision, roundNumber, eventType, matchMemberId,
    team, correct, points, reason, commandId, payload);
}

function insertScoreEntry(
  id: string,
  operationKey: string,
  roundNumber: number,
  type: 'award' | 'reversal',
  points: number,
  awardReason: string | null,
  eventSequence: number,
  reversesEntryId: string | null,
): void {
  database.prepare(`
    INSERT INTO match_score_entries
      (id, match_id, room_id, round_number, team, entry_type, points, award_reason, operation_key,
       source_event_sequence, reverses_entry_id, created_at)
    VALUES (?, ?, ?, ?, 'team_one', ?, ?, ?, ?, ?, ?, 3200)
  `).run(id, matchId, matchRoomId, roundNumber, type, points, awardReason, operationKey, eventSequence, reversesEntryId);
}

function tableNames(target: Database.Database): string[] {
  const rows = target.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

function createFullChainDataSource(path: string): DataSource {
  return new DataSource({
    ...createDatabaseOptions(path),
    migrations: MIGRATIONS,
  });
}
