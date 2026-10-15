import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

// Template: LocalInfra/templates/app/app/api/health/route.ts — see DEPLOYING-APPS.md.
// The Docker healthcheck polls this every 30s, and deploy.sh waits for it after every deploy, so
// it must fail when the app can't do its job: check every dependency the app needs, cheaply.
// Reuse the app's own clients (no new connection per call). Keep it unauthenticated.
export async function GET() {
  try {
    await Promise.all([
      db.execute(sql`SELECT 1`),
      // redis.ping(),                                              // if the app uses Redis
      // s3.send(new HeadBucketCommand({ Bucket: process.env.S3_BUCKET })), // if it uses S3
    ]);
    return NextResponse.json({ status: "ok" });
  } catch {
    return NextResponse.json({ status: "error" }, { status: 503 });
  }
}
