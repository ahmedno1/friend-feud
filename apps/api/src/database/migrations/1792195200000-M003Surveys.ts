import { MigrationInterface, QueryRunner } from 'typeorm';

export class M003Surveys1792195200000 implements MigrationInterface {
  name = 'M003Surveys1792195200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "surveys" (
        "id" TEXT NOT NULL,
        "question_source_id" TEXT NOT NULL,
        "prompt" TEXT NOT NULL,
        "language" TEXT NOT NULL,
        "status" TEXT NOT NULL DEFAULT 'draft',
        "created_by_actor_id" TEXT,
        "created_at" INTEGER NOT NULL,
        "opened_at" INTEGER,
        "closed_at" INTEGER,
        "resulting_question_id" TEXT,
        CONSTRAINT "pk_surveys" PRIMARY KEY ("id"),
        CONSTRAINT "uq_surveys_question_source" UNIQUE ("question_source_id"),
        CONSTRAINT "uq_surveys_id_source" UNIQUE ("id", "question_source_id"),
        CONSTRAINT "ck_surveys_id_nonempty" CHECK (length(trim("id")) > 0),
        CONSTRAINT "ck_surveys_prompt" CHECK (length(trim("prompt")) > 0),
        CONSTRAINT "ck_surveys_language" CHECK (length(trim("language")) > 0),
        CONSTRAINT "ck_surveys_status" CHECK ("status" IN ('draft', 'open', 'closed', 'under_review', 'converted')),
        CONSTRAINT "ck_surveys_creator" CHECK (
          "created_by_actor_id" IS NULL OR length(trim("created_by_actor_id")) > 0
        ),
        CONSTRAINT "ck_surveys_created_at" CHECK (
          typeof("created_at") = 'integer' AND "created_at" BETWEEN 0 AND 9007199254740991
        ),
        CONSTRAINT "ck_surveys_opened_at" CHECK (
          "opened_at" IS NULL OR (typeof("opened_at") = 'integer' AND "opened_at" BETWEEN "created_at" AND 9007199254740991)
        ),
        CONSTRAINT "ck_surveys_closed_at" CHECK (
          "closed_at" IS NULL OR (
            typeof("closed_at") = 'integer'
            AND "closed_at" BETWEEN COALESCE("opened_at", "created_at") AND 9007199254740991
          )
        ),
        CONSTRAINT "ck_surveys_lifecycle" CHECK (
          ("status" = 'draft' AND "opened_at" IS NULL AND "closed_at" IS NULL)
          OR ("status" = 'open' AND "opened_at" IS NOT NULL AND "closed_at" IS NULL)
          OR ("status" IN ('closed', 'under_review', 'converted') AND "opened_at" IS NOT NULL AND "closed_at" IS NOT NULL)
        ),
        CONSTRAINT "ck_surveys_converted_question" CHECK (
          ("status" = 'converted' AND "resulting_question_id" IS NOT NULL)
          OR ("status" <> 'converted')
        ),
        CONSTRAINT "fk_surveys_question_source" FOREIGN KEY ("question_source_id")
          REFERENCES "question_sources" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_surveys_result_question" FOREIGN KEY ("resulting_question_id")
          REFERENCES "questions" ("id") ON DELETE RESTRICT
      )
    `);
    await queryRunner.query(`CREATE INDEX "ix_surveys_status_created" ON "surveys" ("status", "created_at")`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "ux_surveys_resulting_question"
      ON "surveys" ("resulting_question_id")
      WHERE "resulting_question_id" IS NOT NULL
    `);

    await queryRunner.query(`
      CREATE TABLE "survey_answer_variants" (
        "id" TEXT NOT NULL,
        "survey_id" TEXT NOT NULL,
        "display_text" TEXT NOT NULL,
        "normalized_key" TEXT NOT NULL,
        "normalization_version" INTEGER NOT NULL,
        "status" TEXT NOT NULL DEFAULT 'pending',
        "merged_into_variant_id" TEXT,
        "approved_question_revision_answer_id" TEXT,
        "created_at" INTEGER NOT NULL,
        CONSTRAINT "pk_survey_answer_variants" PRIMARY KEY ("id"),
        CONSTRAINT "uq_survey_answer_variants_survey_id" UNIQUE ("survey_id", "id"),
        CONSTRAINT "uq_survey_answer_variants_normalized" UNIQUE ("survey_id", "normalization_version", "normalized_key"),
        CONSTRAINT "ck_survey_answer_variants_id_nonempty" CHECK (length(trim("id")) > 0),
        CONSTRAINT "ck_survey_answer_variants_display_text" CHECK (length(trim("display_text")) > 0),
        CONSTRAINT "ck_survey_answer_variants_normalized_key" CHECK (length(trim("normalized_key")) > 0),
        CONSTRAINT "ck_survey_answer_variants_normalization_version" CHECK (
          typeof("normalization_version") = 'integer'
          AND "normalization_version" BETWEEN 1 AND 9007199254740991
        ),
        CONSTRAINT "ck_survey_answer_variants_status" CHECK ("status" IN ('pending', 'approved', 'merged', 'rejected')),
        CONSTRAINT "ck_survey_answer_variants_merge_pair" CHECK (
          ("status" = 'merged' AND "merged_into_variant_id" IS NOT NULL AND "merged_into_variant_id" <> "id")
          OR ("status" <> 'merged' AND "merged_into_variant_id" IS NULL)
        ),
        CONSTRAINT "ck_survey_answer_variants_approved_question_answer" CHECK (
          "approved_question_revision_answer_id" IS NULL OR "status" = 'approved'
        ),
        CONSTRAINT "ck_survey_answer_variants_created_at" CHECK (
          typeof("created_at") = 'integer' AND "created_at" BETWEEN 0 AND 9007199254740991
        ),
        CONSTRAINT "fk_survey_answer_variants_survey" FOREIGN KEY ("survey_id")
          REFERENCES "surveys" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_survey_answer_variants_merge_target" FOREIGN KEY ("survey_id", "merged_into_variant_id")
          REFERENCES "survey_answer_variants" ("survey_id", "id") ON DELETE RESTRICT,
        CONSTRAINT "fk_survey_answer_variants_question_answer" FOREIGN KEY ("approved_question_revision_answer_id")
          REFERENCES "question_revision_answers" ("id") ON DELETE RESTRICT
      )
    `);
    await queryRunner.query(`CREATE INDEX "ix_survey_answer_variants_survey_status" ON "survey_answer_variants" ("survey_id", "status")`);
    await queryRunner.query(`CREATE INDEX "ix_survey_answer_variants_merge_target" ON "survey_answer_variants" ("survey_id", "merged_into_variant_id")`);

    await queryRunner.query(`
      CREATE TABLE "survey_responses" (
        "id" TEXT NOT NULL,
        "survey_id" TEXT NOT NULL,
        "device_id" TEXT NOT NULL,
        "raw_text" TEXT NOT NULL,
        "normalized_key" TEXT,
        "normalization_version" INTEGER,
        "candidate_variant_id" TEXT,
        "submitted_at" INTEGER NOT NULL,
        CONSTRAINT "pk_survey_responses" PRIMARY KEY ("id"),
        CONSTRAINT "uq_survey_responses_survey_device" UNIQUE ("survey_id", "device_id"),
        CONSTRAINT "uq_survey_responses_id_survey" UNIQUE ("id", "survey_id"),
        CONSTRAINT "ck_survey_responses_id_nonempty" CHECK (length(trim("id")) > 0),
        CONSTRAINT "ck_survey_responses_raw_text" CHECK (length(trim("raw_text")) > 0),
        CONSTRAINT "ck_survey_responses_normalized_pair" CHECK (
          ("normalized_key" IS NULL AND "normalization_version" IS NULL)
          OR (
            "normalized_key" IS NOT NULL
            AND length(trim("normalized_key")) > 0
            AND typeof("normalization_version") = 'integer'
            AND "normalization_version" BETWEEN 1 AND 9007199254740991
          )
        ),
        CONSTRAINT "ck_survey_responses_candidate_requires_normalization" CHECK (
          "candidate_variant_id" IS NULL OR "normalized_key" IS NOT NULL
        ),
        CONSTRAINT "ck_survey_responses_submitted_at" CHECK (
          typeof("submitted_at") = 'integer' AND "submitted_at" BETWEEN 0 AND 9007199254740991
        ),
        CONSTRAINT "fk_survey_responses_survey" FOREIGN KEY ("survey_id")
          REFERENCES "surveys" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_survey_responses_device" FOREIGN KEY ("device_id")
          REFERENCES "devices" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_survey_responses_candidate" FOREIGN KEY ("survey_id", "candidate_variant_id")
          REFERENCES "survey_answer_variants" ("survey_id", "id") ON DELETE RESTRICT
      )
    `);
    await queryRunner.query(`CREATE INDEX "ix_survey_responses_candidate" ON "survey_responses" ("survey_id", "candidate_variant_id")`);
    await queryRunner.query(`CREATE INDEX "ix_survey_responses_device" ON "survey_responses" ("device_id")`);

    await queryRunner.query(`
      CREATE TABLE "survey_review_events" (
        "id" TEXT NOT NULL,
        "survey_id" TEXT NOT NULL,
        "reviewer_actor_id" TEXT,
        "action_type" TEXT NOT NULL,
        "source_variant_id" TEXT NOT NULL,
        "target_variant_id" TEXT,
        "note" TEXT,
        "created_at" INTEGER NOT NULL,
        CONSTRAINT "pk_survey_review_events" PRIMARY KEY ("id"),
        CONSTRAINT "uq_survey_review_events_id_survey" UNIQUE ("id", "survey_id"),
        CONSTRAINT "ck_survey_review_events_id_nonempty" CHECK (length(trim("id")) > 0),
        CONSTRAINT "ck_survey_review_events_reviewer" CHECK (
          "reviewer_actor_id" IS NULL OR length(trim("reviewer_actor_id")) > 0
        ),
        CONSTRAINT "ck_survey_review_events_action" CHECK (
          "action_type" IN ('approve_variant', 'merge_variant', 'reject_variant')
        ),
        CONSTRAINT "ck_survey_review_events_source" CHECK (length(trim("source_variant_id")) > 0),
        CONSTRAINT "ck_survey_review_events_target" CHECK (
          ("action_type" = 'merge_variant' AND "target_variant_id" IS NOT NULL AND "target_variant_id" <> "source_variant_id")
          OR ("action_type" <> 'merge_variant' AND "target_variant_id" IS NULL)
        ),
        CONSTRAINT "ck_survey_review_events_note" CHECK ("note" IS NULL OR length(trim("note")) > 0),
        CONSTRAINT "ck_survey_review_events_created_at" CHECK (
          typeof("created_at") = 'integer' AND "created_at" BETWEEN 0 AND 9007199254740991
        ),
        CONSTRAINT "fk_survey_review_events_survey" FOREIGN KEY ("survey_id")
          REFERENCES "surveys" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_survey_review_events_source_variant" FOREIGN KEY ("survey_id", "source_variant_id")
          REFERENCES "survey_answer_variants" ("survey_id", "id") ON DELETE RESTRICT,
        CONSTRAINT "fk_survey_review_events_target_variant" FOREIGN KEY ("survey_id", "target_variant_id")
          REFERENCES "survey_answer_variants" ("survey_id", "id") ON DELETE RESTRICT
      )
    `);
    await queryRunner.query(`CREATE INDEX "ix_survey_review_events_survey_time" ON "survey_review_events" ("survey_id", "created_at")`);
    await queryRunner.query(`CREATE INDEX "ix_survey_review_events_source_variant" ON "survey_review_events" ("survey_id", "source_variant_id")`);

    await queryRunner.query(`
      CREATE TRIGGER "trg_surveys_question_source_type_insert"
      BEFORE INSERT ON "surveys"
      WHEN NOT EXISTS (
        SELECT 1 FROM "question_sources"
        WHERE "id" = NEW."question_source_id" AND "source_type" = 'survey'
      )
      BEGIN
        SELECT RAISE(ABORT, 'survey must reference a survey question source');
      END
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_surveys_question_source_type_update"
      BEFORE UPDATE OF "question_source_id" ON "surveys"
      WHEN NOT EXISTS (
        SELECT 1 FROM "question_sources"
        WHERE "id" = NEW."question_source_id" AND "source_type" = 'survey'
      )
      BEGIN
        SELECT RAISE(ABORT, 'survey must reference a survey question source');
      END
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_surveys_result_question_source_insert"
      BEFORE INSERT ON "surveys"
      WHEN NEW."resulting_question_id" IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM "questions"
          WHERE "id" = NEW."resulting_question_id" AND "source_id" = NEW."question_source_id"
        )
      BEGIN
        SELECT RAISE(ABORT, 'resulting question must be derived from this survey source');
      END
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_surveys_result_question_source_update"
      BEFORE UPDATE OF "question_source_id", "resulting_question_id" ON "surveys"
      WHEN NEW."resulting_question_id" IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM "questions"
          WHERE "id" = NEW."resulting_question_id" AND "source_id" = NEW."question_source_id"
        )
      BEGIN
        SELECT RAISE(ABORT, 'resulting question must be derived from this survey source');
      END
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_survey_responses_candidate_matches_normalization_insert"
      BEFORE INSERT ON "survey_responses"
      WHEN NEW."candidate_variant_id" IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM "survey_answer_variants"
          WHERE "survey_id" = NEW."survey_id"
            AND "id" = NEW."candidate_variant_id"
            AND "normalized_key" = NEW."normalized_key"
            AND "normalization_version" = NEW."normalization_version"
        )
      BEGIN
        SELECT RAISE(ABORT, 'response candidate must match its normalized key and survey');
      END
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_survey_responses_candidate_matches_normalization_update"
      BEFORE UPDATE OF "survey_id", "normalized_key", "normalization_version", "candidate_variant_id" ON "survey_responses"
      WHEN NEW."candidate_variant_id" IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM "survey_answer_variants"
          WHERE "survey_id" = NEW."survey_id"
            AND "id" = NEW."candidate_variant_id"
            AND "normalized_key" = NEW."normalized_key"
            AND "normalization_version" = NEW."normalization_version"
        )
      BEGIN
        SELECT RAISE(ABORT, 'response candidate must match its normalized key and survey');
      END
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_survey_responses_raw_immutable"
      BEFORE UPDATE OF "survey_id", "device_id", "raw_text", "submitted_at" ON "survey_responses"
      BEGIN
        SELECT RAISE(ABORT, 'raw survey responses are immutable');
      END
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_survey_responses_no_delete"
      BEFORE DELETE ON "survey_responses"
      BEGIN
        SELECT RAISE(ABORT, 'raw survey responses cannot be deleted');
      END
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_survey_variants_approved_answer_insert"
      BEFORE INSERT ON "survey_answer_variants"
      WHEN NEW."approved_question_revision_answer_id" IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM "question_revision_answers" answer
          JOIN "question_revisions" revision ON revision."id" = answer."revision_id"
          JOIN "questions" question ON question."id" = revision."question_id"
          JOIN "surveys" survey ON survey."question_source_id" = question."source_id"
          WHERE answer."id" = NEW."approved_question_revision_answer_id"
            AND survey."id" = NEW."survey_id"
            AND answer."normalized_key" = NEW."normalized_key"
            AND answer."normalization_version" = NEW."normalization_version"
            AND revision."status" = 'approved'
        )
      BEGIN
        SELECT RAISE(ABORT, 'linked question answer must be approved and match normalization');
      END
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_survey_variants_approved_answer_update"
      BEFORE UPDATE OF "approved_question_revision_answer_id", "normalized_key", "normalization_version" ON "survey_answer_variants"
      WHEN NEW."approved_question_revision_answer_id" IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM "question_revision_answers" answer
          JOIN "question_revisions" revision ON revision."id" = answer."revision_id"
          JOIN "questions" question ON question."id" = revision."question_id"
          JOIN "surveys" survey ON survey."question_source_id" = question."source_id"
          WHERE answer."id" = NEW."approved_question_revision_answer_id"
            AND survey."id" = NEW."survey_id"
            AND answer."normalized_key" = NEW."normalized_key"
            AND answer."normalization_version" = NEW."normalization_version"
            AND revision."status" = 'approved'
        )
      BEGIN
        SELECT RAISE(ABORT, 'linked question answer must be approved and match normalization');
      END
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_survey_variants_review_event_required"
      BEFORE UPDATE OF "status", "merged_into_variant_id", "approved_question_revision_answer_id" ON "survey_answer_variants"
      WHEN (
        NEW."status" = 'approved'
        AND NOT EXISTS (
          SELECT 1 FROM "survey_review_events"
          WHERE "survey_id" = NEW."survey_id" AND "source_variant_id" = NEW."id"
            AND "action_type" = 'approve_variant'
        )
      ) OR (
        NEW."status" = 'merged'
        AND NOT EXISTS (
          SELECT 1 FROM "survey_review_events"
          WHERE "survey_id" = NEW."survey_id" AND "source_variant_id" = NEW."id"
            AND "target_variant_id" = NEW."merged_into_variant_id"
            AND "action_type" = 'merge_variant'
        )
      ) OR (
        NEW."status" = 'rejected'
        AND NOT EXISTS (
          SELECT 1 FROM "survey_review_events"
          WHERE "survey_id" = NEW."survey_id" AND "source_variant_id" = NEW."id"
            AND "action_type" = 'reject_variant'
        )
      )
      BEGIN
        SELECT RAISE(ABORT, 'variant state changes require a matching review event in the same transaction');
      END
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_survey_variants_immutable_content"
      BEFORE UPDATE OF "survey_id", "display_text", "normalized_key", "normalization_version", "created_at" ON "survey_answer_variants"
      BEGIN
        SELECT RAISE(ABORT, 'survey answer variant identity and normalized content are immutable');
      END
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_survey_variants_terminal_state"
      BEFORE UPDATE OF "status", "merged_into_variant_id", "approved_question_revision_answer_id" ON "survey_answer_variants"
      WHEN OLD."status" IN ('approved', 'merged', 'rejected')
      BEGIN
        SELECT RAISE(ABORT, 'final survey variant decisions are immutable');
      END
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_survey_variants_merge_target_not_merged"
      BEFORE UPDATE OF "status", "merged_into_variant_id" ON "survey_answer_variants"
      WHEN NEW."status" = 'merged'
        AND EXISTS (
          SELECT 1 FROM "survey_answer_variants" target
          WHERE target."survey_id" = NEW."survey_id"
            AND target."id" = NEW."merged_into_variant_id"
            AND target."status" <> 'pending'
        )
      BEGIN
        SELECT RAISE(ABORT, 'merge target must be a pending variant in the same survey');
      END
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_survey_variants_keep_merge_targets_terminal"
      BEFORE UPDATE OF "status" ON "survey_answer_variants"
      WHEN NEW."status" <> 'pending'
        AND EXISTS (
          SELECT 1 FROM "survey_answer_variants" source
          WHERE source."survey_id" = NEW."survey_id"
            AND source."merged_into_variant_id" = NEW."id"
        )
      BEGIN
        SELECT RAISE(ABORT, 'a merge target already referenced by a source cannot become terminal');
      END
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_survey_review_events_no_update"
      BEFORE UPDATE ON "survey_review_events"
      BEGIN
        SELECT RAISE(ABORT, 'survey review events are append-only');
      END
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_survey_review_events_no_delete"
      BEFORE DELETE ON "survey_review_events"
      BEGIN
        SELECT RAISE(ABORT, 'survey review events cannot be deleted');
      END
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_survey_review_events_require_pending_variant"
      BEFORE INSERT ON "survey_review_events"
      WHEN NOT EXISTS (
        SELECT 1 FROM "survey_answer_variants"
        WHERE "survey_id" = NEW."survey_id" AND "id" = NEW."source_variant_id"
      )
      BEGIN
        SELECT RAISE(ABORT, 'review event source variant must belong to the survey');
      END
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TRIGGER "trg_survey_review_events_require_pending_variant"`);
    await queryRunner.query(`DROP TRIGGER "trg_survey_review_events_no_delete"`);
    await queryRunner.query(`DROP TRIGGER "trg_survey_review_events_no_update"`);
    await queryRunner.query(`DROP TRIGGER "trg_survey_variants_keep_merge_targets_terminal"`);
    await queryRunner.query(`DROP TRIGGER "trg_survey_variants_merge_target_not_merged"`);
    await queryRunner.query(`DROP TRIGGER "trg_survey_variants_terminal_state"`);
    await queryRunner.query(`DROP TRIGGER "trg_survey_variants_immutable_content"`);
    await queryRunner.query(`DROP TRIGGER "trg_survey_variants_review_event_required"`);
    await queryRunner.query(`DROP TRIGGER "trg_survey_variants_approved_answer_update"`);
    await queryRunner.query(`DROP TRIGGER "trg_survey_variants_approved_answer_insert"`);
    await queryRunner.query(`DROP TRIGGER "trg_survey_responses_no_delete"`);
    await queryRunner.query(`DROP TRIGGER "trg_survey_responses_raw_immutable"`);
    await queryRunner.query(`DROP TRIGGER "trg_survey_responses_candidate_matches_normalization_update"`);
    await queryRunner.query(`DROP TRIGGER "trg_survey_responses_candidate_matches_normalization_insert"`);
    await queryRunner.query(`DROP TRIGGER "trg_surveys_result_question_source_update"`);
    await queryRunner.query(`DROP TRIGGER "trg_surveys_result_question_source_insert"`);
    await queryRunner.query(`DROP TRIGGER "trg_surveys_question_source_type_update"`);
    await queryRunner.query(`DROP TRIGGER "trg_surveys_question_source_type_insert"`);
    await queryRunner.query(`DROP TABLE "survey_review_events"`);
    await queryRunner.query(`DROP TABLE "survey_responses"`);
    await queryRunner.query(`DROP TABLE "survey_answer_variants"`);
    await queryRunner.query(`DROP TABLE "surveys"`);
  }
}
