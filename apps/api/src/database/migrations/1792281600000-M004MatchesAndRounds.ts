import { MigrationInterface, QueryRunner } from 'typeorm';

export class M004MatchesAndRounds1792281600000 implements MigrationInterface {
  name = 'M004MatchesAndRounds1792281600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE UNIQUE INDEX "ux_room_members_id_room" ON "room_members" ("id", "room_id")`);
    await queryRunner.query(`CREATE UNIQUE INDEX "ux_question_revision_answers_revision_id" ON "question_revision_answers" ("revision_id", "id")`);

    await queryRunner.query(`
      CREATE TABLE "matches" (
        "id" TEXT NOT NULL,
        "room_id" TEXT NOT NULL,
        "created_by_room_member_id" TEXT,
        "status" TEXT NOT NULL DEFAULT 'setup',
        "current_round_number" INTEGER,
        "revision" INTEGER NOT NULL DEFAULT 0,
        "next_event_sequence" INTEGER NOT NULL DEFAULT 1,
        "state_schema_version" INTEGER NOT NULL DEFAULT 1,
        "created_at" INTEGER NOT NULL,
        "started_at" INTEGER,
        "completed_at" INTEGER,
        "outcome" TEXT,
        CONSTRAINT "pk_matches" PRIMARY KEY ("id"),
        CONSTRAINT "uq_matches_id_room" UNIQUE ("id", "room_id"),
        CONSTRAINT "ck_matches_id_nonempty" CHECK (length(trim("id")) > 0),
        CONSTRAINT "ck_matches_status" CHECK ("status" IN ('setup', 'in_progress', 'paused_host_disconnected', 'completed')),
        CONSTRAINT "ck_matches_current_round" CHECK (
          ("status" = 'setup' AND "current_round_number" IS NULL)
          OR ("status" <> 'setup' AND typeof("current_round_number") = 'integer' AND "current_round_number" BETWEEN 1 AND 3)
        ),
        CONSTRAINT "ck_matches_revision" CHECK (
          typeof("revision") = 'integer' AND "revision" BETWEEN 0 AND 9007199254740991
        ),
        CONSTRAINT "ck_matches_next_event_sequence" CHECK (
          typeof("next_event_sequence") = 'integer'
          AND "next_event_sequence" BETWEEN 1 AND 9007199254740991
        ),
        CONSTRAINT "ck_matches_state_schema_version" CHECK (
          typeof("state_schema_version") = 'integer' AND "state_schema_version" > 0
        ),
        CONSTRAINT "ck_matches_created_at" CHECK (
          typeof("created_at") = 'integer' AND "created_at" BETWEEN 0 AND 9007199254740991
        ),
        CONSTRAINT "ck_matches_started_at" CHECK (
          ("status" = 'setup' AND "started_at" IS NULL)
          OR ("status" <> 'setup' AND typeof("started_at") = 'integer' AND "started_at" >= "created_at")
        ),
        CONSTRAINT "ck_matches_completed_at" CHECK (
          ("status" = 'completed' AND typeof("completed_at") = 'integer' AND "completed_at" >= "started_at")
          OR ("status" <> 'completed' AND "completed_at" IS NULL)
        ),
        CONSTRAINT "ck_matches_outcome" CHECK (
          ("status" = 'completed' AND "outcome" IS NOT NULL AND "outcome" IN ('team_one', 'team_two', 'tie'))
          OR ("status" <> 'completed' AND "outcome" IS NULL)
        ),
        CONSTRAINT "fk_matches_room" FOREIGN KEY ("room_id") REFERENCES "rooms" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_matches_creator_room_member" FOREIGN KEY ("created_by_room_member_id", "room_id")
          REFERENCES "room_members" ("id", "room_id") ON DELETE RESTRICT
      )
    `);
    await queryRunner.query(`CREATE INDEX "ix_matches_room_status" ON "matches" ("room_id", "status")`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "ux_matches_one_active_per_room"
      ON "matches" ("room_id")
      WHERE "status" IN ('setup', 'in_progress', 'paused_host_disconnected')
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_matches_insert_setup_only"
      BEFORE INSERT ON "matches"
      WHEN NEW."status" <> 'setup'
      BEGIN
        SELECT RAISE(ABORT, 'matches must be created in setup status');
      END
    `);

    await queryRunner.query(`
      CREATE TABLE "match_rounds" (
        "id" TEXT NOT NULL,
        "match_id" TEXT NOT NULL,
        "room_id" TEXT NOT NULL,
        "round_number" INTEGER NOT NULL,
        "phase" TEXT NOT NULL DEFAULT 'pending',
        "source_question_id" TEXT,
        "source_revision_id" TEXT,
        "question_identifier_snapshot" TEXT NOT NULL,
        "question_text_snapshot" TEXT NOT NULL,
        "first_buzz_team" TEXT,
        "ownership_turn_team" TEXT,
        "owner_team" TEXT,
        "answering_team" TEXT,
        "ownership_misses" INTEGER NOT NULL DEFAULT 0,
        "pending_ownership_decision_team" TEXT,
        "ownership_resolution_event_sequence" INTEGER,
        "ownership_resolution_team" TEXT,
        "ownership_resolution_retracted" INTEGER NOT NULL DEFAULT 0,
        "main_play_errors" INTEGER NOT NULL DEFAULT 0,
        "pending_retracted_answer_team" TEXT,
        "steal_status" TEXT NOT NULL DEFAULT 'unavailable',
        "steal_team" TEXT,
        "steal_result" TEXT,
        "reveal_sequence" INTEGER NOT NULL DEFAULT 0,
        "score_award_team" TEXT,
        "score_award_points" INTEGER,
        "score_award_reason" TEXT,
        CONSTRAINT "pk_match_rounds" PRIMARY KEY ("id"),
        CONSTRAINT "uq_match_rounds_match_number" UNIQUE ("match_id", "round_number"),
        CONSTRAINT "uq_match_rounds_id_source_revision" UNIQUE ("id", "source_revision_id"),
        CONSTRAINT "ck_match_rounds_id_nonempty" CHECK (length(trim("id")) > 0),
        CONSTRAINT "ck_match_rounds_number" CHECK (typeof("round_number") = 'integer' AND "round_number" BETWEEN 1 AND 3),
        CONSTRAINT "ck_match_rounds_phase" CHECK ("phase" IN ('pending', 'toss', 'ownership', 'main_play', 'steal', 'completed')),
        CONSTRAINT "ck_match_rounds_source_pair" CHECK (
          ("source_question_id" IS NULL AND "source_revision_id" IS NULL)
          OR (
            "source_question_id" IS NOT NULL
            AND "source_revision_id" IS NOT NULL
            AND "question_identifier_snapshot" = "source_question_id"
          )
        ),
        CONSTRAINT "ck_match_rounds_snapshots" CHECK (
          length(trim("question_identifier_snapshot")) > 0 AND length(trim("question_text_snapshot")) > 0
        ),
        CONSTRAINT "ck_match_rounds_teams" CHECK (
          ("first_buzz_team" IS NULL OR "first_buzz_team" IN ('team_one', 'team_two'))
          AND ("ownership_turn_team" IS NULL OR "ownership_turn_team" IN ('team_one', 'team_two'))
          AND ("owner_team" IS NULL OR "owner_team" IN ('team_one', 'team_two'))
          AND ("answering_team" IS NULL OR "answering_team" IN ('team_one', 'team_two'))
          AND ("pending_ownership_decision_team" IS NULL OR "pending_ownership_decision_team" IN ('team_one', 'team_two'))
          AND ("ownership_resolution_team" IS NULL OR "ownership_resolution_team" IN ('team_one', 'team_two'))
          AND ("pending_retracted_answer_team" IS NULL OR "pending_retracted_answer_team" IN ('team_one', 'team_two'))
        ),
        CONSTRAINT "ck_match_rounds_ownership_resolution" CHECK (
          ("ownership_resolution_event_sequence" IS NULL AND "ownership_resolution_team" IS NULL AND "ownership_resolution_retracted" = 0)
          OR (
            typeof("ownership_resolution_event_sequence") = 'integer'
            AND "ownership_resolution_event_sequence" > 0
            AND "ownership_resolution_team" IS NOT NULL
            AND "ownership_resolution_team" IN ('team_one', 'team_two')
            AND typeof("ownership_resolution_retracted") = 'integer'
            AND "ownership_resolution_retracted" IN (0, 1)
          )
        ),
        CONSTRAINT "ck_match_rounds_ownership_retracted" CHECK (
          typeof("ownership_resolution_retracted") = 'integer' AND "ownership_resolution_retracted" IN (0, 1)
        ),
        CONSTRAINT "ck_match_rounds_errors" CHECK (
          typeof("ownership_misses") = 'integer' AND "ownership_misses" BETWEEN 0 AND 9007199254740991
          AND typeof("main_play_errors") = 'integer' AND "main_play_errors" BETWEEN 0 AND 3
        ),
        CONSTRAINT "ck_match_rounds_steal" CHECK (
          ("steal_status" = 'unavailable' AND "steal_team" IS NULL AND "steal_result" IS NULL)
          OR ("steal_status" = 'available' AND "steal_team" IS NOT NULL AND "steal_team" IN ('team_one', 'team_two') AND "steal_result" IS NULL)
          OR ("steal_status" = 'used' AND "steal_team" IS NOT NULL AND "steal_team" IN ('team_one', 'team_two') AND "steal_result" IS NOT NULL AND "steal_result" IN ('success', 'failed'))
        ),
        CONSTRAINT "ck_match_rounds_steal_status" CHECK ("steal_status" IN ('unavailable', 'available', 'used')),
        CONSTRAINT "ck_match_rounds_steal_result" CHECK ("steal_result" IS NULL OR "steal_result" IN ('success', 'failed')),
        CONSTRAINT "ck_match_rounds_reveal_sequence" CHECK (
          typeof("reveal_sequence") = 'integer' AND "reveal_sequence" BETWEEN 0 AND 9007199254740991
        ),
        CONSTRAINT "ck_match_rounds_score_award" CHECK (
          ("score_award_team" IS NULL AND "score_award_points" IS NULL AND "score_award_reason" IS NULL)
          OR (
            "score_award_team" IS NOT NULL
            AND "score_award_team" IN ('team_one', 'team_two')
            AND typeof("score_award_points") = 'integer'
            AND "score_award_points" BETWEEN 0 AND 9007199254740991
            AND "score_award_reason" IS NOT NULL
            AND "score_award_reason" IN ('all_answers_revealed', 'steal_success', 'steal_failed')
          )
        ),
        CONSTRAINT "ck_match_rounds_completed_award" CHECK ("phase" <> 'completed' OR "score_award_team" IS NOT NULL),
        CONSTRAINT "fk_match_rounds_match_room" FOREIGN KEY ("match_id", "room_id")
          REFERENCES "matches" ("id", "room_id") ON DELETE CASCADE,
        CONSTRAINT "fk_match_rounds_source_revision" FOREIGN KEY ("source_question_id", "source_revision_id")
          REFERENCES "question_revisions" ("question_id", "id") ON DELETE RESTRICT
      )
    `);
    await queryRunner.query(`CREATE INDEX "ix_match_rounds_match_phase" ON "match_rounds" ("match_id", "phase")`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "ux_match_rounds_question_once"
      ON "match_rounds" ("match_id", "source_question_id")
      WHERE "source_question_id" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_match_rounds_insert_setup_only"
      BEFORE INSERT ON "match_rounds"
      WHEN (SELECT "status" FROM "matches" WHERE "id" = NEW."match_id") <> 'setup'
      BEGIN
        SELECT RAISE(ABORT, 'rounds cannot be added after a match starts');
      END
    `);

    await queryRunner.query(`
      CREATE TABLE "match_round_answers" (
        "id" TEXT NOT NULL,
        "match_round_id" TEXT NOT NULL,
        "answer_id_snapshot" TEXT NOT NULL,
        "source_revision_id" TEXT,
        "source_answer_id" TEXT,
        "answer_text_snapshot" TEXT NOT NULL,
        "normalized_key_snapshot" TEXT,
        "normalization_version_snapshot" INTEGER,
        "answer_order_snapshot" INTEGER NOT NULL,
        "points_snapshot" INTEGER NOT NULL,
        "is_revealed" INTEGER NOT NULL DEFAULT 0,
        "active_reveal_id" INTEGER,
        "revealed_by_team" TEXT,
        CONSTRAINT "pk_match_round_answers" PRIMARY KEY ("id"),
        CONSTRAINT "uq_match_round_answers_round_id" UNIQUE ("match_round_id", "id"),
        CONSTRAINT "uq_match_round_answers_round_snapshot_id" UNIQUE ("match_round_id", "answer_id_snapshot"),
        CONSTRAINT "ck_match_round_answers_id_nonempty" CHECK (length(trim("id")) > 0),
        CONSTRAINT "ck_match_round_answers_answer_id_snapshot" CHECK (length(trim("answer_id_snapshot")) > 0),
        CONSTRAINT "ck_match_round_answers_source_pair" CHECK (
          ("source_revision_id" IS NULL AND "source_answer_id" IS NULL)
          OR (
            "source_revision_id" IS NOT NULL
            AND "source_answer_id" IS NOT NULL
            AND "answer_id_snapshot" = "source_answer_id"
          )
        ),
        CONSTRAINT "ck_match_round_answers_text_snapshot" CHECK (length(trim("answer_text_snapshot")) > 0),
        CONSTRAINT "ck_match_round_answers_normalization_pair" CHECK (
          ("normalized_key_snapshot" IS NULL AND "normalization_version_snapshot" IS NULL)
          OR (
            "normalized_key_snapshot" IS NOT NULL
            AND length(trim("normalized_key_snapshot")) > 0
            AND typeof("normalization_version_snapshot") = 'integer'
            AND "normalization_version_snapshot" BETWEEN 1 AND 9007199254740991
          )
        ),
        CONSTRAINT "ck_match_round_answers_order" CHECK (
          typeof("answer_order_snapshot") = 'integer' AND "answer_order_snapshot" BETWEEN 1 AND 9007199254740991
        ),
        CONSTRAINT "ck_match_round_answers_points" CHECK (
          typeof("points_snapshot") = 'integer' AND "points_snapshot" BETWEEN 0 AND 9007199254740991
        ),
        CONSTRAINT "ck_match_round_answers_reveal_state" CHECK (
          ("is_revealed" = 0 AND "active_reveal_id" IS NULL AND "revealed_by_team" IS NULL)
          OR (
            typeof("is_revealed") = 'integer' AND "is_revealed" = 1
            AND typeof("active_reveal_id") = 'integer' AND "active_reveal_id" > 0
            AND "revealed_by_team" IS NOT NULL
            AND "revealed_by_team" IN ('team_one', 'team_two')
          )
        ),
        CONSTRAINT "fk_match_round_answers_round" FOREIGN KEY ("match_round_id")
          REFERENCES "match_rounds" ("id") ON DELETE CASCADE,
        CONSTRAINT "fk_match_round_answers_round_source_revision" FOREIGN KEY ("match_round_id", "source_revision_id")
          REFERENCES "match_rounds" ("id", "source_revision_id") ON DELETE RESTRICT,
        CONSTRAINT "fk_match_round_answers_source_answer" FOREIGN KEY ("source_revision_id", "source_answer_id")
          REFERENCES "question_revision_answers" ("revision_id", "id") ON DELETE RESTRICT
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "ux_match_round_answers_round_order" ON "match_round_answers" ("match_round_id", "answer_order_snapshot")`);

    await queryRunner.query(`
      CREATE TRIGGER "trg_matches_status_transition"
      BEFORE UPDATE OF "status" ON "matches"
      WHEN NOT (
        OLD."status" = NEW."status"
        OR (OLD."status" = 'setup' AND NEW."status" = 'in_progress')
        OR (OLD."status" = 'in_progress' AND NEW."status" IN ('paused_host_disconnected', 'completed'))
        OR (OLD."status" = 'paused_host_disconnected' AND NEW."status" = 'in_progress')
      )
      BEGIN
        SELECT RAISE(ABORT, 'invalid match status transition');
      END
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_matches_complete_requires_all_rounds"
      BEFORE UPDATE OF "status" ON "matches"
      WHEN NEW."status" = 'completed'
      BEGIN
        SELECT CASE
          WHEN NEW."current_round_number" <> 3
            OR (SELECT COUNT(*) FROM "match_rounds" WHERE "match_id" = NEW."id" AND "phase" = 'completed') <> 3
          THEN RAISE(ABORT, 'all three rounds must be completed before the match completes')
        END;
      END
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_matches_start_requires_three_rounds"
      BEFORE UPDATE OF "status" ON "matches"
      WHEN OLD."status" = 'setup' AND NEW."status" IN ('in_progress', 'paused_host_disconnected', 'completed')
      BEGIN
        SELECT CASE
          WHEN (SELECT COUNT(*) FROM "match_rounds" WHERE "match_id" = NEW."id") <> 3
          THEN RAISE(ABORT, 'a match must contain exactly three rounds before it starts')
        END;
        SELECT CASE
          WHEN EXISTS (
            SELECT 1 FROM "match_rounds" r
            WHERE r."match_id" = NEW."id"
              AND (
                r."phase" <> 'pending'
                OR r."first_buzz_team" IS NOT NULL
                OR r."ownership_turn_team" IS NOT NULL
                OR r."owner_team" IS NOT NULL
                OR r."answering_team" IS NOT NULL
                OR r."ownership_misses" <> 0
                OR r."pending_ownership_decision_team" IS NOT NULL
                OR r."ownership_resolution_event_sequence" IS NOT NULL
                OR r."main_play_errors" <> 0
                OR r."pending_retracted_answer_team" IS NOT NULL
                OR r."steal_status" <> 'unavailable'
                OR r."reveal_sequence" <> 0
                OR r."score_award_team" IS NOT NULL
                OR NOT EXISTS (SELECT 1 FROM "match_round_answers" a WHERE a."match_round_id" = r."id")
                OR EXISTS (
                  SELECT 1 FROM "match_round_answers" a
                  WHERE a."match_round_id" = r."id"
                    AND (a."is_revealed" <> 0 OR a."active_reveal_id" IS NOT NULL OR a."revealed_by_team" IS NOT NULL)
                )
              )
          ) THEN RAISE(ABORT, 'every round must contain at least one answer before the match starts')
        END;
      END
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_match_round_answers_insert_setup_only"
      BEFORE INSERT ON "match_round_answers"
      WHEN (
        SELECT m."status"
        FROM "match_rounds" r JOIN "matches" m ON m."id" = r."match_id"
        WHERE r."id" = NEW."match_round_id"
      ) <> 'setup'
      BEGIN
          SELECT RAISE(ABORT, 'round answers cannot be added after a match starts');
      END
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_match_rounds_source_revision_approved_insert"
      BEFORE INSERT ON "match_rounds"
      WHEN NEW."source_revision_id" IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM "question_revisions"
          WHERE "question_id" = NEW."source_question_id"
            AND "id" = NEW."source_revision_id"
            AND "status" = 'approved'
            AND "question_text" = NEW."question_text_snapshot"
        )
      BEGIN
        SELECT RAISE(ABORT, 'match source revision must be approved for the same question');
      END
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_match_rounds_source_revision_approved_update"
      BEFORE UPDATE OF "source_question_id", "source_revision_id" ON "match_rounds"
      WHEN NEW."source_revision_id" IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM "question_revisions"
          WHERE "question_id" = NEW."source_question_id"
            AND "id" = NEW."source_revision_id"
            AND "status" = 'approved'
            AND "question_text" = NEW."question_text_snapshot"
        )
      BEGIN
        SELECT RAISE(ABORT, 'match source revision must be approved for the same question');
      END
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_match_rounds_snapshot_immutable_after_start"
      BEFORE UPDATE OF "source_question_id", "source_revision_id", "question_identifier_snapshot", "question_text_snapshot"
      ON "match_rounds"
      WHEN (SELECT "started_at" FROM "matches" WHERE "id" = OLD."match_id") IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'question snapshots are immutable after match start');
      END
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_match_rounds_no_delete_after_start"
      BEFORE DELETE ON "match_rounds"
      WHEN (SELECT "started_at" FROM "matches" WHERE "id" = OLD."match_id") IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'started match rounds cannot be deleted');
      END
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_match_round_answers_source_insert"
      BEFORE INSERT ON "match_round_answers"
      WHEN NEW."source_answer_id" IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM "match_rounds" r
          JOIN "question_revision_answers" a
            ON a."revision_id" = r."source_revision_id" AND a."id" = NEW."source_answer_id"
          WHERE r."id" = NEW."match_round_id"
            AND r."source_revision_id" = NEW."source_revision_id"
            AND a."answer_text" = NEW."answer_text_snapshot"
            AND a."normalized_key" = NEW."normalized_key_snapshot"
            AND a."normalization_version" = NEW."normalization_version_snapshot"
            AND a."answer_order" = NEW."answer_order_snapshot"
            AND a."points" = NEW."points_snapshot"
        )
      BEGIN
        SELECT RAISE(ABORT, 'source answer must belong to the selected revision and match its snapshot');
      END
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_match_round_answers_source_update"
      BEFORE UPDATE OF "match_round_id", "source_revision_id", "source_answer_id", "answer_text_snapshot", "normalized_key_snapshot", "normalization_version_snapshot", "answer_order_snapshot", "points_snapshot"
      ON "match_round_answers"
      WHEN NEW."source_answer_id" IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM "match_rounds" r
          JOIN "question_revision_answers" a
            ON a."revision_id" = r."source_revision_id" AND a."id" = NEW."source_answer_id"
          WHERE r."id" = NEW."match_round_id"
            AND r."source_revision_id" = NEW."source_revision_id"
            AND a."answer_text" = NEW."answer_text_snapshot"
            AND a."normalized_key" = NEW."normalized_key_snapshot"
            AND a."normalization_version" = NEW."normalization_version_snapshot"
            AND a."answer_order" = NEW."answer_order_snapshot"
            AND a."points" = NEW."points_snapshot"
        )
      BEGIN
        SELECT RAISE(ABORT, 'source answer must belong to the selected revision and match its snapshot');
      END
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_match_round_answers_snapshot_immutable_after_start"
      BEFORE UPDATE OF "answer_id_snapshot", "source_revision_id", "source_answer_id", "answer_text_snapshot", "normalized_key_snapshot", "normalization_version_snapshot", "answer_order_snapshot", "points_snapshot"
      ON "match_round_answers"
      WHEN (
          SELECT m."started_at"
        FROM "match_rounds" r JOIN "matches" m ON m."id" = r."match_id"
        WHERE r."id" = OLD."match_round_id"
      ) IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'answer snapshots are immutable after match start');
      END
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_match_round_answers_no_delete_after_start"
      BEFORE DELETE ON "match_round_answers"
      WHEN (
          SELECT m."started_at"
        FROM "match_rounds" r JOIN "matches" m ON m."id" = r."match_id"
        WHERE r."id" = OLD."match_round_id"
      ) IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'started match answers cannot be deleted');
      END
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_match_round_answers_safe_total_insert"
      BEFORE INSERT ON "match_round_answers"
      BEGIN
        SELECT CASE
          WHEN NEW."points_snapshot" > 9007199254740991 - COALESCE((
            SELECT SUM("points_snapshot") FROM "match_round_answers"
            WHERE "match_round_id" = NEW."match_round_id"
          ), 0)
          THEN RAISE(ABORT, 'round answer points exceed the safe integer range')
        END;
      END
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_match_round_answers_safe_total_update"
      BEFORE UPDATE OF "match_round_id", "points_snapshot" ON "match_round_answers"
      BEGIN
        SELECT CASE
          WHEN NEW."points_snapshot" > 9007199254740991 - COALESCE((
            SELECT SUM("points_snapshot") FROM "match_round_answers"
            WHERE "match_round_id" = NEW."match_round_id" AND "id" <> OLD."id"
          ), 0)
          THEN RAISE(ABORT, 'round answer points exceed the safe integer range')
        END;
      END
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TRIGGER "trg_match_round_answers_safe_total_update"`);
    await queryRunner.query(`DROP TRIGGER "trg_match_round_answers_safe_total_insert"`);
    await queryRunner.query(`DROP TRIGGER "trg_match_round_answers_insert_setup_only"`);
    await queryRunner.query(`DROP TRIGGER "trg_match_round_answers_no_delete_after_start"`);
    await queryRunner.query(`DROP TRIGGER "trg_match_round_answers_snapshot_immutable_after_start"`);
    await queryRunner.query(`DROP TRIGGER "trg_match_round_answers_source_update"`);
    await queryRunner.query(`DROP TRIGGER "trg_match_round_answers_source_insert"`);
    await queryRunner.query(`DROP TRIGGER "trg_match_rounds_no_delete_after_start"`);
    await queryRunner.query(`DROP TRIGGER "trg_match_rounds_snapshot_immutable_after_start"`);
    await queryRunner.query(`DROP TRIGGER "trg_match_rounds_source_revision_approved_update"`);
    await queryRunner.query(`DROP TRIGGER "trg_match_rounds_source_revision_approved_insert"`);
    await queryRunner.query(`DROP TRIGGER "trg_matches_complete_requires_all_rounds"`);
    await queryRunner.query(`DROP TRIGGER "trg_matches_status_transition"`);
    await queryRunner.query(`DROP TRIGGER "trg_matches_start_requires_three_rounds"`);
    await queryRunner.query(`DROP TRIGGER "trg_matches_insert_setup_only"`);
    await queryRunner.query(`DROP TRIGGER "trg_match_rounds_insert_setup_only"`);
    await queryRunner.query(`DROP TABLE "match_round_answers"`);
    await queryRunner.query(`DROP TABLE "match_rounds"`);
    await queryRunner.query(`DROP TABLE "matches"`);
    await queryRunner.query(`DROP INDEX "ux_question_revision_answers_revision_id"`);
    await queryRunner.query(`DROP INDEX "ux_room_members_id_room"`);
  }
}
