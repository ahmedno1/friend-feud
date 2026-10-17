import { MigrationInterface, QueryRunner } from 'typeorm';

export class M005MatchEventsAndScores1792368000000 implements MigrationInterface {
  name = 'M005MatchEventsAndScores1792368000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "match_commands" (
        "match_id" TEXT NOT NULL,
        "room_id" TEXT NOT NULL,
        "command_id" TEXT NOT NULL,
        "actor_room_member_id" TEXT,
        "request_hash" TEXT NOT NULL,
        "expected_revision" INTEGER NOT NULL,
        "resulting_revision" INTEGER,
        "outcome" TEXT NOT NULL,
        "result_code" TEXT,
        "result_payload" TEXT NOT NULL,
        "executed_at" INTEGER NOT NULL,
        CONSTRAINT "pk_match_commands" PRIMARY KEY ("match_id", "command_id"),
        CONSTRAINT "ck_match_commands_command_id" CHECK (length(trim("command_id")) > 0),
        CONSTRAINT "ck_match_commands_request_hash" CHECK (length(trim("request_hash")) > 0),
        CONSTRAINT "ck_match_commands_expected_revision" CHECK (
          typeof("expected_revision") = 'integer'
          AND "expected_revision" BETWEEN 0 AND 9007199254740990
        ),
        CONSTRAINT "ck_match_commands_outcome" CHECK ("outcome" IN ('accepted', 'rejected')),
        CONSTRAINT "ck_match_commands_result" CHECK (
          ("outcome" = 'accepted' AND "result_code" IS NULL
            AND typeof("resulting_revision") = 'integer'
            AND "resulting_revision" = "expected_revision" + 1)
          OR ("outcome" = 'rejected' AND "result_code" IS NOT NULL
            AND length(trim("result_code")) > 0 AND "resulting_revision" IS NULL)
        ),
        CONSTRAINT "ck_match_commands_result_payload" CHECK (json_valid("result_payload")),
        CONSTRAINT "ck_match_commands_executed_at" CHECK (
          typeof("executed_at") = 'integer' AND "executed_at" BETWEEN 0 AND 9007199254740991
        ),
        CONSTRAINT "fk_match_commands_match_room" FOREIGN KEY ("match_id", "room_id")
          REFERENCES "matches" ("id", "room_id") ON DELETE RESTRICT,
        CONSTRAINT "fk_match_commands_actor_room_member" FOREIGN KEY ("actor_room_member_id", "room_id")
          REFERENCES "room_members" ("id", "room_id") ON DELETE RESTRICT
      )
    `);
    await queryRunner.query(`CREATE INDEX "ix_match_commands_match_executed" ON "match_commands" ("match_id", "executed_at")`);
    await queryRunner.query(`CREATE INDEX "ix_match_commands_actor" ON "match_commands" ("actor_room_member_id", "executed_at")`);

    await queryRunner.query(`
      CREATE TABLE "match_events" (
        "match_id" TEXT NOT NULL,
        "room_id" TEXT NOT NULL,
        "event_sequence" INTEGER NOT NULL,
        "revision" INTEGER NOT NULL,
        "round_number" INTEGER,
        "event_type" TEXT NOT NULL,
        "actor_room_member_id" TEXT,
        "team" TEXT,
        "correct" INTEGER,
        "points" INTEGER,
        "reason" TEXT,
        "command_id" TEXT,
        "event_schema_version" INTEGER NOT NULL DEFAULT 1,
        "event_payload" TEXT NOT NULL DEFAULT '{}',
        "created_at" INTEGER NOT NULL,
        CONSTRAINT "pk_match_events" PRIMARY KEY ("match_id", "event_sequence"),
        CONSTRAINT "uq_match_events_match_sequence_round" UNIQUE ("match_id", "event_sequence", "round_number"),
        CONSTRAINT "ck_match_events_sequence" CHECK (
          typeof("event_sequence") = 'integer' AND "event_sequence" BETWEEN 1 AND 9007199254740991
        ),
        CONSTRAINT "ck_match_events_revision" CHECK (
          typeof("revision") = 'integer' AND "revision" BETWEEN 1 AND 9007199254740991
        ),
        CONSTRAINT "ck_match_events_round" CHECK (
          "round_number" IS NULL OR (typeof("round_number") = 'integer' AND "round_number" BETWEEN 1 AND 3)
        ),
        CONSTRAINT "ck_match_events_type" CHECK (length(trim("event_type")) > 0),
        CONSTRAINT "ck_match_events_team" CHECK (
          "team" IS NULL OR "team" IN ('team_one', 'team_two')
        ),
        CONSTRAINT "ck_match_events_correct" CHECK (
          "correct" IS NULL OR (typeof("correct") = 'integer' AND "correct" IN (0, 1))
        ),
        CONSTRAINT "ck_match_events_points" CHECK (
          "points" IS NULL OR (typeof("points") = 'integer' AND "points" BETWEEN 0 AND 9007199254740991)
        ),
        CONSTRAINT "ck_match_events_reason" CHECK (
          "reason" IS NULL OR "reason" IN ('all_answers_revealed', 'steal_success', 'steal_failed')
        ),
        CONSTRAINT "ck_match_events_schema_version" CHECK (
          typeof("event_schema_version") = 'integer' AND "event_schema_version" > 0
        ),
        CONSTRAINT "ck_match_events_payload_json" CHECK (json_valid("event_payload")),
        CONSTRAINT "ck_match_events_created_at" CHECK (
          typeof("created_at") = 'integer' AND "created_at" BETWEEN 0 AND 9007199254740991
        ),
        CONSTRAINT "fk_match_events_match_room" FOREIGN KEY ("match_id", "room_id")
          REFERENCES "matches" ("id", "room_id") ON DELETE RESTRICT,
        CONSTRAINT "fk_match_events_match_round" FOREIGN KEY ("match_id", "round_number")
          REFERENCES "match_rounds" ("match_id", "round_number") ON DELETE RESTRICT,
        CONSTRAINT "fk_match_events_actor_room_member" FOREIGN KEY ("actor_room_member_id", "room_id")
          REFERENCES "room_members" ("id", "room_id") ON DELETE RESTRICT,
        CONSTRAINT "fk_match_events_command" FOREIGN KEY ("match_id", "command_id")
          REFERENCES "match_commands" ("match_id", "command_id") ON DELETE RESTRICT
      )
    `);
    await queryRunner.query(`CREATE INDEX "ix_match_events_match_revision" ON "match_events" ("match_id", "revision")`);
    await queryRunner.query(`CREATE INDEX "ix_match_events_round_sequence" ON "match_events" ("match_id", "round_number", "event_sequence")`);
    await queryRunner.query(`CREATE INDEX "ix_match_events_command" ON "match_events" ("match_id", "command_id")`);
    await queryRunner.query(`
      CREATE TRIGGER "trg_match_rounds_ownership_event_reference_insert"
      BEFORE INSERT ON "match_rounds"
      WHEN NEW."ownership_resolution_event_sequence" IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM "match_events" event
          WHERE event."match_id" = NEW."match_id"
            AND event."event_sequence" = NEW."ownership_resolution_event_sequence"
            AND event."round_number" = NEW."round_number"
            AND event."event_type" = 'ownership_answered'
            AND event."correct" = 1
            AND event."team" = NEW."ownership_resolution_team"
        )
      BEGIN
        SELECT RAISE(ABORT, 'ownership resolution must reference its accepted ownership event');
      END
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_match_rounds_ownership_event_reference_update"
      BEFORE UPDATE OF "ownership_resolution_event_sequence", "ownership_resolution_team", "ownership_resolution_retracted"
      ON "match_rounds"
      WHEN NEW."ownership_resolution_event_sequence" IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM "match_events" event
          WHERE event."match_id" = NEW."match_id"
            AND event."event_sequence" = NEW."ownership_resolution_event_sequence"
            AND event."round_number" = NEW."round_number"
            AND event."event_type" = 'ownership_answered'
            AND event."correct" = 1
            AND event."team" = NEW."ownership_resolution_team"
        )
      BEGIN
        SELECT RAISE(ABORT, 'ownership resolution must reference its accepted ownership event');
      END
    `);

    await queryRunner.query(`
      CREATE TABLE "match_score_entries" (
        "id" TEXT NOT NULL,
        "match_id" TEXT NOT NULL,
        "room_id" TEXT NOT NULL,
        "round_number" INTEGER NOT NULL,
        "team" TEXT NOT NULL,
        "entry_type" TEXT NOT NULL,
        "points" INTEGER NOT NULL,
        "award_reason" TEXT,
        "operation_key" TEXT NOT NULL,
        "source_event_sequence" INTEGER NOT NULL,
        "reverses_entry_id" TEXT,
        "created_at" INTEGER NOT NULL,
        CONSTRAINT "pk_match_score_entries" PRIMARY KEY ("id"),
        CONSTRAINT "uq_match_score_entries_match_id" UNIQUE ("match_id", "id"),
        CONSTRAINT "uq_match_score_entries_operation" UNIQUE ("match_id", "operation_key"),
        CONSTRAINT "uq_match_score_entries_reversal_once" UNIQUE ("match_id", "reverses_entry_id"),
        CONSTRAINT "ck_match_score_entries_id" CHECK (length(trim("id")) > 0),
        CONSTRAINT "ck_match_score_entries_team" CHECK ("team" IN ('team_one', 'team_two')),
        CONSTRAINT "ck_match_score_entries_type" CHECK ("entry_type" IN ('award', 'reversal')),
        CONSTRAINT "ck_match_score_entries_points" CHECK (
          typeof("points") = 'integer' AND "points" BETWEEN 0 AND 9007199254740991
        ),
        CONSTRAINT "ck_match_score_entries_reason" CHECK (
          ("entry_type" = 'award' AND "award_reason" IS NOT NULL
            AND "award_reason" IN ('all_answers_revealed', 'steal_success', 'steal_failed')
            AND "reverses_entry_id" IS NULL)
          OR ("entry_type" = 'reversal' AND "award_reason" IS NULL AND "reverses_entry_id" IS NOT NULL)
        ),
        CONSTRAINT "ck_match_score_entries_operation" CHECK (length(trim("operation_key")) > 0),
        CONSTRAINT "ck_match_score_entries_event_sequence" CHECK (
          typeof("source_event_sequence") = 'integer' AND "source_event_sequence" > 0
        ),
        CONSTRAINT "ck_match_score_entries_created_at" CHECK (
          typeof("created_at") = 'integer' AND "created_at" BETWEEN 0 AND 9007199254740991
        ),
        CONSTRAINT "fk_match_score_entries_match_room" FOREIGN KEY ("match_id", "room_id")
          REFERENCES "matches" ("id", "room_id") ON DELETE RESTRICT,
        CONSTRAINT "fk_match_score_entries_round" FOREIGN KEY ("match_id", "round_number")
          REFERENCES "match_rounds" ("match_id", "round_number") ON DELETE RESTRICT,
        CONSTRAINT "fk_match_score_entries_source_event" FOREIGN KEY ("match_id", "source_event_sequence")
          REFERENCES "match_events" ("match_id", "event_sequence") ON DELETE RESTRICT,
        CONSTRAINT "fk_match_score_entries_reversal_source" FOREIGN KEY ("match_id", "reverses_entry_id")
          REFERENCES "match_score_entries" ("match_id", "id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`CREATE INDEX "ix_match_score_entries_match_round" ON "match_score_entries" ("match_id", "round_number")`);
    await queryRunner.query(`CREATE INDEX "ix_match_score_entries_match_team" ON "match_score_entries" ("match_id", "team")`);

    await queryRunner.query(`
      CREATE TRIGGER "trg_matches_revision_increments_once"
      BEFORE UPDATE OF "revision" ON "matches"
      WHEN NEW."revision" <> OLD."revision"
        AND (OLD."revision" = 9007199254740991 OR NEW."revision" <> OLD."revision" + 1)
      BEGIN
        SELECT RAISE(ABORT, 'match revision must increment by exactly one');
      END
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_matches_event_sequence_never_decreases"
      BEFORE UPDATE OF "next_event_sequence" ON "matches"
      WHEN NEW."next_event_sequence" < OLD."next_event_sequence"
      BEGIN
        SELECT RAISE(ABORT, 'next event sequence cannot decrease');
      END
    `);

    await queryRunner.query(`
      CREATE TRIGGER "trg_match_commands_revision_is_current"
      BEFORE INSERT ON "match_commands"
      WHEN NEW."outcome" = 'accepted'
        AND NEW."resulting_revision" <> (SELECT "revision" FROM "matches" WHERE "id" = NEW."match_id")
      BEGIN
        SELECT RAISE(ABORT, 'accepted command result must match the committed match revision');
      END
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_match_events_sequence_and_revision"
      BEFORE INSERT ON "match_events"
      BEGIN
        SELECT CASE
          WHEN NEW."event_sequence" <> (SELECT COALESCE(MAX("event_sequence"), 0) + 1 FROM "match_events" WHERE "match_id" = NEW."match_id")
          THEN RAISE(ABORT, 'match event sequence must be contiguous')
        END;
        SELECT CASE
          WHEN NEW."event_sequence" >= (SELECT "next_event_sequence" FROM "matches" WHERE "id" = NEW."match_id")
            OR NEW."revision" > (SELECT "revision" FROM "matches" WHERE "id" = NEW."match_id")
          THEN RAISE(ABORT, 'match event is ahead of the committed state')
        END;
        SELECT CASE
          WHEN NEW."command_id" IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM "match_commands"
            WHERE "match_id" = NEW."match_id"
              AND "command_id" = NEW."command_id"
              AND "outcome" = 'accepted'
              AND "resulting_revision" = NEW."revision"
          ) THEN RAISE(ABORT, 'event command receipt must match its accepted revision')
        END;
      END
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_match_commands_immutable_update"
      BEFORE UPDATE ON "match_commands"
      BEGIN
        SELECT RAISE(ABORT, 'match command receipts are immutable');
      END
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_match_commands_immutable_delete"
      BEFORE DELETE ON "match_commands"
      BEGIN
        SELECT RAISE(ABORT, 'match command receipts cannot be deleted');
      END
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_match_events_immutable_update"
      BEFORE UPDATE ON "match_events"
      BEGIN
        SELECT RAISE(ABORT, 'match events are append-only');
      END
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_match_events_immutable_delete"
      BEFORE DELETE ON "match_events"
      BEGIN
        SELECT RAISE(ABORT, 'match events cannot be deleted');
      END
    `);

    await queryRunner.query(`
      CREATE TRIGGER "trg_match_score_entries_validate_award"
      BEFORE INSERT ON "match_score_entries"
      WHEN NEW."entry_type" = 'award'
      BEGIN
        SELECT CASE
          WHEN NOT EXISTS (
            SELECT 1 FROM "match_events" e
            WHERE e."match_id" = NEW."match_id"
              AND e."event_sequence" = NEW."source_event_sequence"
              AND e."round_number" = NEW."round_number"
              AND e."event_type" = 'round_completed'
              AND e."team" = NEW."team"
              AND e."points" = NEW."points"
              AND e."reason" = NEW."award_reason"
          ) THEN RAISE(ABORT, 'score award must match its round_completed event')
        END;
        SELECT CASE
          WHEN NOT EXISTS (
            SELECT 1 FROM "match_rounds" r
            WHERE r."match_id" = NEW."match_id"
              AND r."round_number" = NEW."round_number"
              AND r."phase" = 'completed'
              AND r."score_award_team" = NEW."team"
              AND r."score_award_points" = NEW."points"
              AND r."score_award_reason" = NEW."award_reason"
          ) THEN RAISE(ABORT, 'score award must match the completed round state')
        END;
        SELECT CASE
          WHEN EXISTS (
            SELECT 1 FROM "match_score_entries" award
            WHERE award."match_id" = NEW."match_id"
              AND award."round_number" = NEW."round_number"
              AND award."entry_type" = 'award'
              AND NOT EXISTS (
                SELECT 1 FROM "match_score_entries" reversal
                WHERE reversal."match_id" = award."match_id"
                  AND reversal."reverses_entry_id" = award."id"
              )
          ) THEN RAISE(ABORT, 'round already has an active score award')
        END;
        SELECT CASE
          WHEN NEW."points" > 9007199254740991 - COALESCE((
            SELECT SUM(award."points")
            FROM "match_score_entries" award
            WHERE award."match_id" = NEW."match_id"
              AND award."team" = NEW."team"
              AND award."entry_type" = 'award'
              AND NOT EXISTS (
                SELECT 1 FROM "match_score_entries" reversal
                WHERE reversal."match_id" = award."match_id"
                  AND reversal."reverses_entry_id" = award."id"
              )
          ), 0) THEN RAISE(ABORT, 'match team score exceeds the safe integer range')
        END;
      END
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_match_score_entries_validate_reversal"
      BEFORE INSERT ON "match_score_entries"
      WHEN NEW."entry_type" = 'reversal'
      BEGIN
        SELECT CASE
          WHEN NOT EXISTS (
            SELECT 1 FROM "match_score_entries" original
            WHERE original."match_id" = NEW."match_id"
              AND original."id" = NEW."reverses_entry_id"
              AND original."entry_type" = 'award'
              AND original."round_number" = NEW."round_number"
              AND original."team" = NEW."team"
              AND original."points" = NEW."points"
          ) THEN RAISE(ABORT, 'reversal must exactly reference an original award for the same round and team')
        END;
        SELECT CASE
          WHEN NOT EXISTS (
            SELECT 1 FROM "match_events" e
            WHERE e."match_id" = NEW."match_id"
              AND e."event_sequence" = NEW."source_event_sequence"
              AND e."round_number" = NEW."round_number"
              AND e."event_type" = 'answer_retracted'
          ) THEN RAISE(ABORT, 'score reversal must reference an answer_retracted event')
        END;
        SELECT CASE
          WHEN EXISTS (
            SELECT 1 FROM "match_rounds" r
            WHERE r."match_id" = NEW."match_id"
              AND r."round_number" = NEW."round_number"
              AND r."score_award_team" IS NOT NULL
          ) THEN RAISE(ABORT, 'round award must be cleared before recording its reversal')
        END;
      END
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_match_score_entries_immutable_update"
      BEFORE UPDATE ON "match_score_entries"
      BEGIN
        SELECT RAISE(ABORT, 'match score entries are append-only');
      END
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_match_score_entries_immutable_delete"
      BEFORE DELETE ON "match_score_entries"
      BEGIN
        SELECT RAISE(ABORT, 'match score entries cannot be deleted');
      END
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TRIGGER "trg_match_rounds_ownership_event_reference_update"`);
    await queryRunner.query(`DROP TRIGGER "trg_match_rounds_ownership_event_reference_insert"`);
    await queryRunner.query(`DROP TRIGGER "trg_match_score_entries_immutable_delete"`);
    await queryRunner.query(`DROP TRIGGER "trg_match_score_entries_immutable_update"`);
    await queryRunner.query(`DROP TRIGGER "trg_match_score_entries_validate_reversal"`);
    await queryRunner.query(`DROP TRIGGER "trg_match_score_entries_validate_award"`);
    await queryRunner.query(`DROP TRIGGER "trg_match_events_immutable_delete"`);
    await queryRunner.query(`DROP TRIGGER "trg_match_events_immutable_update"`);
    await queryRunner.query(`DROP TRIGGER "trg_match_commands_immutable_delete"`);
    await queryRunner.query(`DROP TRIGGER "trg_match_commands_immutable_update"`);
    await queryRunner.query(`DROP TRIGGER "trg_match_events_sequence_and_revision"`);
    await queryRunner.query(`DROP TRIGGER "trg_match_commands_revision_is_current"`);
    await queryRunner.query(`DROP TRIGGER "trg_matches_event_sequence_never_decreases"`);
    await queryRunner.query(`DROP TRIGGER "trg_matches_revision_increments_once"`);
    await queryRunner.query(`DROP TABLE "match_score_entries"`);
    await queryRunner.query(`DROP TABLE "match_events"`);
    await queryRunner.query(`DROP TABLE "match_commands"`);
  }
}
