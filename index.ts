import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
});

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'POST required' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const openAiKey = Deno.env.get('OPENAI_API_KEY');
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'Sign in required.' }, 401);

  const caller = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
  const { data: { user }, error: authError } = await caller.auth.getUser();
  if (authError || !user) return json({ error: 'Sign in required.' }, 401);

  let body: { kind?: string; content?: string };
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON.' }, 400); }
  const kind = body.kind;
  const content = String(body.content || '').trim();
  if (!['comment', 'video'].includes(kind || '') || !content || content.length > 5000) {
    return json({ error: 'Provide a comment or video title/description up to 5,000 characters.' }, 400);
  }
  if (!openAiKey) return json({ error: 'AI moderation is not configured yet. Set the OPENAI_API_KEY secret in Supabase.' }, 503);

  const admin = createClient(supabaseUrl, serviceKey);
  const { data: profile, error: profileError } = await admin.from('profiles')
    .select('account_mode,moderation_strikes').eq('id', user.id).maybeSingle();
  if (profileError) return json({ error: 'Could not check account status.' }, 500);
  if (profile?.account_mode === 'watch_only') {
    return json({ allowed: false, watchOnly: true, message: 'Your account is in watch-only mode. You can still watch videos, but you cannot comment or upload.' });
  }

  // OpenAI moderation is server-side: the API key is never exposed to the browser.
  let flagged = false;
  let categories: Record<string, boolean> = {};
  let explanation = '';
  try {
    const response = await fetch('https://api.openai.com/v1/moderations', {
      method: 'POST',
      headers: { Authorization: `Bearer ${openAiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'omni-moderation-latest', input: content }),
    });
    if (!response.ok) return json({ error: 'AI moderation service failed. Please try again later.' }, 503);
    const result = await response.json();
    const item = result.results?.[0];
    flagged = item?.flagged === true;
    categories = item?.categories || {};
    explanation = Object.entries(categories).filter(([, value]) => value === true).map(([key]) => key).slice(0, 5).join(', ');
  } catch {
    return json({ error: 'AI moderation is temporarily unavailable. Please try again later.' }, 503);
  }

  if (!flagged) {
    await admin.from('moderation_events').insert({ user_id: user.id, content_kind: kind, action: 'allowed' });
    return json({ allowed: true, watchOnly: false });
  }

  const strikes = Number(profile?.moderation_strikes || 0) + 1;
  // A flagged result blocks this submission. Repeated flagged submissions trigger watch-only mode.
  const watchOnly = strikes >= 3;
  const reason = `AI moderation flagged this ${kind} (${explanation || 'community safety category'}).`;
  const { error: updateError } = await admin.from('profiles').update({
    moderation_strikes: strikes,
    account_mode: watchOnly ? 'watch_only' : 'active',
    moderation_reason: watchOnly ? 'Repeated content violations: ' + (explanation || 'content flagged by AI moderation') : reason,
    moderation_updated_at: new Date().toISOString(),
  }).eq('id', user.id);
  if (updateError) return json({ error: 'Could not save moderation result. Ask the site owner to check the migration.' }, 500);
  await admin.from('moderation_events').insert({
    user_id: user.id, content_kind: kind, category: explanation || 'flagged',
    explanation: reason, action: watchOnly ? 'watch_only' : 'blocked',
  });
  return json({
    allowed: false, watchOnly, strikes,
    reason: watchOnly ? 'Repeated AI moderation flags' : reason,
    message: watchOnly
      ? 'This submission was blocked and your account is now in watch-only mode after repeated AI moderation flags. You can still watch videos. If this was a mistake, submit an appeal.'
      : `This submission was blocked by AI moderation. Warning ${strikes} of 3. Reason: ${explanation || 'community safety rules'}. Edit the content or appeal if you think this is a mistake.`,
  });
});
