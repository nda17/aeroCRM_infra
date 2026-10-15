import assert from 'node:assert/strict';

export const riskControlsServices = ['identity', 'notification-delivery', 'campaigns', 'billing', 'operations'];
export function prepareRiskControlsWriters({ preflight, runtime, stop }) {
  preflight();
  const writers = runtime().filter(container => container.running).map(container => container.id);
  if (writers.length) stop(writers);
  assert(!runtime().some(container => container.running), 'Risk controls require all backend writers stopped before DDL');
}
const probes = {
  identity: `const c=require('/app/dist/src/users/marketing-email.service.js');
    assert.deepEqual(c.MARKETING_EMAIL_CAPABILITIES,{profile:1,authorization:1,unsubscribe:1,binding:1});
    const valid={schemaVersion:1,commandId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',expectedVersion:0,
      expectedEmailBinding:null,enabled:false,consentTextVersion:'marketing-email-v1'};
    assert.deepEqual(c.parseMarketingEmailCommand(valid),valid);
    assert.throws(()=>c.parseMarketingEmailCommand({...valid,extra:true}));
    const missing={...valid};delete missing.expectedEmailBinding;
    assert.throws(()=>c.parseMarketingEmailCommand(missing));`,
  'notification-delivery': `const c=require('/app/dist/src/notification-delivery/marketing-email-context.service.js');
    assert.deepEqual(c.MARKETING_EMAIL_CONTEXT_CAPABILITIES,{authorization:1,request:3,outcome:3,unsubscribe:1});
    assert.equal(c.isBoundMarketingEmailEvent({schemaVersion:3,recipientUserId:'fixture-user'}),true);
    assert.equal(c.isBoundMarketingEmailEvent({schemaVersion:2,recipientUserId:'fixture-user'}),false);
    assert.equal(c.isBoundMarketingEmailEvent({schemaVersion:3,recipientUserId:''}),false);`,
  campaigns: `const c=require('/app/dist/src/messaging/campaigns-event.contract.js');
    assert.deepEqual(c.CAMPAIGNS_MARKETING_CAPABILITIES,{request:3,outcome:3,skipped:1,recipientBinding:1});
    const uuid='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const valid={schemaVersion:3,eventType:'notification.delivery.outcome.v2',eventId:uuid,occurredAt:'2026-10-15T00:00:00.000Z',
      correlationId:uuid,sourceEventId:uuid,sourceKind:'campaign-email',campaignId:uuid,deliveryId:uuid,
      dispatchGeneration:1,status:'SKIPPED',reason:'MARKETING_NOT_AUTHORIZED',failure:null};
    const message=value=>({content:Buffer.from(JSON.stringify(value)),properties:{messageId:uuid,type:valid.eventType,headers:{}}});
    c.parseCampaignsMessage('outcome',message(valid));
    const missing={...valid};delete missing.reason;
    assert.throws(()=>c.parseCampaignsMessage('outcome',message(missing)));
    const legacy={...valid,schemaVersion:2};delete legacy.reason;
    assert.throws(()=>c.parseCampaignsMessage('outcome',message(legacy)));`,
  operations: `const c=require('/app/dist/src/messaging/admin-audit-event.contract.js');
    const allowed=require('/app/dist/src/admin-event-log/admin-event-log.contract.js').ADMIN_EVENT_LOG_ACTIONS;
    const uuid='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    for(const action of ['MARKETING_EMAIL_CONSENT_UPDATE','CRM_REFUND_REVIEWED','CRM_REFUND_RETRY']){
      assert(allowed.includes(action));
      const identity=action==='MARKETING_EMAIL_CONSENT_UPDATE';
      const value={schemaVersion:1,eventType:'admin.audit.event.v1',eventId:uuid,occurredAt:'2026-10-15T00:00:00.000Z',
        correlationId:uuid,actorId:uuid,action,metadata:{},section:identity?'USERS':'PAYMENTS',description:'Risk controls audit contract',
        entity:{type:identity?'user':'crm_refund_review',id:uuid,label:null,targetUserId:identity?uuid:null}};
      if(identity){value.actorSnapshot={name:null,email:null};value.entity.targetSnapshot={name:null,email:null};}
      const source={kind:identity?'identity-admin-audit':'billing-admin-audit'};
      assert.equal(c.parseAdminAuditEvent(source,value).record.action,action);
      assert.throws(()=>c.parseAdminAuditEvent(source,{...value,action:'UNREVIEWED_RISK_ACTION'}));
    }`,
  billing: `const c=require('/app/dist/src/domain/crm-refund.service.js');
    assert.equal(c.CRM_REFUND_REVIEW_CAPABILITY,'crm-refund-manual-review-v1');
    const source=require('/app/dist/src/provider/yookassa-webhook-source.js');
    assert.equal(source.isYooKassaWebhookSource('185.71.76.1'),true);
    assert.equal(source.isYooKassaWebhookSource('127.0.0.1'),false);
    assert.equal(source.isYooKassaWebhookSource('185.71.76.1, 127.0.0.1'),false);`
};
export function riskControlsImageCapable(service, image, revision, expectedInventory, execute) {
  assert(riskControlsServices.includes(service));
  if (execute(`${service} risk controls revision`, 'docker', ['image', 'inspect', '--format',
    '{{index .Config.Labels "org.opencontainers.image.revision"}}', image]) !== revision) return false;
  try {
    const result = JSON.parse(execute(`${service} risk controls semantic capability`, 'docker', [
      'run', '--rm', '--network', 'none', '--entrypoint', 'node', image, '-e',
      `const assert=require('node:assert/strict');try { ${probes[service]}
       const fs=require('node:fs'),crypto=require('node:crypto');
       const expected=${JSON.stringify(expectedInventory || null)};
       if(expected){const root='/app/prisma',hash=b=>crypto.createHash('sha256').update(b).digest('hex');
         assert.deepEqual(Object.fromEntries(fs.readdirSync(root+'/migrations',{withFileTypes:true})
           .filter(x=>x.isDirectory()).map(x=>[x.name,hash(fs.readFileSync(root+'/migrations/'+x.name+'/migration.sql'))])),expected.migrations);
         assert.equal(hash(fs.readFileSync(root+'/database-access.json')),expected.aclSha256);}
       console.log(JSON.stringify({capable:true})); } catch { console.log(JSON.stringify({capable:false})); }`
    ]));
    return result.capable === true && Object.keys(result).length === 1;
  } catch { return false; }
}
export function assertRiskControlsCapability(states, capabilities) {
  for (const state of Object.values(states)) {
    assert(state.valid === true, 'Risk controls migration history checksum/attempt differs');
    assert(!state.recorded || state.completed === true, 'Risk controls migration is incomplete; exact target recovery required');
  }
  if (Object.values(states).some(state => state.recorded))
    assert(riskControlsServices.every(service => capabilities[service] === true),
      'Persisted marketing consent/refund evidence requires compatible Identity, Notification Delivery, Campaigns, Billing and Operations images');
}
