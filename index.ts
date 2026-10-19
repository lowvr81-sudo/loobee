import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const ADMIN_EMAIL = "lowvr81@gmail.com";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...corsHeaders, "Content-Type": "application/json" },
});

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !anonKey || !serviceKey) return json({ error: "Missing Supabase function secrets." }, 500);

  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "Sign in is required." }, 401);

  const authClient = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${token}` } } });
  const { data: { user }, error: authError } = await authClient.auth.getUser(token);
  if (authError || !user) return json({ error: "Your session is invalid. Sign in again." }, 401);
  if ((user.email || "").toLowerCase() !== ADMIN_EMAIL) return json({ error: "Administrator access denied." }, 403);

  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON request." }, 400); }
  const action = body.action;

  if (action === "list-users") {
    const users: Array<{ id: string; email: string | null; username: string; is_verified: boolean }> = [];
    for (let page = 1; page <= 100; page++) {
      const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 100 });
      if (error) return json({ error: `Could not list accounts: ${error.message}` }, 500);
      const batch = data.users || [];
      if (!batch.length) break;
      const ids = batch.map((u) => u.id);
      const { data: profiles, error: profileError } = await admin.from("profiles").select("id,username,is_verified").in("id", ids);
      if (profileError) return json({ error: `Could not load profiles: ${profileError.message}. Run the Loobee admin SQL setup.` }, 500);
      const map = new Map((profiles || []).map((p) => [p.id, p]));
      for (const account of batch) {
        const profile = map.get(account.id);
        users.push({ id: account.id, email: account.email || null, username: profile?.username || account.user_metadata?.user_name || account.email?.split("@")[0] || "Loobee user", is_verified: profile?.is_verified === true });
      }
      if (batch.length < 100) break;
    }
    users.sort((a, b) => (a.email || "").localeCompare(b.email || ""));
    return json({ users });
  }

  if (action === "set-verified") {
    const userId = typeof body.userId === "string" ? body.userId : "";
    const isVerified = body.isVerified;
    if (!userId || typeof isVerified !== "boolean") return json({ error: "userId and isVerified are required." }, 400);
    const { data: target, error: targetError } = await admin.auth.admin.getUserById(userId);
    if (targetError || !target.user) return json({ error: "Account not found." }, 404);
    const { error } = await admin.from("profiles").upsert({ id: userId, username: target.user.user_metadata?.user_name || target.user.email?.split("@")[0] || "Loobee creator", is_verified: isVerified }, { onConflict: "id" });
    if (error) return json({ error: `Could not update verification: ${error.message}` }, 500);
    return json({ ok: true, userId, isVerified });
  }

  if (action === "delete-user") {
    const userId = typeof body.userId === "string" ? body.userId : "";
    if (!userId) return json({ error: "userId is required." }, 400);
    if (userId === user.id) return json({ error: "You cannot delete the currently signed-in administrator account from this panel." }, 400);
    const { data: target, error: targetError } = await admin.auth.admin.getUserById(userId);
    if (targetError || !target.user) return json({ error: "Account not found." }, 404);

    // Remove objects stored under this user's ID folder in the public media buckets.
    for (const bucket of ["videos", "thumbnails"]) {
      const { data: files, error: listError } = await admin.storage.from(bucket).list(userId, { limit: 1000 });
      if (listError && !/not found|does not exist/i.test(listError.message)) {
        return json({ error: `Could not inspect ${bucket} storage: ${listError.message}` }, 500);
      }
      if (files?.length) {
        const paths = files.filter((f) => f.name && !f.id?.startsWith("folder")).map((f) => `${userId}/${f.name}`);
        if (paths.length) {
          const { error: removeError } = await admin.storage.from(bucket).remove(paths);
          if (removeError) return json({ error: `Could not remove ${bucket} files: ${removeError.message}` }, 500);
        }
      }
    }

    // Remove rows that commonly reference the account. Ignore missing optional tables,
    // but stop on other database errors so we do not claim deletion succeeded.
    const { data: ownVideos, error: videosError } = await admin.from("videos").select("id").eq("user_id", userId);
    if (videosError && !/does not exist|could not find the table/i.test(videosError.message)) return json({ error: `Could not inspect videos: ${videosError.message}` }, 500);
    const videoIds = (ownVideos || []).map((v) => v.id);
    const cleanup = async (table: string, column: string, values: string[], many = false) => {
      if (!values.length) return null;
      const result = many
        ? await admin.from(table).delete().in(column, values)
        : await admin.from(table).delete().eq(column, values[0]);
      if (result.error && !/does not exist|could not find the table/i.test(result.error.message)) return `${table}: ${result.error.message}`;
      return null;
    };
    for (const [table, column, values, many] of [
      ["video_reactions", "video_id", videoIds, true],
      ["comments", "video_id", videoIds, true],
      ["comments", "user_id", [userId], false],
      ["video_reactions", "user_id", [userId], false],
      ["subscriptions", "subscriber_id", [userId], false],
      ["subscriptions", "channel_id", [userId], false],
      ["videos", "user_id", [userId], false],
      ["profiles", "id", [userId], false],
    ] as Array<[string, string, string[], boolean]>) {
      const issue = await cleanup(table, column, values, many);
      if (issue) return json({ error: `Account cleanup stopped (${issue}). Check table permissions/schema before retrying.` }, 500);
    }
    const { error: deleteError } = await admin.auth.admin.deleteUser(userId);
    if (deleteError) return json({ error: `Profile data was cleaned, but Auth account deletion failed: ${deleteError.message}` }, 500);
    return json({ ok: true, userId, deletedEmail: target.user.email || null });
  }

  return json({ error: "Unknown action." }, 400);
});
