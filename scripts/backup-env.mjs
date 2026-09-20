#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const destination = path.join(root, '.env.prod');
const ignoredDirs = new Set(['.git', 'node_modules', '.next', 'dist', 'coverage', '.cache']);
const files = new Set(['.env']);
function collect(relativeDir) {
  const absolute = path.join(root, relativeDir);
  if (!fs.existsSync(absolute)) return;
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const relative = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredDirs.has(entry.name)) collect(relative);
      continue;
    }
    const name = entry.name;
    const isEnvironment = /^(?:\.env(?:\..+)?|.+\.env)$/.test(name)
      && !/(?:example|sample|template)/i.test(name);
    const isPrivateKey = relativeDir.startsWith('.deploy')
      && /(?:^known_hosts$|-ed25519(?:\.pub)?$|\.(?:pem|key|pub)$)/.test(name);
    if (isEnvironment || isPrivateKey) files.add(relative);
  }
}
for (const directory of ['aeroCRM_monorepo', 'aeroCRM_infra', '.deploy']) collect(directory);

const contents = [...files].sort().map(relative => ({
  relative,
  content: fs.readFileSync(path.join(root, relative)),
}));
const original = contents.find(item => item.relative === '.env').content.toString('utf8');
parseEnv(original);
const output = [
  '# ПРИВАТНЫЙ РЕЗЕРВНЫЙ ФАЙЛ aeroCRM. Не публиковать и не добавлять в Git.',
  '# Содержит исходную анкету и точные копии созданных env/SSH-ключей обоих новых репозиториев.',
  '# Base64 ниже — кодирование, а НЕ шифрование. Хранить в защищённом месте.',
  '# Для восстановления: декодировать каждую пару FILE_N_PATH / FILE_N_BASE64',
  '# относительно папки aeroCRM и установить права 0600.',
  '# Это резервная копия: сервисы используют свои отдельные production env.',
  '# Генерация: node aeroCRM_infra/scripts/backup-env.mjs',
  `# Обновлено: ${new Date().toISOString()}`,
  '',
  '# ----- Исходная анкета в читаемом виде -----',
  original.trimEnd(),
  '',
  '# ----- Точные копии файлов; индексы исключают конфликты имён переменных -----',
  'AEROCRM_BACKUP_FORMAT_VERSION=1',
  `AEROCRM_BACKUP_FILE_COUNT=${contents.length}`,
];
for (const [index, item] of contents.entries()) {
  const prefix = `AEROCRM_BACKUP_FILE_${String(index + 1).padStart(3, '0')}`;
  output.push('', `# Источник: ${item.relative}`, `${prefix}_PATH=${JSON.stringify(item.relative)}`,
    `${prefix}_BASE64=${item.content.toString('base64')}`);
}
const rendered = output.join('\n') + '\n';
const decoded = parseEnv(rendered);
for (const [index, item] of contents.entries()) {
  const prefix = `AEROCRM_BACKUP_FILE_${String(index + 1).padStart(3, '0')}`;
  if (!Buffer.from(decoded[`${prefix}_BASE64`], 'base64').equals(item.content)) {
    throw new Error('Backup round-trip verification failed');
  }
  if (!fs.readFileSync(path.join(root, item.relative)).equals(item.content)) {
    throw new Error('Configuration changed while backing up; rerun');
  }
}
const temp = `${destination}.tmp-${process.pid}`;
try {
  fs.writeFileSync(temp, rendered, { mode: 0o600, flag: 'wx' });
  fs.renameSync(temp, destination);
  fs.chmodSync(destination, 0o600);
} finally {
  fs.rmSync(temp, { force: true });
}
console.log(JSON.stringify({ file: '.env.prod', files: contents.length,
  verified: true, mode: '0600', sources: contents.map(item => item.relative) }));
