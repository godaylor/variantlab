// D1/R2 transport adapter. Rust owns batch validation and every job transition.
import { domain } from './domain.mjs';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
const hash = value => bytesToHex(sha256(typeof value === 'string' ? new TextEncoder().encode(value) : value));
const sql = (db, query, ...args) => db.prepare(query).bind(...args);
const row = (db, query, ...args) => sql(db, query, ...args).first();
const all = async (db, query, ...args) => (await sql(db, query, ...args).all()).results;
const json = (data, status = 200) => Response.json(data, {status, headers: {'cache-control':'private, no-store'}});
const fail = (code, status = 409) => { throw Object.assign(new Error(code), {status}); };
const now = () => new Date().toISOString();
const transition = (job, event) => JSON.parse(domain.renderApplyEvent(JSON.stringify(job), JSON.stringify(event), now()));
const view = r => { const j = JSON.parse(r.job); return {id:r.id, cell_id:j.spec.cell_id, state:j.state, phase:j.phase, progress_milli:j.progress_milli, attempt:j.attempt.attempt, failure:j.attempt.failure, artifact_ready:j.state === 'succeeded' && Boolean(r.artifact), updated_at:j.updated_at}; };
const LEASE = 45000, PART = 8 * 1024 * 1024, MAX = 1024 * 1024 * 1024;
async function discardAttempt(bucket, r) {
  if (!r.uploadKey || r.artifact) return;
  if (r.uploadId) { try { await bucket.resumeMultipartUpload(r.uploadKey,r.uploadId).abort(); } catch { /* It may already have completed; delete its private object below. */ } }
  await bucket.delete(r.uploadKey);
}
export async function renderAvailable(env) {
  if (!env.RENDER_WORKER_SECRET) return false;
  return Boolean(await row(env.DB, 'SELECT id FROM vl_render_workers WHERE expires>? LIMIT 1', Date.now()));
}
async function update(db, current, job, extras = {}) {
  const reset = job.attempt.attempt !== JSON.parse(current.job).attempt.attempt;
  const result = await sql(db, `UPDATE vl_render_jobs SET job=?,state=?,generation=generation+1,lease=?,token=?,uploadId=?,uploadKey=?,parts=?,sha=?,bytes=? WHERE owner=? AND id=? AND generation=?`,
    JSON.stringify(job), job.state, extras.lease ?? current.lease, extras.token ?? current.token,
    reset ? null : current.uploadId, reset ? null : current.uploadKey, reset ? null : current.parts, reset ? null : current.sha, reset ? null : current.bytes,
    current.owner, current.id, current.generation).run();
  if (result.meta.changes !== 1) fail('job_changed_retry');
}
export async function renderUser(request, env, owner, path, readJson) {
  const db = env.DB;
  if (path[0] === 'batches' && path.length === 1) {
    if (request.method === 'GET') return json({batches:await all(db, 'SELECT id,campaign,revision FROM vl_render_batches WHERE owner=? ORDER BY created DESC LIMIT 50', owner).then(items=>items.map(x=>({id:x.id,campaign_id:x.campaign,revision:x.revision})))});
    if (request.method !== 'POST') fail('method_not_allowed',405);
    if (!await renderAvailable(env)) fail('server_renderer_unavailable',503);
    const input = await readJson(request);
    let required, batch;
    const id = crypto.randomUUID();
    try {
      domain.campaignOriginalHashes(JSON.stringify(input.snapshot));
      required = JSON.parse(domain.renderValidateConnectedRequest(JSON.stringify(input)));
      batch = JSON.parse(domain.renderCreateConnectedBatch(owner,id,JSON.stringify(input.jobs.map(x=>x.spec)),now()));
    } catch (error) {
      const code = String(error);
      const safe = ['unknown_snapshot_fields','unsupported_snapshot_version','invalid_render_request','invalid_snapshot','snapshot_mismatch','manifest_mismatch','invalid_manifest','render_preflight_blocked','manifest_snapshot_mismatch','source_asset_missing'].includes(code) ? code : 'render_preflight_blocked';
      console.warn('render_validation',safe);
      fail(safe,400);
    }
    const revision = await row(db,'SELECT sha FROM vl_revisions WHERE owner=? AND campaign=? AND revision=?',owner,input.campaign_id,input.campaign_revision);
    if (revision?.sha !== input.snapshot_sha256) fail('sync_revision_first');
    for (const asset of required) if (!await row(db,'SELECT hash FROM vl_assets WHERE owner=? AND campaign=? AND hash=?',owner,input.campaign_id,asset)) fail('manifest_assets_missing');
    const requestHash = hash(JSON.stringify(input));
    const existing = await row(db,'SELECT id FROM vl_render_batches WHERE owner=? AND requestHash=?',owner,requestHash);
    if (existing) return json({batch_id:existing.id});
    const priorJobs = new Map();
    for (const j of batch.jobs) {
      const prior = await row(db,'SELECT * FROM vl_render_jobs WHERE owner=? AND idempotency=?',owner,j.spec.idempotency_key);
      if (prior) {
        // An idempotency key cannot be rebound to a different immutable request.
        const spec = JSON.parse(prior.job).spec;
        if (Object.keys(j.spec).some(key => j.spec[key] !== spec[key])) fail('idempotency_payload_mismatch');
        priorJobs.set(j.spec.idempotency_key,prior);
      }
    }
    const guard = crypto.randomUUID();
    const writes = [sql(db,"INSERT INTO vl_guards(id,valid) VALUES(?,CASE WHEN (SELECT COUNT(*) FROM vl_render_jobs WHERE owner=? AND state NOT IN ('succeeded','failed','cancelled')) + ? <= 100 AND (SELECT COUNT(*) FROM vl_render_batches WHERE owner=?) < 200 THEN 1 ELSE 0 END)",guard,owner,batch.jobs.length-priorJobs.size,owner),
      sql(db,'INSERT INTO vl_render_batches(owner,id,campaign,revision,requestHash,created) VALUES(?,?,?,?,?,?)',owner,id,input.campaign_id,input.campaign_revision,requestHash,Date.now())];
    for (const j of batch.jobs) {
      const manifest = input.jobs.find(x=>x.spec.cell_id === j.spec.cell_id).render_manifest;
      const prior=priorJobs.get(j.spec.idempotency_key);const jobId=prior?.id ?? crypto.randomUUID();
      if(!prior) writes.push(sql(db,'INSERT INTO vl_render_jobs(owner,id,batch,campaign,idempotency,job,manifest,state,generation,lease,token) VALUES(?,?,?,?,?,?,?,?,0,0,?)',owner,jobId,id,input.campaign_id,j.spec.idempotency_key,JSON.stringify(j),JSON.stringify(manifest),j.state,''));
      writes.push(sql(db,'INSERT INTO vl_render_batch_jobs(owner,batch,job) VALUES(?,?,?)',owner,id,jobId));
    }
    writes.push(sql(db,'DELETE FROM vl_guards WHERE id=?',guard));
    try { await db.batch(writes); } catch (error) {
      const duplicate = await row(db,'SELECT id FROM vl_render_batches WHERE owner=? AND requestHash=?',owner,requestHash);
      if (duplicate) return json({batch_id:duplicate.id});
      if (String(error).includes('atomic_precondition')) fail('render_queue_quota',429);
      if (String(error).includes('UNIQUE constraint')) fail('concurrent_batch_retry');
      throw error;
    }
    return json({batch_id:id});
  }
  if (path[0] === 'batches' && path.length === 3) {
    if (!await row(db,'SELECT id FROM vl_render_batches WHERE owner=? AND id=?',owner,path[1])) fail('batch_missing',404);
    const jobs = await all(db,'SELECT j.* FROM vl_render_jobs j JOIN vl_render_batch_jobs b ON b.owner=j.owner AND b.job=j.id WHERE b.owner=? AND b.batch=? ORDER BY j.id',owner,path[1]);
    if (request.method === 'GET' && path[2] === 'jobs') return json({jobs:jobs.map(view)});
    if (request.method === 'GET' && path[2] === 'events') return new Response(`event: jobs\ndata: ${JSON.stringify({jobs:jobs.map(view)})}\n\n`,{headers:{'content-type':'text/event-stream','cache-control':'no-store'}});
    if (request.method === 'POST' && path[2] === 'retry-failed') {
      for (const j of jobs) if (j.state === 'failed') { await discardAttempt(env.BUCKET,j); await update(db,j,transition(JSON.parse(j.job),{event:'retry'}),{lease:0,token:''}); }
      return json({retried:true});
    }
  }
  if (path[0] === 'jobs' && path.length === 3) {
    const current = await row(db,'SELECT * FROM vl_render_jobs WHERE owner=? AND id=?',owner,path[1]);
    if (!current) fail('job_missing',404);
    if (path[2] === 'artifact' && request.method === 'GET') {
      if (current.state !== 'succeeded' || !current.artifact) fail('artifact_not_ready');
      const token = crypto.randomUUID()+crypto.randomUUID();
      await sql(db,'INSERT INTO vl_downloads(token,owner,objectKey,mime,expires) VALUES(?,?,?,?,?)',hash(token),owner,current.artifact,'video/webm',Date.now()+300000).run();
      return json({url:`${new URL(request.url).origin}/api/variantlab/download/${token}`,sha256:current.sha,byte_length:current.bytes});
    }
    if (request.method === 'POST' && ['cancel','retry'].includes(path[2])) {
      let j = transition(JSON.parse(current.job),{event:path[2]});
      if (path[2] === 'retry') await discardAttempt(env.BUCKET,current);
      if (path[2] === 'cancel' && current.state === 'queued') j = transition(j,{event:'confirm_cancelled'});
      await update(db,current,j); return json(view({...current,job:JSON.stringify(j)}));
    }
  }
  fail('route_missing',404);
}
export async function renderWorker(request,env,path,readJson,readBytes) {
  const secret = env.RENDER_WORKER_SECRET;
  if (!secret || secret.length < 32 || hash(request.headers.get('authorization') ?? '') !== hash(`Bearer ${secret}`)) fail('worker_auth_required',401);
  const db = env.DB, bucket = env.BUCKET;
  if (path.length === 2 && path[1] === 'claim' && request.method === 'POST') {
    await sql(db,"INSERT INTO vl_render_workers(id,expires) VALUES('native-v1',?) ON CONFLICT(id) DO UPDATE SET expires=excluded.expires",Date.now()+LEASE).run();
    // Reap expired leases through the same Rust transition machine. Cancellation
    // must finish, never resurrect as a newly queued attempt.
    for (const r of await all(db,"SELECT * FROM vl_render_jobs WHERE state IN ('preparing','running','cancelling') AND lease<? LIMIT 50",Date.now())) {
      const event = r.state === 'cancelling' ? 'confirm_cancelled' : 'recover_after_reload';
      await discardAttempt(bucket,r);
      try { await update(db,r,transition(JSON.parse(r.job),{event}),{lease:0,token:''}); } catch (error) { if (error.message !== 'job_changed_retry') throw error; }
    }
    const r = await row(db,"SELECT * FROM vl_render_jobs WHERE state='queued' ORDER BY rowid LIMIT 1");
    if (!r) return json({job:null});
    const token = crypto.randomUUID()+crypto.randomUUID();
    const j = transition(JSON.parse(r.job),{event:'start'});
    try { await update(db,r,j,{lease:Date.now()+LEASE,token:hash(token)}); } catch (error) { if(error.message==='job_changed_retry') return json({job:null}); throw error; }
    return json({job:{id:r.id,owner:r.owner,claim_token:token,attempt:j.attempt.attempt,manifest:JSON.parse(r.manifest)}});
  }
  const r = await row(db,'SELECT * FROM vl_render_jobs WHERE owner=? AND id=?',request.headers.get('x-render-owner') ?? '',path[1] ?? '');
  if (!r || r.token !== hash(request.headers.get('x-render-claim') ?? '')) fail('worker_lease_lost');
  if (r.state === 'succeeded' && path.length === 3 && path[2] === 'complete' && request.method === 'POST') return json({committed:true,sha256:r.sha});
  if (r.lease <= Date.now()) fail('worker_lease_lost');
  const j = JSON.parse(r.job);
  if (path.length === 3 && path[2] === 'heartbeat' && request.method === 'POST') {
    if (r.state === 'cancelling') { await update(db,r,transition(j,{event:'confirm_cancelled'})); return json({cancelled:true}); }
    const progress = await readJson(request);
    let next; try { next=transition(j,{event:'progress',phase:progress.phase,progress_milli:progress.progress_milli}); } catch { fail('invalid_progress',400); }
    await update(db,r,next,{lease:Date.now()+LEASE});
    await sql(db,"UPDATE vl_render_workers SET expires=? WHERE id='native-v1'",Date.now()+LEASE).run();
    return json({cancelled:false});
  }
  if (!['preparing','running'].includes(r.state)) fail('worker_lease_lost');
  if (path.length === 4 && path[2] === 'original' && request.method === 'GET') {
    if (!JSON.parse(domain.renderRequiredAssets(r.manifest)).includes(path[3])) fail('asset_not_in_manifest',403);
    const asset = await row(db,'SELECT * FROM vl_assets WHERE owner=? AND campaign=? AND hash=?',r.owner,r.campaign,path[3]);
    const object = asset && await bucket.get(asset.objectKey); if(!object) fail('original_missing',404);
    return new Response(object.body,{headers:{'content-type':asset.mime,'content-length':String(asset.bytes),'cache-control':'no-store'}});
  }
  if (path.length === 3 && path[2] === 'fail' && request.method === 'POST') {
    const failure={code:'native_attempt_failed',message:'Render attempt did not complete. Retry is available.',action:'retry',retryable:true};
    await update(db,r,transition(j,{event:'fail',failure}),{lease:0,token:''}); return json({failed:true});
  }
  if (path.length === 3 && path[2] === 'artifact' && request.method === 'POST') {
    if (r.uploadId) return json({part_size_bytes:PART});
    const input = await readJson(request);
    if (!/^[a-f0-9]{64}$/.test(input.sha256) || !Number.isSafeInteger(input.byte_length) || input.byte_length<=0 || input.byte_length>MAX) fail('artifact_limits',413);
    const key=`renders/${r.owner}/${r.id}/${j.attempt.attempt}/${crypto.randomUUID()}.webm`;
    const upload=await bucket.createMultipartUpload(key,{httpMetadata:{contentType:'video/webm'}});
    const result=await sql(db,'UPDATE vl_render_jobs SET uploadId=?,uploadKey=?,sha=?,bytes=?,parts=?,generation=generation+1 WHERE owner=? AND id=? AND generation=? AND (SELECT COALESCE(SUM(bytes),0) FROM vl_render_jobs WHERE owner=? AND id<>?) + ? <= ?',upload.uploadId,key,input.sha256,input.byte_length,'[]',r.owner,r.id,r.generation,r.owner,r.id,input.byte_length,2*MAX).run();
    if(result.meta.changes!==1) {await upload.abort(); fail('job_changed_retry');}
    return json({part_size_bytes:PART});
  }
  if (path.length === 4 && path[2] === 'parts' && request.method === 'PUT') {
    if(!r.uploadId) fail('artifact_upload_missing');
    const number=Number(path[3]), expected=Math.min(PART,r.bytes-(number-1)*PART);
    if(!Number.isInteger(number)||number<1||expected<=0) fail('part_number',400);
    const bytes=await readBytes(request,PART);
    const sha=hash(bytes); if(bytes.length!==expected||sha!==request.headers.get('x-content-sha256')) fail('part_checksum');
    const parts=JSON.parse(r.parts); const old=parts.find(x=>x.partNumber===number);
    if(old) {if(old.sha!==sha) fail('part_payload_mismatch'); return json({stored:true});}
    const part=await bucket.resumeMultipartUpload(r.uploadKey,r.uploadId).uploadPart(number,bytes);
    parts.push({...part,sha}); parts.sort((a,b)=>a.partNumber-b.partNumber);
    const result=await sql(db,'UPDATE vl_render_jobs SET parts=?,generation=generation+1 WHERE owner=? AND id=? AND generation=?',JSON.stringify(parts),r.owner,r.id,r.generation).run();
    if(result.meta.changes!==1) fail('job_changed_retry'); return json({stored:true});
  }
  if(path.length===3 && path[2]==='complete' && request.method==='POST') {
    if(!r.uploadId) fail('artifact_upload_missing');
    const parts=JSON.parse(r.parts);
    if(parts.length!==Math.ceil(r.bytes/PART)||parts.some((x,i)=>x.partNumber!==i+1)) fail('artifact_parts_missing');
    let object=await bucket.get(r.uploadKey);
    if(!object) {await bucket.resumeMultipartUpload(r.uploadKey,r.uploadId).complete(parts.map(({partNumber,etag})=>({partNumber,etag})));object=await bucket.get(r.uploadKey);}
    if(!object||object.size!==r.bytes) fail('artifact_size_mismatch');
    const digest=sha256.create();let count=0;let magic=[];
    const reader=object.body.getReader();try {for(;;) {const {value,done}=await reader.read();if(done)break;count+=value.length;if(count>r.bytes)fail('artifact_limits');for(const byte of value.slice(0,Math.max(0,4-magic.length)))magic.push(byte);digest.update(value);}} finally {reader.releaseLock();}
    if(count!==r.bytes||bytesToHex(digest.digest())!==r.sha||magic.join(',')!=='26,69,223,163') fail('artifact_verification_failed');
    const next=transition(j,{event:'succeed',artifact_path:r.uploadKey});
    const result=await sql(db,"UPDATE vl_render_jobs SET job=?,state='succeeded',artifact=?,generation=generation+1,lease=0 WHERE owner=? AND id=? AND generation=? AND state IN ('preparing','running') AND lease>?",JSON.stringify(next),r.uploadKey,r.owner,r.id,r.generation,Date.now()).run();
    if(result.meta.changes!==1) fail('worker_lease_lost');return json({committed:true,sha256:r.sha});
  }
  fail('route_missing',404);
}
