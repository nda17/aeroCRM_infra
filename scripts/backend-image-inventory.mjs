#!/usr/bin/env node
// Read-only image retention inventory. Contains no image/container deletion operation.
// Execute on target under /opt/aerocrm/release.lock, including all stopped containers.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
const root = '/opt/aerocrm';
const apps = ['api-gateway','notification-delivery','campaigns','reporting','billing','identity','platform','support','operations','crm-access','crm-intake','crm-customers','crm-sales'];
const sha = /^[a-f0-9]{40}$/;
const imageId = /^sha256:[a-f0-9]{64}$/;
const preserve = new Map();
const preserveTags = new Map();
const add = (map, key, reason) => map.set(key, [...new Set([...(map.get(key) ?? []), reason])]);
function run(args) {
  try { return execFileSync('docker', args, { encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30_000,maxBuffer:16*1024*1024 }).trim(); }
  catch { throw new Error('Docker inventory read failed; private output suppressed'); }
}
function read(name) {
  const file = `${root}/releases/${name}`;
  if (!fs.existsSync(file)) return null;
  const stat=fs.lstatSync(file); assert(stat.isFile()&&!stat.isSymbolicLink()&&fs.realpathSync(file)===file,'Unsafe release inventory path');
  return fs.readFileSync(file,'utf8');
}
function retainManifest(manifest, reason) {
  assert(manifest.schemaVersion===1&&sha.test(manifest.releaseSha)&&typeof manifest.ciRunId==='string'&&/^[0-9]+$/.test(manifest.ciRunId));
  assert.deepEqual(Object.keys(manifest.services).sort(),[...apps].sort());
  for (const app of apps) {
    const entry=manifest.services[app]; assert(sha.test(entry.sourceSha)&&imageId.test(entry.imageId));
    add(preserve,entry.imageId,reason); add(preserveTags,`aerocrm/${app}:${entry.sourceSha}`,reason);
  }
}
function retainState(state, reason) {
  assert(state.schemaVersion===1&&sha.test(state.infraSha)&&typeof state.envHash==='string'&&typeof state.composeHash==='string');
  retainManifest(state.manifest,reason);
  if (state.closure?.schemaAnchorSha) retainSha(state.closure.schemaAnchorSha,`${reason}:schema-anchor`);
}
function retainSha(value, reason) {
  assert(sha.test(value),`Invalid ${reason} SHA`);
  for (const app of apps) add(preserveTags,`aerocrm/${app}:${value}`,reason);
}
assert.equal(process.platform,'linux');assert.equal(fs.realpathSync('.'),root);
assert.equal(process.argv.length,2,'Inventory accepts no mutation options');
const canonical=read('backend-state.json');const previous=read('backend-previous-state.json');const pending=read('backend-release.pending.json');
assert(canonical||read('backend.sha'),'Current backend identity is required');
if(canonical)retainState(JSON.parse(canonical),'canonical');
if(previous)retainState(JSON.parse(previous),'verified-previous');
if(pending){const value=JSON.parse(pending);assert(value.schemaVersion===1&&value.phase==='switching');retainState(value.target,'pending-target');retainState(value.previous,'pending-previous');}
for(const name of ['backend.sha','backend.previous.sha','workspace-closure-compatible.sha','workspace-closure-enabled.sha','backend-rollback-blocked.pending']){
 const value=read(name)?.trim();if(value)retainSha(value,`marker:${name}`);
}
// A pending legacy cutover has a different journal contract: avoid guessing its images.
assert(!read('crm-contract-cutover.pending'),'Resolve legacy contract cutover before image inventory');
const containers=run(['ps','-aq']).split('\n').filter(Boolean);
for(const id of containers){const image=run(['inspect','--format','{{.Image}}',id]);assert(imageId.test(image));add(preserve,image,'container-reference');}
const ids=[...new Set(run(['image','ls','--no-trunc','--format','{{.ID}}']).split('\n').filter(Boolean))];
const candidates=[];const retained=[];
for(const id of ids){
 assert(imageId.test(id));
 const image=JSON.parse(run(['image','inspect',id]))[0];assert.equal(image.Id,id);
 const tags=image.RepoTags??[];
 for(const tag of tags)for(const reason of preserveTags.get(tag)??[])add(preserve,id,reason);
 const owned=tags.length>0&&tags.every(tag=>{const match=/^aerocrm\/([a-z-]+):([a-f0-9]{40})$/.exec(tag);return match&&apps.includes(match[1]);});
 const reasons=preserve.get(id)??[];
 const item={imageId:id,tags,sizeBytes:image.Size,revision:image.Config?.Labels?.['org.opencontainers.image.revision']??null};
 if(owned&&reasons.length===0&&sha.test(item.revision)&&tags.every(tag=>tag.endsWith(`:${item.revision}`)))candidates.push(item);
 else if(tags.some(tag=>tag.startsWith('aerocrm/')))retained.push({...item,reasons:reasons.length?reasons:['unreviewed-image-tags-or-provenance']});
}
console.log(JSON.stringify({schemaVersion:1,mode:'READ_ONLY',generatedAt:new Date().toISOString(),containerCount:containers.length,candidates:candidates.sort((a,b)=>a.imageId.localeCompare(b.imageId)),retained,estimatedImageBytes:candidates.reduce((sum,item)=>sum+item.sizeBytes,0),note:'Image sizes share layers and are not reclaimable disk estimates. No deletion is authorized or performed.'},null,2));
