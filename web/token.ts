import type { IncomingMessage, ServerResponse } from 'node:http';
import { AccessToken, AgentDispatchClient, RoomServiceClient } from 'livekit-server-sdk';

const DEFAULT_AGENT_NAME = 'avatar-agent';
const AGENT_KIND = 4; // ParticipantInfo.Kind.AGENT
const DISPATCH_GRACE_MS = 15_000;
const recentDispatches = new Map<string, number>();

export interface TokenEnv {
  LIVEKIT_URL?: string;
  LIVEKIT_API_KEY?: string;
  LIVEKIT_API_SECRET?: string;
  /** When set, callers must pass ?key=<ACCESS_KEY>. */
  ACCESS_KEY?: string;
  /** Which named agent to dispatch; local development uses its own. */
  AVATAR_AGENT_NAME?: string;
}

/** GET /api/token?room=&identity=&key= → { url, token }. Used by the Vite dev server and server.ts. */
export async function handleToken(env: TokenEnv, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET, ACCESS_KEY } = env;
  if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
    res.statusCode = 500;
    res.end('LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET not configured');
    return;
  }
  const params = new URL(req.url ?? '', 'http://localhost').searchParams;
  if (ACCESS_KEY && params.get('key') !== ACCESS_KEY) {
    res.statusCode = 403;
    res.end('Missing or wrong access key: open the link you were sent, including ?key=…');
    return;
  }
  const room = (params.get('room') || 'demo').slice(0, 64);
  const identity = (params.get('identity') || `guest-${Math.random().toString(36).slice(2, 6)}`).slice(0, 64);

  const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, { identity, name: identity, ttl: '1h' });
  at.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true, canPublishData: true });
  try {
    await ensureAgent(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET, room, env.AVATAR_AGENT_NAME || DEFAULT_AGENT_NAME);
  } catch (err) {
    console.warn('agent dispatch failed', err);
  }

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify({ url: LIVEKIT_URL, token: await at.toJwt() }));
}

/**
 * Dispatches the named agent unless it is already in the room. Token-based dispatch only fires
 * when a token creates the room, which misses rooms that outlive the agent (e.g. after a reload).
 */
async function ensureAgent(url: string, key: string, secret: string, room: string, agentName: string): Promise<void> {
  const host = url.replace(/^ws/, 'http');
  const participants = await new RoomServiceClient(host, key, secret).listParticipants(room).catch(() => []);
  if (participants.some((p) => p.kind === AGENT_KIND)) return;
  // The agent takes a moment to join; don't send a second one meanwhile.
  if (Date.now() - (recentDispatches.get(room) ?? 0) < DISPATCH_GRACE_MS) return;
  recentDispatches.set(room, Date.now());
  await new AgentDispatchClient(host, key, secret).createDispatch(room, agentName);
}
