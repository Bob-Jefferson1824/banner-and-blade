/* Decides whether STAGING MODE may switch on. Pure function so it can be tested without Socket.IO.
   Staging mode needs ALL of:
   - BB_STAGING_SECRET of 24+ characters,
   - if the platform tells us the service name (Render sets RENDER_SERVICE_NAME), it must be banner-and-blade-staging[-suffix],
   - NO database connection string (staging must never hold database credentials).
   If the secret is set but any other rule fails, staging mode stays OFF and the reason is logged (no secret is ever logged). */
'use strict';
function stagingGate(env) {
  const secret = env.BB_STAGING_SECRET || '';
  if (!secret) return { enabled: false, reason: null };
  if (secret.length < 24) return { enabled: false, reason: 'BB_STAGING_SECRET is shorter than 24 characters' };
  const svc = env.RENDER_SERVICE_NAME || '';
  if (svc && !/^banner-and-blade-staging(-[a-z0-9]+)?$/.test(svc)) return { enabled: false, reason: 'this service is not named banner-and-blade-staging' };
  if (env.DATABASE_URL) return { enabled: false, reason: 'a database connection string is present; staging must have none' };
  return { enabled: true, reason: null };
}
module.exports = { stagingGate };
