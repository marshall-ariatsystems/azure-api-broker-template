import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import { discover, verifyAccessToken, verifyIdToken } from './oidc-validation.mjs';
import { setAccessToken } from './session.mjs';
const random = () => randomBytes(32).toString('base64url');
export const pkceChallenge = (verifier) => createHash('sha256').update(verifier).digest('base64url');
export async function login(config, { fetcher = fetch, present = () => {}, now = () => Date.now() } = {}) {
  const metadata = await discover(config.issuer, fetcher); const state=random(), nonce=random(), verifier=random();
  const server = http.createServer();
  try { await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);}); const port=server.address().port; const redirectUri=`http://127.0.0.1:${port}/callback`;
    const url=new URL(metadata.authorization_endpoint); url.search=new URLSearchParams({response_type:'code',client_id:config.clientId,redirect_uri:redirectUri,scope:config.scopes || 'openid',state,nonce,code_challenge:pkceChallenge(verifier),code_challenge_method:'S256'}); await present(url.toString());
    const callback=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('OIDC callback timed out')),120000); server.on('request',(req,res)=>{const u=new URL(req.url,redirectUri); if(u.searchParams.get('state')!==state||!u.searchParams.get('code')) {res.writeHead(400);res.end(); reject(new Error('OIDC state mismatch'));return;} res.end('Sign-in complete. You may return to the application.');clearTimeout(timer);resolve(u.searchParams.get('code'));});});
    const response=await fetcher(metadata.token_endpoint,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:config.clientId,redirect_uri:redirectUri,code:callback,code_verifier:verifier})}); if(!response.ok) throw new Error('OIDC token exchange failed'); const tokens=await response.json(); if(!tokens.id_token||!tokens.access_token) throw new Error('OIDC response requires ID and access tokens'); const trust={issuer:config.issuer,audience:config.clientId,jwksUri:metadata.jwks_uri,fetcher}; await verifyIdToken(tokens.id_token,trust,nonce,now()); const access=await verifyAccessToken(tokens.access_token,{...trust,audience:config.audience},now()); setAccessToken(tokens.access_token,access.exp*1000); return { expiresAt: access.exp*1000 };
  } finally { await new Promise((resolve)=>server.close(resolve)); }
}
