import { MigrationInterface, QueryRunner } from 'typeorm';

export class M002QuestionLibrary1792108800000 implements MigrationInterface {
  name = 'M002QuestionLibrary1792108800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "question_sources" (
        "id" TEXT NOT NULL,
        "source_type" TEXT NOT NULL,
        "name" TEXT NOT NULL,
        "external_reference" TEXT,
        "source_url" TEXT,
        "license_name" TEXT,
        "license_url" TEXT,
        "fetched_at" INTEGER,
        "created_by_member_id" TEXT,
        "created_at" INTEGER NOT NULL,
        CONSTRAINT "pk_question_sources" PRIMARY KEY ("id"),
        CONSTRAINT "ck_question_sources_id_nonempty" CHECK (length(trim("id")) > 0),
        CONSTRAINT "ck_question_sources_type" CHECK ("source_type" IN ('approved_import', 'host_custom', 'survey')),
        CONSTRAINT "ck_question_sources_name_nonempty" CHECK (length(trim("name")) > 0),
        CONSTRAINT "ck_question_sources_external_reference" CHECK (
          "external_reference" IS NULL OR length(trim("external_reference")) > 0
        ),
        CONSTRAINT "ck_question_sources_url" CHECK ("source_url" IS NULL OR length(trim("source_url")) > 0),
        CONSTRAINT "ck_question_sources_license_name" CHECK (
          "license_name" IS NULL OR length(trim("license_name")) > 0
        ),
        CONSTRAINT "ck_question_sources_license_url" CHECK (
          "license_url" IS NULL OR length(trim("license_url")) > 0
        ),
        CONSTRAINT "ck_question_sources_fetched_at" CHECK (
          "fetched_at" IS NULL
          OR ("source_type" = 'approved_import' AND typeof("fetched_at") = 'integer'
            AND "fetched_at" BETWEEN 0 AND 9007199254740991)
        ),
        CONSTRAINT "ck_question_sources_host_creator" CHECK (
          "source_type" <> 'host_custom' OR "created_by_member_id" IS NOT NULL
        ),
        CONSTRAINT "ck_question_sources_created_at" CHECK (
          typeof("created_at") = 'integer' AND "created_at" BETWEEN 0 AND 9007199254740991
        ),
        CONSTRAINT "fk_question_sources_creator" FOREIGN KEY ("created_by_member_id")
          REFERENCES "room_members" ("id") ON DELETE RESTRICT
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "questions" (
        "id" TEXT NOT NULL,
        "source_id" TEXT NOT NULL,
        "status" TEXT NOT NULL DEFAULT 'draft',
        "created_at" INTEGER NOT NULL,
        "updated_at" INTEGER NOT NULL,
        "current_published_revision_id" TEXT,
        "current_published_at" INTEGER,
        CONSTRAINT "pk_questions" PRIMARY KEY ("id"),
        CONSTRAINT "ck_questions_id_nonempty" CHECK (length(trim("id")) > 0),
        CONSTRAINT "ck_questions_status" CHECK ("status" IN ('draft', 'pending_review', 'published', 'archived')),
        CONSTRAINT "ck_questions_created_at" CHECK (
          typeof("created_at") = 'integer' AND "created_at" BETWEEN 0 AND 9007199254740991
        ),
        CONSTRAINT "ck_questions_updated_at" CHECK (
          typeof("updated_at") = 'integer'
          AND "updated_at" BETWEEN "created_at" AND 9007199254740991
        ),
        CONSTRAINT "ck_questions_published_pointer_pair" CHECK (
          ("current_published_revision_id" IS NULL AND "current_published_at" IS NULL)
          OR (
            "current_published_revision_id" IS NOT NULL
            AND typeof("current_published_at") = 'integer'
            AND "current_published_at" BETWEEN "created_at" AND 9007199254740991
          )
        ),
        CONSTRAINT "ck_questions_published_status_has_revision" CHECK (
          "status" <> 'published' OR "current_published_revision_id" IS NOT NULL
        ),
        CONSTRAINT "fk_questions_source" FOREIGN KEY ("source_id")
          REFERENCES "question_sources" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_questions_current_published_revision" FOREIGN KEY ("id", "current_published_revision_id")
          REFERENCES "question_revisions" ("question_id", "id") ON DELETE RESTRICT
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "question_revisions" (
        "id" TEXT NOT NULL,
        "question_id" TEXT NOT NULL,
        "revision_number" INTEGER NOT NULL,
        "question_text" TEXT NOT NULL,
        "locale" TEXT NOT NULL,
        "status" TEXT NOT NULL DEFAULT 'draft',
        "created_at" INTEGER NOT NULL,
        "authored_by_member_id" TEXT,
        "approved_at" INTEGER,
        "approved_by_actor_id" TEXT,
        CONSTRAINT "pk_question_revisions" PRIMARY KEY ("id"),
        CONSTRAINT "uq_question_revisions_question_number" UNIQUE ("question_id", "revision_number"),
        CONSTRAINT "uq_question_revisions_question_id" UNIQUE ("question_id", "id"),
        CONSTRAINT "ck_question_revisions_id_nonempty" CHECK (length(trim("id")) > 0),
        CONSTRAINT "ck_question_revisions_number" CHECK (
          typeof("revision_number") = 'integer'
          AND "revision_number" BETWEEN 1 AND 9007199254740991
        ),
        CONSTRAINT "ck_question_revisions_text_nonempty" CHECK (length(trim("question_text")) > 0),
        CONSTRAINT "ck_question_revisions_locale_nonempty" CHECK (length(trim("locale")) > 0),
        CONSTRAINT "ck_question_revisions_status" CHECK ("status" IN ('draft', 'pending_review', 'approved', 'rejected')),
        CONSTRAINT "ck_question_revisions_created_at" CHECK (
          typeof("created_at") = 'integer' AND "created_at" BETWEEN 0 AND 9007199254740991
        ),
        CONSTRAINT "ck_question_revisions_approval_pair" CHECK (
          ("status" = 'approved'
            AND typeof("approved_at") = 'integer'
            AND "approved_at" BETWEEN "created_at" AND 9007199254740991
            AND "approved_by_actor_id" IS NOT NULL
            AND length(trim("approved_by_actor_id")) > 0)
          OR ("status" <> 'approved' AND "approved_at" IS NULL AND "approved_by_actor_id" IS NULL)
        ),
        CONSTRAINT "fk_question_revisions_question" FOREIGN KEY ("question_id")
          REFERENCES "questions" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_question_revisions_author" FOREIGN KEY ("authored_by_member_id")
          REFERENCES "room_members" ("id") ON DELETE SET NULL
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "question_revision_answers" (
        "id" TEXT NOT NULL,
        "revision_id" TEXT NOT NULL,
        "answer_text" TEXT NOT NULL,
        "normalized_key" TEXT NOT NULL,
        "normalization_version" INTEGER NOT NULL,
        "answer_order" INTEGER NOT NULL,
        "points" INTEGER NOT NULL,
        CONSTRAINT "pk_question_revision_answers" PRIMARY KEY ("id"),
        CONSTRAINT "ck_question_revision_answers_id_nonempty" CHECK (length(trim("id")) > 0),
        CONSTRAINT "ck_question_revision_answers_text_nonempty" CHECK (length(trim("answer_text")) > 0),
        CONSTRAINT "ck_question_revision_answers_normalized_key" CHECK (length(trim("normalized_key")) > 0),
        CONSTRAINT "ck_question_revision_answers_normalization_version" CHECK (
          typeof("normalization_version") = 'integer'
          AND "normalization_version" BETWEEN 1 AND 9007199254740991
        ),
        CONSTRAINT "ck_question_revision_answers_order" CHECK (
          typeof("answer_order") = 'integer'
          AND "answer_order" BETWEEN 1 AND 9007199254740991
        ),
        CONSTRAINT "ck_question_revision_answers_points" CHECK (
          typeof("points") = 'integer'
          AND "points" >= 0
          AND "points" <= 9007199254740991
        ),
        CONSTRAINT "fk_question_revision_answers_revision" FOREIGN KEY ("revision_id")
          REFERENCES "question_revisions" ("id") ON DELETE RESTRICT
      )
    `);

    await queryRunner.query(`CREATE INDEX "ix_question_sources_type" ON "question_sources" ("source_type")`);
    await queryRunner.query(`CREATE INDEX "ix_question_sources_creator" ON "question_sources" ("created_by_member_id")`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "ux_question_sources_type_external_reference"
      ON "question_sources" ("source_type", "external_reference")
      WHERE "external_reference" IS NOT NULL
    `);
    await queryRunner.query(`CREATE INDEX "ix_questions_source_status" ON "questions" ("source_id", "status")`);
    await queryRunner.query(`CREATE INDEX "ix_question_revisions_question_status" ON "question_revisions" ("question_id", "status")`);
    await queryRunner.query(`CREATE INDEX "ix_question_revisions_author" ON "question_revisions" ("authored_by_member_id")`);
    await queryRunner.query(`CREATE UNIQUE INDEX "ux_question_revision_answers_order" ON "question_revision_answers" ("revision_id", "answer_order")`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "ux_question_revision_answers_normalized_key"
      ON "question_revision_answers" ("revision_id", "normalization_version", "normalized_key")
      WHERE "normalized_key" IS NOT NULL
    `);
    await queryRunner.query(`CREATE INDEX "ix_question_revision_answers_revision" ON "question_revision_answers" ("revision_id")`);

    await queryRunner.query(`
      CREATE TRIGGER "trg_question_revisions_no_direct_approved_insert"
      BEFORE INSERT ON "question_revisions"
      WHEN NEW."status" = 'approved'
      BEGIN
        SELECT RAISE(ABORT, 'create revisions before approving them');
      END
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_question_revisions_approved_answers_required"
      BEFORE UPDATE OF "status" ON "question_revisions"
      WHEN NEW."status" = 'approved' AND OLD."status" <> 'approved'
      BEGIN
        SELECT CASE
          WHEN NOT EXISTS (
            SELECT 1 FROM "question_revision_answers" WHERE "revision_id" = NEW."id"
          ) THEN RAISE(ABORT, 'approved revisions require at least one answer')
        END;
      END
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_question_revisions_approved_no_update"
      BEFORE UPDATE ON "question_revisions"
      WHEN OLD."status" = 'approved'
      BEGIN
        SELECT RAISE(ABORT, 'approved question revisions are immutable');
      END
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_question_revisions_approved_no_delete"
      BEFORE DELETE ON "question_revisions"
      WHEN OLD."status" = 'approved'
      BEGIN
        SELECT RAISE(ABORT, 'approved question revisions cannot be deleted');
      END
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_question_revision_answers_no_approved_insert"
      BEFORE INSERT ON "question_revision_answers"
      WHEN EXISTS (
        SELECT 1 FROM "question_revisions"
        WHERE "id" = NEW."revision_id" AND "status" = 'approved'
      )
      BEGIN
        SELECT RAISE(ABORT, 'answers of approved question revisions are immutable');
      END
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_question_revision_answers_no_approved_update"
      BEFORE UPDATE ON "question_revision_answers"
      WHEN EXISTS (
        SELECT 1 FROM "question_revisions"
        WHERE "id" IN (OLD."revision_id", NEW."revision_id") AND "status" = 'approved'
      )
      BEGIN
        SELECT RAISE(ABORT, 'answers of approved question revisions are immutable');
      END
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_question_revision_answers_no_approved_delete"
      BEFORE DELETE ON "question_revision_answers"
      WHEN EXISTS (
        SELECT 1 FROM "question_revisions"
        WHERE "id" = OLD."revision_id" AND "status" = 'approved'
      )
      BEGIN
        SELECT RAISE(ABORT, 'answers of approved question revisions cannot be deleted');
      END
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_question_answers_safe_total_insert"
      BEFORE INSERT ON "question_revision_answers"
      BEGIN
        SELECT CASE
          WHEN COALESCE((
            SELECT SUM("points") FROM "question_revision_answers" WHERE "revision_id" = NEW."revision_id"
          ), 0) > 9007199254740991 - NEW."points"
          THEN RAISE(ABORT, 'question revision points exceed Number.MAX_SAFE_INTEGER')
        END;
      END
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_question_answers_safe_total_update"
      BEFORE UPDATE OF "revision_id", "points" ON "question_revision_answers"
      BEGIN
        SELECT CASE
          WHEN COALESCE((
            SELECT SUM("points")
            FROM "question_revision_answers"
            WHERE "revision_id" = NEW."revision_id" AND "id" <> OLD."id"
          ), 0) > 9007199254740991 - NEW."points"
          THEN RAISE(ABORT, 'question revision points exceed Number.MAX_SAFE_INTEGER')
        END;
      END
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_questions_published_revision_is_approved_insert"
      BEFORE INSERT ON "questions"
      WHEN NEW."current_published_revision_id" IS NOT NULL
      BEGIN
        SELECT CASE
          WHEN NOT EXISTS (
            SELECT 1 FROM "question_revisions"
            WHERE "id" = NEW."current_published_revision_id"
              AND "question_id" = NEW."id"
              AND "status" = 'approved'
          ) THEN RAISE(ABORT, 'current published revision must be approved for this question')
        END;
      END
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_questions_published_revision_is_approved_update"
      BEFORE UPDATE OF "current_published_revision_id" ON "questions"
      WHEN NEW."current_published_revision_id" IS NOT NULL
      BEGIN
        SELECT CASE
          WHEN NOT EXISTS (
            SELECT 1 FROM "question_revisions"
            WHERE "id" = NEW."current_published_revision_id"
              AND "question_id" = NEW."id"
              AND "status" = 'approved'
          ) THEN RAISE(ABORT, 'current published revision must be approved for this question')
        END;
      END
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TRIGGER "trg_questions_published_revision_is_approved_update"`);
    await queryRunner.query(`DROP TRIGGER "trg_questions_published_revision_is_approved_insert"`);
    await queryRunner.query(`DROP TRIGGER "trg_question_answers_safe_total_update"`);
    await queryRunner.query(`DROP TRIGGER "trg_question_answers_safe_total_insert"`);
    await queryRunner.query(`DROP TRIGGER "trg_question_revision_answers_no_approved_delete"`);
    await queryRunner.query(`DROP TRIGGER "trg_question_revision_answers_no_approved_update"`);
    await queryRunner.query(`DROP TRIGGER "trg_question_revision_answers_no_approved_insert"`);
    await queryRunner.query(`DROP TRIGGER "trg_question_revisions_approved_no_delete"`);
    await queryRunner.query(`DROP TRIGGER "trg_question_revisions_approved_no_update"`);
    await queryRunner.query(`DROP TRIGGER "trg_question_revisions_approved_answers_required"`);
    await queryRunner.query(`DROP TRIGGER "trg_question_revisions_no_direct_approved_insert"`);
    await queryRunner.query(`
      UPDATE "questions"
      SET "status" = 'archived', "current_published_revision_id" = NULL, "current_published_at" = NULL
    `);
    await queryRunner.query(`DROP TABLE "question_revision_answers"`);
    await queryRunner.query(`DROP TABLE "question_revisions"`);
    await queryRunner.query(`DROP TABLE "questions"`);
    await queryRunner.query(`DROP TABLE "question_sources"`);
  }
}
