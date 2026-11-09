CREATE TYPE "public"."deal_status" AS ENUM('DRAFT', 'AUTHORIZED', 'IN_PROGRESS', 'COMPLETED', 'VOIDED');--> statement-breakpoint
CREATE TYPE "public"."firewall_decision" AS ENUM('APPROVED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."ledger_kind" AS ENUM('ORDER_CREATE', 'ORDER_AUTHORIZE', 'CAPTURE', 'PAYOUT', 'VOID');--> statement-breakpoint
CREATE TYPE "public"."timeline_step" AS ENUM('UPLOAD_DETECTED', 'MULTIMODAL_ANALYSIS', 'FIREWALL_EVALUATION', 'CAPTURE', 'PAYOUT', 'REFUSED', 'VOIDED', 'DEAL_CLOSED');--> statement-breakpoint
CREATE TYPE "public"."tranche_status" AS ENUM('PENDING', 'AUDITING', 'APPROVED', 'CAPTURED', 'PAID_OUT', 'REFUSED', 'VOIDED');--> statement-breakpoint
CREATE TYPE "public"."tranche_type" AS ENUM('PUBLISH_VERIFIED', 'VIEW_MILESTONE', 'RETENTION_ACTIVE');--> statement-breakpoint
CREATE TABLE "deals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"brand_paypal_id" text,
	"creator_paypal_id" text NOT NULL,
	"youtube_channel_id" text NOT NULL,
	"currency" varchar(3) DEFAULT 'USD' NOT NULL,
	"total_budget" numeric(12, 2) NOT NULL,
	"authorized_order_id" varchar(64),
	"status" "deal_status" DEFAULT 'DRAFT' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"brand_name" text NOT NULL,
	"product_name" text NOT NULL,
	"terms_text" text NOT NULL,
	"contract_json" jsonb NOT NULL,
	"contract_hash" varchar(64) NOT NULL,
	"authorization_id" varchar(64),
	"authorized_amount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"captured_total" numeric(12, 2) DEFAULT '0' NOT NULL,
	"authorized_at" timestamp with time zone,
	"authorization_expires_at" timestamp with time zone,
	"bound_video_id" text,
	"verify_lock_until" timestamp with time zone,
	"last_checked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "evidence_audits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tranche_id" uuid NOT NULL,
	"video_id" text NOT NULL,
	"brand_segment_start_sec" integer,
	"brand_segment_end_sec" integer,
	"brand_segment_duration_sec" integer DEFAULT 0 NOT NULL,
	"has_ad_disclosure" boolean NOT NULL,
	"channel_id_matches" boolean NOT NULL,
	"confidence_score" numeric(4, 3) NOT NULL,
	"raw_verdict_json" jsonb,
	"sha256_evidence_hash" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deal_id" uuid NOT NULL,
	"source" text NOT NULL,
	"model" text NOT NULL,
	"keyword_found" boolean NOT NULL,
	"is_public" boolean NOT NULL,
	"view_count" integer NOT NULL,
	"video_title" text NOT NULL,
	"video_published_at" timestamp with time zone NOT NULL,
	"disclosure_source" text NOT NULL,
	"citations" jsonb NOT NULL,
	"snapshot" jsonb NOT NULL,
	"verdict_cache_key" varchar(64),
	"state_hash" varchar(64) NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "firewall_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tranche_id" uuid NOT NULL,
	"intent_hash" varchar(64) NOT NULL,
	"decision" "firewall_decision" NOT NULL,
	"refusal_reasons" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"evaluated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deal_id" uuid NOT NULL,
	"audit_id" uuid,
	"idempotency_key" varchar(64) NOT NULL,
	"intent_json" jsonb NOT NULL,
	"rule_results" jsonb NOT NULL,
	"policy_version" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paypal_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deal_id" uuid NOT NULL,
	"tranche_id" uuid,
	"kind" "ledger_kind" NOT NULL,
	"paypal_request_id" varchar(128) NOT NULL,
	"paypal_id" varchar(64),
	"paypal_debug_id" varchar(64),
	"status" text NOT NULL,
	"amount" numeric(12, 2),
	"request_json" jsonb,
	"response_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "timeline_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deal_id" uuid NOT NULL,
	"tranche_id" uuid,
	"run_id" uuid NOT NULL,
	"step" timeline_step NOT NULL,
	"ok" boolean NOT NULL,
	"message" text NOT NULL,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tranches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deal_id" uuid NOT NULL,
	"tranche_index" integer NOT NULL,
	"type" "tranche_type" NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"status" "tranche_status" DEFAULT 'PENDING' NOT NULL,
	"conditions_json" jsonb NOT NULL,
	"payout_batch_id" varchar(64),
	"captured_at" timestamp with time zone,
	"label" text NOT NULL,
	"deadline_at" timestamp with time zone,
	"capture_id" varchar(64),
	"capture_attempt" integer DEFAULT 0 NOT NULL,
	"bound_video_id" text,
	"paid_out_at" timestamp with time zone,
	"payout_status" text,
	"last_error" text,
	"progress_note" text,
	"last_audit_id" uuid,
	"approved_decision_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "evidence_audits" ADD CONSTRAINT "evidence_audits_tranche_id_tranches_id_fk" FOREIGN KEY ("tranche_id") REFERENCES "public"."tranches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_audits" ADD CONSTRAINT "evidence_audits_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "firewall_decisions" ADD CONSTRAINT "firewall_decisions_tranche_id_tranches_id_fk" FOREIGN KEY ("tranche_id") REFERENCES "public"."tranches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "firewall_decisions" ADD CONSTRAINT "firewall_decisions_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "firewall_decisions" ADD CONSTRAINT "firewall_decisions_audit_id_evidence_audits_id_fk" FOREIGN KEY ("audit_id") REFERENCES "public"."evidence_audits"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paypal_ledger" ADD CONSTRAINT "paypal_ledger_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paypal_ledger" ADD CONSTRAINT "paypal_ledger_tranche_id_tranches_id_fk" FOREIGN KEY ("tranche_id") REFERENCES "public"."tranches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timeline_events" ADD CONSTRAINT "timeline_events_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timeline_events" ADD CONSTRAINT "timeline_events_tranche_id_tranches_id_fk" FOREIGN KEY ("tranche_id") REFERENCES "public"."tranches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tranches" ADD CONSTRAINT "tranches_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "deals_authorized_order_id_uq" ON "deals" USING btree ("authorized_order_id");--> statement-breakpoint
CREATE INDEX "deals_status_idx" ON "deals" USING btree ("status");--> statement-breakpoint
CREATE INDEX "audits_tranche_idx" ON "evidence_audits" USING btree ("tranche_id","created_at");--> statement-breakpoint
CREATE INDEX "audits_cache_idx" ON "evidence_audits" USING btree ("verdict_cache_key");--> statement-breakpoint
CREATE INDEX "firewall_tranche_idx" ON "firewall_decisions" USING btree ("tranche_id","evaluated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "firewall_approved_key_uq" ON "firewall_decisions" USING btree ("idempotency_key") WHERE decision = 'APPROVED';--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_request_id_uq" ON "paypal_ledger" USING btree ("paypal_request_id");--> statement-breakpoint
CREATE INDEX "ledger_deal_idx" ON "paypal_ledger" USING btree ("deal_id","created_at");--> statement-breakpoint
CREATE INDEX "timeline_deal_idx" ON "timeline_events" USING btree ("deal_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tranches_deal_index_uq" ON "tranches" USING btree ("deal_id","tranche_index");--> statement-breakpoint
CREATE INDEX "tranches_status_idx" ON "tranches" USING btree ("status");--> statement-breakpoint
CREATE INDEX "tranches_bound_video_idx" ON "tranches" USING btree ("bound_video_id");