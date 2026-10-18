import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return new Response(JSON.stringify({ error: "Sign in required" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const { data: { user }, error: userError } = await admin.auth.getUser(token);
  if (userError || !user) return new Response(JSON.stringify({ error: "Invalid session" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  let body: { confirmation?: string } = {};
  try { body = await req.json(); } catch { /* empty body handled below */ }
  if (body.confirmation !== "DELETE") return new Response(JSON.stringify({ error: "Confirmation required" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  // Remove related rows explicitly; the service-role key is used only server-side.
  const { data: ownedVideos } = await admin.from("videos").select("id,video_url,thumbnail_url").eq("user_id", user.id);
  for (const v of ownedVideos || []) {
    for (const [bucket, publicUrl] of [["videos", v.video_url], ["thumbnails", v.thumbnail_url]] as const) {
      if (!publicUrl) continue;
      const marker = `/object/public/${bucket}/`;
      const i = publicUrl.indexOf(marker);
      if (i >= 0) {
        const objectPath = decodeURIComponent(publicUrl.slice(i + marker.length).split("?")[0]);
        await admin.storage.from(bucket).remove([objectPath]);
      }
    }
  }
  const tasks = [
    admin.from("comments").delete().eq("user_id", user.id),
    admin.from("reactions").delete().eq("user_id", user.id),
    admin.from("subscriptions").delete().eq("subscriber_id", user.id),
    admin.from("subscriptions").delete().eq("channel_id", user.id),
    admin.from("video_reports").delete().eq("reporter_id", user.id),
    admin.from("account_warnings").delete().eq("user_id", user.id),
    admin.from("video_hypes").delete().eq("user_id", user.id),
    admin.from("videos").delete().eq("user_id", user.id),
    admin.from("profiles").delete().eq("id", user.id),
  ];
  const results = await Promise.all(tasks);
  const failed = results.find((r) => r.error && !String(r.error.message).includes("does not exist"));
  if (failed?.error) return new Response(JSON.stringify({ error: `Could not remove account data: ${failed.error.message}` }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  const { error: deleteError } = await admin.auth.admin.deleteUser(user.id);
  if (deleteError) return new Response(JSON.stringify({ error: `Data cleanup started but Auth deletion failed: ${deleteError.message}` }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  return new Response(JSON.stringify({ success: true }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
});
