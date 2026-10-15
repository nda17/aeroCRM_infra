import assert from 'node:assert/strict';

// Publication must address the same fixed object used by the DNS-isolated proxy.
export function assertAndroidApkProxy(config, sourceUrl) {
  const url = new URL(sourceUrl);
  assert.equal(url.protocol, 'https:');
  assert.equal(url.hostname, 's3.twcstorage.ru');
  assert(!url.username && !url.password && !url.port && !url.search && !url.hash);
  assert(/^\/content-files\/aerocrm\/android\/\d+\.\d+\.\d+\/aeroCRM\.apk$/.test(url.pathname));
  const blocks = [...config.matchAll(/location\s*=\s*\/downloads\/aeroCRM\.apk\s*\{([\s\S]*?)\n\s*\}/g)];
  assert.equal(blocks.length, 1, 'Exactly one APK proxy location required');
  const block = blocks[0][1];
  const variables = [...block.matchAll(/\bset\s+\$aerocrm_apk_upstream\s+([^;\s]+)\s*;/g)];
  assert.equal(variables.length, 1);
  assert.equal(variables[0][1], url.href, 'APK proxy must target the same immutable S3 version');
  assert.equal((block.match(/\bproxy_pass\b/g) || []).length, 1);
  assert(/\bproxy_pass\s+\$aerocrm_apk_upstream\s*;/.test(block));
  assert(/\bresolver\s+127\.0\.0\.53\s+valid=30s\s+ipv6=off\s*;/.test(block));
  assert(/\bresolver_timeout\s+5s\s*;/.test(block));
}
