import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir,writeFile,readFile,chmod} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {TEST_RENDER_SECRET} from './test-sites-render.mjs';
const image=process.env.VARIANTLAB_SITES_WORKER_IMAGE ?? 'variantlab-sites-worker:bridge';
const directory=resolve('.test-results/sites-native');
async function run(args) {
  return new Promise((resolve,reject)=>{
    const child=spawn('docker',args,{stdio:['ignore','pipe','pipe']});let output='';
    child.stdout.on('data',x=>{output+=x.toString();});child.stderr.on('data',x=>{output+=x.toString();});
    child.on('error',reject);child.on('exit',code=>code===0?resolve(output):reject(new Error(`Native test process exited ${code}: ${output.slice(-2000)}`)));
  });
}
export async function prepareNativeFixture() {
  await mkdir(directory,{recursive:true});await chmod(directory,0o777);
  await writeFile(resolve(directory,'input.rgb'),Buffer.alloc(320*180*3*30,90));
  await run(['run','--rm','--network','none','--read-only','--memory','512m','--cpus','1','--cap-drop','ALL','--security-opt','no-new-privileges','--mount',`type=bind,source=${directory},target=/fixture`,'--entrypoint','ffmpeg',image,'-y','-v','error','-f','rawvideo','-pixel_format','rgb24','-video_size','320x180','-framerate','30','-i','/fixture/input.rgb','-frames:v','30','-c:v','libvpx-vp9','-threads','1','-an','/fixture/source.webm']);
  return readFile(resolve(directory,'source.webm'));
}
export async function testNativeBridge({mf,api,render,testPort}) {
  const submission=structuredClone(render.submission);submission.jobs[0].spec.idempotency_key='d'.repeat(64);
  const created=await api('/batches',submission);assert.equal(created.status,200,JSON.stringify(created));
  const output=await run(['run','--rm','--read-only','--memory','512m','--memory-swap','512m','--cpus','1','--pids-limit','128','--cap-drop','ALL','--security-opt','no-new-privileges','--tmpfs','/tmp:rw,nosuid,noexec,size=256m','--add-host','host.docker.internal:host-gateway','--env',`VARIANTLAB_SITES_ORIGIN=http://host.docker.internal:${testPort}`,'--env',`RENDER_WORKER_SECRET=${TEST_RENDER_SECRET}`,'--env','VARIANTLAB_NATIVE_TEST=1','--env','VARIANTLAB_WORKER_ONCE=1','--entrypoint','python3',image,'/usr/local/lib/variantlab/sites-native-worker.py']);
  const jobs=(await api(`/batches/${created.data.batch_id}/jobs`)).data.jobs;
  assert.equal(jobs[0].state,'succeeded',JSON.stringify(jobs));assert.equal(jobs[0].artifact_ready,true);
  const artifact=(await api(`/jobs/${jobs[0].id}/artifact`)).data;
  const response=await mf.dispatchFetch(artifact.url);assert.equal(response.status,200);
  const bytes=Buffer.from(await response.arrayBuffer());assert.equal(createHash('sha256').update(bytes).digest('hex'),artifact.sha256);
  await writeFile(resolve(directory,'output.webm'),bytes);
  const probe=JSON.parse(await run(['run','--rm','--network','none','--read-only','--mount',`type=bind,source=${directory},target=/fixture,readonly`,'--entrypoint','ffprobe',image,'-v','error','-count_frames','-select_streams','v:0','-show_entries','stream=width,height,codec_name,nb_read_frames','-of','json','/fixture/output.webm']));
  assert.equal(probe.streams[0].codec_name,'vp9');assert.equal(probe.streams[0].width,320);assert.equal(probe.streams[0].height,180);assert.equal(Number(probe.streams[0].nb_read_frames),30);
  await writeFile(resolve(directory,'evidence.json'),JSON.stringify({passed:true,runtime:'Miniflare D1/R2 + restricted Linux Docker + pinned Rust/FFmpeg',memory_limit_mib:512,cpu_limit:1,corpus:'synthetic 1s 320x180 30fps VP9',artifact,probe,worker_output:output.trim()},null,2));
  console.log('Native D1 → Rust/FFmpeg → R2 passed under 512 MiB / 1 CPU; 30 VP9 frames verified.');
}
