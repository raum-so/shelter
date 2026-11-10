// Shelter's router for the pinned Supabase Edge Runtime. Function source lives
// in a separate, read-only mount; only the Shelter worker writes that persistent directory.
const encoder = new TextEncoder();
const secret = Deno.env.get('JWT_SECRET');
if (!secret) throw new Error('Function authentication is not configured');
const key = await crypto.subtle.importKey('raw', encoder.encode(secret), {name:'HMAC', hash:'SHA-256'}, false, ['verify']);
const cors = {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, apikey, content-type, x-client-info','Access-Control-Allow-Methods':'GET, POST, PUT, PATCH, DELETE, OPTIONS'};
const json = (status: number, error: string) => Response.json({error}, {status, headers:cors});
function decode(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid token');
  return Uint8Array.from(atob(value.replaceAll('-','+').replaceAll('_','/').padEnd(Math.ceil(value.length/4)*4,'=')), c=>c.charCodeAt(0));
}
async function authenticated(request: Request) {
  const token = request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_.-]{1,8192})$/i)?.[1];
  if (!token) return false;
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const header = JSON.parse(new TextDecoder().decode(decode(parts[0])));
    if (header.alg !== 'HS256') return false;
    if (!await crypto.subtle.verify('HMAC', key, decode(parts[2]), encoder.encode(`${parts[0]}.${parts[1]}`))) return false;
    const claims = JSON.parse(new TextDecoder().decode(decode(parts[1])));
    const now = Date.now()/1000;
    return typeof claims.exp === 'number' && Number.isFinite(claims.exp) && claims.exp > now && (claims.nbf === undefined || (typeof claims.nbf === 'number' && claims.nbf <= now));
  } catch { return false; }
}
Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response(null, {status:204, headers:cors});
  if (!await authenticated(request)) return json(401, 'A valid Supabase token is required');
  const name = new URL(request.url).pathname.split('/')[1];
  if (name === '__shelter_validate') {
    if (new URL(request.url).hostname !== 'functions') return json(404, 'Function not found');
    const token = request.headers.get('authorization')!.slice(7);
    const claims = JSON.parse(new TextDecoder().decode(decode(token.split('.')[1])));
    const candidate = request.headers.get('x-shelter-validation');
    if (request.method !== 'POST' || claims.role !== 'service_role' || !candidate || !/^sbj_[a-f0-9]{32}$/.test(candidate)) return json(403, 'Forbidden');
    try {
      await EdgeRuntime.userWorkers.create({servicePath:`/home/deno/functions/.shelter-candidates/${candidate}`,memoryLimitMb:150,workerTimeoutMs:15000,noModuleCache:true,envVars:Object.entries(Deno.env.toObject()).filter(([name])=>name.startsWith('SUPABASE_'))});
      return new Response(null,{status:204});
    } catch { return json(422, 'Function could not be loaded'); }
  }
  if (!name || !/^[a-z][a-z0-9_-]{0,62}$/.test(name) || name === 'main') return json(404, 'Function not found');
  const servicePath = `/home/deno/functions/${name}`;
  try {
    if (!(await Deno.stat(`${servicePath}/index.ts`)).isFile) return json(404, 'Function not found');
  } catch { return json(404, 'Function not found'); }
  try {
    const envVars = Object.entries(Deno.env.toObject()).filter(([name])=>name.startsWith('SUPABASE_'));
    const worker = await EdgeRuntime.userWorkers.create({servicePath, memoryLimitMb:150, workerTimeoutMs:30000, noModuleCache:true, envVars});
    const response = await worker.fetch(request);
    const headers = new Headers(response.headers);
    for (const [name,value] of Object.entries(cors)) if (!headers.has(name)) headers.set(name,value);
    return new Response(response.body, {status:response.status, headers});
  } catch { return json(503, 'Function could not complete the request'); }
});
