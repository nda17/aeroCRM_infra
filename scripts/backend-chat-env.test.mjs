import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  chatEnvironmentCandidate,
  chatKeys,
  environmentHash,
  stageChatEnvironment,
  validateChatBundle,
} from "./backend-chat-env.mjs";

let root;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const values = Object.fromEntries(
  chatKeys.map((key, index) => [
    key,
    [
      "true",
      "https://storage.example.test",
      "us-east-1",
      "content-files",
      "chat-independent-access-key",
      "chat-independent-secret-key",
      "true",
    ][index],
  ]),
);
const bundleBytes = () => Buffer.from(`${JSON.stringify(values)}\n`);
const writePrivate = (file, bytes) =>
  fs.writeFileSync(file, bytes, { mode: 0o600 });
const setup = (
  access = "KEEP=raw # retain\nCRM_MAIL_S3_ACCESS_KEY_ID=mail-key\n",
) => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "crm-chat-env-test-"));
  const sourceDirectoryPath = path.join(root, "source");
  fs.mkdirSync(sourceDirectoryPath, { mode: 0o700 });
  const sourceDirectory = fs.realpathSync(sourceDirectoryPath);
  writePrivate(
    path.join(sourceDirectory, "crm-access-api.env"),
    Buffer.from(access),
  );
  for (const name of [
    "crm-customers-api.env",
    "crm-customers-mail-sync.env",
    "crm-customers-mail-send.env",
  ]) {
    writePrivate(
      path.join(sourceDirectory, name),
      Buffer.from(
        [
          "CRM_MAIL_S3_ENDPOINT=https://storage.example.test",
          "CRM_MAIL_S3_REGION=us-east-1",
          "CRM_MAIL_S3_BUCKET=backup-services",
          "CRM_MAIL_S3_FORCE_PATH_STYLE=true",
          "CRM_MAIL_S3_ACCESS_KEY_ID=mail-key",
          "CRM_MAIL_S3_SECRET_ACCESS_KEY=mail-secret",
          "",
        ].join("\n"),
      ),
    );
  }
  writePrivate(
    path.join(sourceDirectory, "crm-customers-api.env"),
    Buffer.concat([
      fs.readFileSync(path.join(sourceDirectory, "crm-customers-api.env")),
      Buffer.from("EXISTING_MAIL_SETTING=keep-bytes\n"),
    ]),
  );
  const bundleFile = path.join(root, "bundle.json");
  writePrivate(bundleFile, bundleBytes());
  return { sourceDirectory, bundleFile, bundleHash: digest(bundleBytes()) };
};
test.afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = undefined;
});

test("accepts exactly the canonical seven-key bundle and rejects hash/duplicate/partial fields", () => {
  const bytes = bundleBytes();
  assert.deepEqual(validateChatBundle(bytes, digest(bytes)), values);
  assert.throws(
    () => validateChatBundle(bytes, "0".repeat(64)),
    /hash mismatch/,
  );
  const duplicate = Buffer.from(
    bytes
      .toString()
      .replace(
        '"CRM_CHAT_ATTACHMENTS_ENABLED":"true",',
        '"CRM_CHAT_ATTACHMENTS_ENABLED":"true","CRM_CHAT_ATTACHMENTS_ENABLED":"true",',
      ),
  );
  assert.throws(
    () => validateChatBundle(duplicate, digest(duplicate)),
    /canonical/,
  );
  const incompleteValues = { ...values };
  delete incompleteValues.CRM_CHAT_S3_BUCKET;
  const incomplete = Buffer.from(`${JSON.stringify(incompleteValues)}\n`);
  assert.throws(
    () => validateChatBundle(incomplete, digest(incomplete)),
    /exactly seven/,
  );
});

test("only changes the Access Chat delta, preserving every unrelated file and line byte-for-byte", () => {
  const options = setup(
    "KEEP=raw # retain\r\nCRM_MAIL_S3_ACCESS_KEY_ID=mail-key",
  );
  const { source, candidate } = chatEnvironmentCandidate(options);
  assert.equal(candidate.size, source.size);
  for (const [name, bytes] of source) {
    if (name !== "crm-access-api.env")
      assert.deepEqual(candidate.get(name), bytes);
  }
  const before = source.get("crm-access-api.env").toString();
  const after = candidate.get("crm-access-api.env").toString();
  assert.ok(after.startsWith(before + "\n"));
  for (const key of chatKeys)
    assert.ok(after.includes(`${key}='${values[key]}'\n`));
  assert.notEqual(environmentHash(source), environmentHash(candidate));
  const fullyInstalled = setup(
    `${before}\n${chatKeys.map((key) => `${key}='old'`).join("\n")}\n`,
  );
  const replacement = chatEnvironmentCandidate(fullyInstalled)
    .candidate.get("crm-access-api.env")
    .toString();
  assert.equal(
    (replacement.match(/^CRM_CHAT_/gm) ?? []).length,
    chatKeys.length,
  );
  assert.ok(replacement.includes(`${chatKeys[0]}='true'`));
});

test("rejects partial, duplicate, unknown and reused Mail credentials without mutating source", () => {
  for (const invalid of [
    `KEEP=1\n${chatKeys[0]}='true'\n`,
    `KEEP=1\n${chatKeys[0]}='true'\n${chatKeys[0]}='true'\n`,
    "KEEP=1\nCRM_CHAT_UNREVIEWED=value\n",
  ]) {
    const options = setup(invalid);
    const original = fs.readFileSync(
      path.join(options.sourceDirectory, "crm-access-api.env"),
    );
    assert.throws(() => chatEnvironmentCandidate(options));
    assert.deepEqual(
      fs.readFileSync(path.join(options.sourceDirectory, "crm-access-api.env")),
      original,
    );
  }
  const options = setup();
  const customersApi = path.join(
    options.sourceDirectory,
    "crm-customers-api.env",
  );
  fs.appendFileSync(
    customersApi,
    `CRM_MAIL_S3_ACCESS_KEY_ID=${values.CRM_CHAT_S3_ACCESS_KEY_ID}\n`,
  );
  assert.throws(
    () => chatEnvironmentCandidate(options),
    /independent access key/,
  );
});

test("requires a uniform trusted Mail storage tuple and stages a private candidate with before/after hashes", () => {
  const options = setup();
  const sendEnv = path.join(
    options.sourceDirectory,
    "crm-customers-mail-send.env",
  );
  fs.writeFileSync(
    sendEnv,
    fs
      .readFileSync(sendEnv)
      .toString()
      .replace("https://storage.example.test", "https://other.example.test"),
  );
  assert.throws(
    () => chatEnvironmentCandidate(options),
    /uniform trusted Mail provider/,
  );
  fs.writeFileSync(
    sendEnv,
    fs.readFileSync(
      path.join(options.sourceDirectory, "crm-customers-mail-sync.env"),
    ),
  );
  const { source, candidate } = chatEnvironmentCandidate(options);
  const candidateDirectory = path.join(root, "candidate");
  stageChatEnvironment({ ...options, candidateDirectory });
  assert.equal(fs.statSync(candidateDirectory).mode & 0o777, 0o700);
  for (const [name, bytes] of candidate) {
    const staged = fs.readFileSync(path.join(candidateDirectory, name));
    assert.deepEqual(staged, bytes);
    assert.equal(
      fs.statSync(path.join(candidateDirectory, name)).mode & 0o777,
      0o600,
    );
  }
  assert.equal(
    environmentHash(candidate),
    environmentHash(
      new Map(
        [...candidate].map(([name]) => [
          name,
          fs.readFileSync(path.join(candidateDirectory, name)),
        ]),
      ),
    ),
  );
  assert.throws(() => stageChatEnvironment({ ...options, candidateDirectory }));
});
