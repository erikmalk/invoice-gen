ALTER TABLE "messages" ADD COLUMN "external_message_id" text;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_external_message_id_unique" UNIQUE("external_message_id");