import { MigrationInterface, QueryRunner } from 'typeorm';

export class M001RoomDeviceSessionSchema1792022400000 implements MigrationInterface {
  name = 'M001RoomDeviceSessionSchema1792022400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "rooms" (
        "id" TEXT NOT NULL,
        "join_code_hash" TEXT NOT NULL,
        "status" TEXT NOT NULL DEFAULT 'open',
        "created_at" INTEGER NOT NULL,
        "empty_since_at" INTEGER,
        "cleanup_after" INTEGER,
        "deactivated_at" INTEGER,
        CONSTRAINT "pk_rooms" PRIMARY KEY ("id"),
        CONSTRAINT "ck_rooms_id_nonempty" CHECK (length(trim("id")) > 0),
        CONSTRAINT "ck_rooms_join_code_hash_nonempty" CHECK (length(trim("join_code_hash")) > 0),
        CONSTRAINT "ck_rooms_status" CHECK ("status" IN ('open', 'in_progress', 'disabled', 'expired')),
        CONSTRAINT "ck_rooms_created_at" CHECK (typeof("created_at") = 'integer' AND "created_at" >= 0),
        CONSTRAINT "ck_rooms_empty_since_at" CHECK ("empty_since_at" IS NULL OR (typeof("empty_since_at") = 'integer' AND "empty_since_at" >= "created_at")),
        CONSTRAINT "ck_rooms_cleanup_after" CHECK (
          ("empty_since_at" IS NULL AND "cleanup_after" IS NULL)
          OR (
            "empty_since_at" IS NOT NULL
            AND typeof("cleanup_after") = 'integer'
            AND "cleanup_after" = "empty_since_at" + 60000
          )
        ),
        CONSTRAINT "ck_rooms_deactivated_at" CHECK (
          ("status" IN ('open', 'in_progress') AND "deactivated_at" IS NULL)
          OR (
            "status" IN ('disabled', 'expired')
            AND typeof("deactivated_at") = 'integer'
            AND "deactivated_at" >= "created_at"
          )
        )
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "ux_rooms_join_code_hash" ON "rooms" ("join_code_hash")`);

    await queryRunner.query(`
      CREATE TABLE "devices" (
        "id" TEXT NOT NULL,
        "created_at" INTEGER NOT NULL,
        CONSTRAINT "pk_devices" PRIMARY KEY ("id"),
        CONSTRAINT "ck_devices_id_nonempty" CHECK (length(trim("id")) > 0),
        CONSTRAINT "ck_devices_created_at" CHECK (typeof("created_at") = 'integer' AND "created_at" >= 0)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "room_members" (
        "id" TEXT NOT NULL,
        "room_id" TEXT NOT NULL,
        "device_id" TEXT NOT NULL,
        "device_role" TEXT NOT NULL,
        "team" TEXT,
        "status" TEXT NOT NULL DEFAULT 'active',
        "is_owner" INTEGER NOT NULL DEFAULT 0,
        "is_current_host" INTEGER NOT NULL DEFAULT 0,
        "created_at" INTEGER NOT NULL,
        "ended_at" INTEGER,
        CONSTRAINT "pk_room_members" PRIMARY KEY ("id"),
        CONSTRAINT "ck_room_members_id_nonempty" CHECK (length(trim("id")) > 0),
        CONSTRAINT "ck_room_members_device_role" CHECK ("device_role" IN ('host_ui', 'team_ui', 'display_ui')),
        CONSTRAINT "ck_room_members_team" CHECK ("team" IS NULL OR "team" IN ('team_one', 'team_two')),
        CONSTRAINT "ck_room_members_role_team" CHECK (
          ("device_role" = 'team_ui' AND "team" IS NOT NULL)
          OR ("device_role" IN ('host_ui', 'display_ui') AND "team" IS NULL)
        ),
        CONSTRAINT "ck_room_members_status" CHECK ("status" IN ('active', 'left', 'revoked')),
        CONSTRAINT "ck_room_members_is_owner" CHECK (typeof("is_owner") = 'integer' AND "is_owner" IN (0, 1)),
        CONSTRAINT "ck_room_members_is_current_host" CHECK (typeof("is_current_host") = 'integer' AND "is_current_host" IN (0, 1)),
        CONSTRAINT "ck_room_members_current_host_active" CHECK ("is_current_host" = 0 OR "status" = 'active'),
        CONSTRAINT "ck_room_members_created_at" CHECK (typeof("created_at") = 'integer' AND "created_at" >= 0),
        CONSTRAINT "ck_room_members_ended_at" CHECK (
          ("status" = 'active' AND "ended_at" IS NULL)
          OR (
            "status" IN ('left', 'revoked')
            AND typeof("ended_at") = 'integer'
            AND "ended_at" >= "created_at"
          )
        ),
        CONSTRAINT "fk_room_members_room" FOREIGN KEY ("room_id") REFERENCES "rooms" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_room_members_device" FOREIGN KEY ("device_id") REFERENCES "devices" ("id") ON DELETE RESTRICT
      )
    `);

    await queryRunner.query(`CREATE UNIQUE INDEX "ux_room_members_room_device" ON "room_members" ("room_id", "device_id")`);
    await queryRunner.query(`CREATE UNIQUE INDEX "ux_room_members_id_device" ON "room_members" ("id", "device_id")`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "ux_room_members_one_owner_per_room"
      ON "room_members" ("room_id")
      WHERE "is_owner" = 1
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "ux_room_members_one_current_host_per_room"
      ON "room_members" ("room_id")
      WHERE "is_current_host" = 1
    `);
    await queryRunner.query(`CREATE INDEX "ix_room_members_device_id" ON "room_members" ("device_id")`);
    await queryRunner.query(`CREATE INDEX "ix_room_members_room_status" ON "room_members" ("room_id", "status")`);

    await queryRunner.query(`
      CREATE TABLE "device_sessions" (
        "id" TEXT NOT NULL,
        "device_id" TEXT NOT NULL,
        "room_member_id" TEXT NOT NULL,
        "token_hash" TEXT NOT NULL,
        "created_at" INTEGER NOT NULL,
        "last_seen_at" INTEGER NOT NULL,
        "expires_at" INTEGER NOT NULL,
        "revoked_at" INTEGER,
        CONSTRAINT "pk_device_sessions" PRIMARY KEY ("id"),
        CONSTRAINT "ck_device_sessions_id_nonempty" CHECK (length(trim("id")) > 0),
        CONSTRAINT "ck_device_sessions_token_hash_nonempty" CHECK (length(trim("token_hash")) > 0),
        CONSTRAINT "ck_device_sessions_created_at" CHECK (typeof("created_at") = 'integer' AND "created_at" >= 0),
        CONSTRAINT "ck_device_sessions_last_seen_at" CHECK (typeof("last_seen_at") = 'integer' AND "last_seen_at" >= "created_at"),
        CONSTRAINT "ck_device_sessions_expires_at" CHECK (typeof("expires_at") = 'integer' AND "expires_at" > "created_at"),
        CONSTRAINT "ck_device_sessions_revoked_at" CHECK (
          "revoked_at" IS NULL
          OR (typeof("revoked_at") = 'integer' AND "revoked_at" >= "created_at")
        ),
        CONSTRAINT "fk_device_sessions_device" FOREIGN KEY ("device_id") REFERENCES "devices" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_device_sessions_member_device" FOREIGN KEY ("room_member_id", "device_id")
          REFERENCES "room_members" ("id", "device_id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "ux_device_sessions_token_hash" ON "device_sessions" ("token_hash")`);
    await queryRunner.query(`CREATE INDEX "ix_device_sessions_device_id" ON "device_sessions" ("device_id")`);
    await queryRunner.query(`CREATE INDEX "ix_device_sessions_member_id" ON "device_sessions" ("room_member_id")`);
    await queryRunner.query(`CREATE INDEX "ix_device_sessions_expires_at" ON "device_sessions" ("expires_at")`);
    await queryRunner.query(`CREATE INDEX "ix_rooms_status_cleanup_after" ON "rooms" ("status", "cleanup_after")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "device_sessions"`);
    await queryRunner.query(`DROP TABLE "room_members"`);
    await queryRunner.query(`DROP TABLE "devices"`);
    await queryRunner.query(`DROP TABLE "rooms"`);
  }
}
