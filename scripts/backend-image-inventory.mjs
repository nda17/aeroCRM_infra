#!/usr/bin/env node
// Read-only inventory shared with the reviewed cleanup controller. No deletion here.
// Built-in-only imports preserve the existing stdin inventory workflow.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = '/opt/aerocrm';
const apps = ['api-gateway','notification-delivery','campaigns','reporting','billing','identity','platform','support','operations','crm-access','crm-intake','crm-customers','crm-sales'];
const sha = /^[a-f0-9]{40}$/;
const imageId = /^sha256:[a-f0-9]{64}$/;
export const releaseInventoryFiles = ['backend-state.json', 'backend-previous-state.json', 'backend-release.pending.json',
  'backend.sha', 'backend.previous.sha', 'workspace-closure-compatible.sha', 'workspace-closure-enabled.sha',
  'backend-rollback-blocked.pending', 'crm-contract-cutover.pending'];
export function dockerInventory(args) {
  try { return execFileSync('docker', args, { encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30_000,maxBuffer:16*1024*1024 }).trim(); }
  catch { throw new Error('Docker inventory read failed; private output suppressed'); }
}
function readRelease(name) {
  const file = `${root}/releases/${name}`;
  let stat;
  try { stat=fs.lstatSync(file); } catch(error) { if(error.code==='ENOENT')return null;throw error; }
  assert(stat.isFile()&&!stat.isSymbolicLink()&&fs.realpathSync(file)===file,'Unsafe release inventory path');
  return fs.readFileSync(file,'utf8');
}
export function collectImageSnapshot({ readRelease: read = readRelease, run = dockerInventory,
  generatedAt = new Date().toISOString(), validateStateFn = null, validatePendingFn = null } = {}) {
  const preserve = new Map();
  const preserveTags = new Map();
  const add = (map, key, reason) => map.set(key, [...new Set([...(map.get(key) ?? []), reason])]);
  const files = new Map(releaseInventoryFiles.map(name => [name, read(name)]));
  function retainManifest(manifest, reason) {
    assert(manifest.schemaVersion===1&&sha.test(manifest.releaseSha)&&typeof manifest.ciRunId==='string'&&/^[0-9]+$/.test(manifest.ciRunId));
    assert.deepEqual(Object.keys(manifest.services).sort(),[...apps].sort());
    for (const app of apps) {
      const entry=manifest.services[app]; assert(sha.test(entry.sourceSha)&&imageId.test(entry.imageId));
      add(preserve,entry.imageId,reason); add(preserveTags,`aerocrm/${app}:${entry.sourceSha}`,reason);
    }
  }
  function retainSha(value, reason) {
    assert(sha.test(value),`Invalid ${reason} SHA`);
    for (const app of apps) add(preserveTags,`aerocrm/${app}:${value}`,reason);
  }
  function retainState(state, reason) {
    if(validateStateFn) validateStateFn(state);
    assert(state.schemaVersion===1&&sha.test(state.infraSha)&&typeof state.envHash==='string'&&typeof state.composeHash==='string');
    retainManifest(state.manifest,reason);
    if (state.closure?.schemaAnchorSha) retainSha(state.closure.schemaAnchorSha,`${reason}:schema-anchor`);
  }
  const canonical=files.get('backend-state.json');const previous=files.get('backend-previous-state.json');const pending=files.get('backend-release.pending.json');
  assert(canonical||files.get('backend.sha'),'Current backend identity is required');
  const canonicalState=canonical===null?null:JSON.parse(canonical);
  if(canonicalState)retainState(canonicalState,'canonical');
  if(previous!==null)retainState(JSON.parse(previous),'verified-previous');
  if(pending!==null){const value=JSON.parse(pending);if(validatePendingFn)validatePendingFn(value,canonicalState);assert(value.schemaVersion===1&&value.phase==='switching');retainState(value.target,'pending-target');retainState(value.previous,'pending-previous');}
  for(const name of releaseInventoryFiles.slice(3,-1)){
    const value=files.get(name)?.trim();if(value)retainSha(value,`marker:${name}`);
  }
  // Presence is unsafe even when the legacy marker is empty.
  assert(files.get('crm-contract-cutover.pending')===null,'Resolve legacy contract cutover before image inventory');
  const containerIds=run(['ps','-aq']).split('\n').filter(Boolean).sort();
  const containers=containerIds.length?JSON.parse(run(['inspect',...containerIds])):[];
  assert.equal(containers.length,containerIds.length,'Container inspection inventory changed');
  const containerReferences=containers.map(container=>{
    assert(typeof container.Id==='string'&&/^[a-f0-9]{64}$/.test(container.Id)&&imageId.test(container.Image));
    add(preserve,container.Image,'container-reference');
    return {containerId:container.Id,imageId:container.Image};
  }).sort((a,b)=>a.containerId.localeCompare(b.containerId));
  assert.equal(new Set(containerReferences.map(container=>container.containerId)).size,containerIds.length,'Duplicate container inspection');
  const ids=[...new Set(run(['image','ls','--all','--no-trunc','--format','{{.ID}}']).split('\n').filter(Boolean))].sort();
  assert(ids.every(id=>imageId.test(id)));
  const images=ids.length?JSON.parse(run(['image','inspect',...ids])):[];
  assert.equal(images.length,ids.length,'Image inspection inventory changed');
  assert.deepEqual(images.map(image=>image.Id).sort(),ids,'Unexpected inspected image identities');
  const candidates=[];const retained=[];
  for(const image of images){
    const id=image.Id;const tags=[...(image.RepoTags??[])].sort();
    for(const tag of tags)for(const reason of preserveTags.get(tag)??[])add(preserve,id,reason);
    const owned=tags.length>0&&tags.every(tag=>{const match=/^aerocrm\/([a-z-]+):([a-f0-9]{40})$/.exec(tag);return match&&apps.includes(match[1]);});
    const reasons=preserve.get(id)??[];
    const item={imageId:id,tags,sizeBytes:image.Size,revision:image.Config?.Labels?.['org.opencontainers.image.revision']??null};
    if(owned&&reasons.length===0&&sha.test(item.revision)&&tags.every(tag=>tag.endsWith(`:${item.revision}`)))candidates.push(item);
    else if(tags.some(tag=>tag.startsWith('aerocrm/')))retained.push({...item,reasons:reasons.length?reasons:['unreviewed-image-tags-or-provenance']});
  }
  const inventory={schemaVersion:1,mode:'READ_ONLY',generatedAt,containerCount:containerIds.length,
    candidates:candidates.sort((a,b)=>a.imageId.localeCompare(b.imageId)),retained:retained.sort((a,b)=>a.imageId.localeCompare(b.imageId)),
    estimatedImageBytes:candidates.reduce((sum,item)=>sum+item.sizeBytes,0),
    note:'Image sizes share layers and are not reclaimable disk estimates. No deletion is authorized or performed.'};
  const protection={releaseFiles:releaseInventoryFiles.map(name=>({name,sha256:files.get(name)===null?null:createHash('sha256').update(files.get(name)).digest('hex')})),
    containers:containerReferences};
  return {inventory,protection,imageIds:ids};
}
export function collectImageInventory(options) { return collectImageSnapshot(options).inventory; }
if(process.argv[1]==='-' || (process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1]))){
  assert.equal(process.platform,'linux');assert.equal(fs.realpathSync('.'),root);
  assert.equal(process.argv.length,2,'Inventory accepts no mutation options');
  console.log(JSON.stringify(collectImageInventory(),null,2));
}
