// AT-15: a secret appears in what the session is shown, and the stored transcript must hold the
// marker, never the value. Until the gateway (H3) there are no tool results, so the result here
// is a command's: the session prints a planted file of made-up credentials (an .env, a key
// block, a token pasted on its own line), and the test reads the transcript twice, through
// transcript.get and straight from the Core's transcripts folder. The values are random per
// run and never printed; the test only checks whether they appear.
// The control is a plain marker line from the same session, so an empty transcript can't pass.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const id = 'AT-15';
export const title = 'A secret appears in a result the session sees';

const rand = (/** @type {number} */ n, /** @type {string} */ abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789') =>
  Array.from(crypto.randomBytes(n), (b) => abc[b % abc.length]).join('');

/** @param {Awaited<ReturnType<typeof import('../harness.js').createHarness>>} h */
export async function run(h) {
  const plain = `AT15-PLAIN-${rand(12)}`;
  /** @type {[string, string, string][]} name, the value, the line that carries it */
  const secrets = [
    ['Anthropic key in an .env line', `sk-ant-api03-${rand(40)}`, 'ANTHROPIC_API_KEY=%s'],
    ['OpenAI key on its own', `sk-proj-${rand(40)}`, '%s'],
    ['GitHub token in a URL', `ghp_${rand(36)}`, 'https://x-access-token:%s@github.com/acme/repo.git'],
    ['AWS access key id', `AKIA${rand(16, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567')}`, 'aws_access_key_id = %s'],
    ['a password in NAME=value', rand(18), 'DB_PASSWORD=%s'],
    ['a bearer token in a header', rand(32), 'Authorization: Bearer %s'],
    ['a private key block', rand(64), '-----BEGIN OPENSSH PRIVATE KEY-----\r\n%s\r\n-----END OPENSSH PRIVATE KEY-----'],
  ];
  const dir = path.join(h.ws, 'at15');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'secrets.txt'), `${secrets.map(([, v, line]) => line.replace('%s', v)).join('\r\n')}\r\n`);
  const { session } = await h.startScript('at15', ['type secrets.txt', `echo ${plain}`]);
  await h.waitEnd(session);

  const viaApi = (await h.call('transcript.get', { id: session })).text;
  const onDisk = fs.readFileSync(path.join(h.data, 'transcripts', `${session}.txt`), 'utf8');
  const control = viaApi.includes(plain) && onDisk.includes(plain);
  /** @type {import('../harness.js').Attempt[]} */
  const attempts = [{ name: 'control: the session\'s plain output is in its transcript', result: 'observed', evidence: control ? 'present, through transcript.get and on disk' : 'missing' }];
  for (const [name, value] of secrets) {
    const leaked = viaApi.includes(value) || onDisk.includes(value);
    attempts.push({ name, result: leaked ? 'got through' : 'blocked', evidence: leaked ? 'the value is in the stored transcript' : 'only the marker is stored' });
  }
  const markers = [...new Set(onDisk.match(/\[REDACTED:[a-z-]+\]/g) ?? [])];
  return {
    id, title, attempts,
    notes: [
      control ? `The transcript holds the session's output, with these markers: ${markers.join(', ') || 'none'}.` : 'THE CONTROL FAILED: the plain marker line is not in the transcript, so a missing secret proves nothing. Not a pass.',
      'Until the gateway (H3) a tool result is a command\'s output in the terminal; AT-15 runs again on tool results then.',
    ],
    pass: control && !attempts.some((a) => a.result === 'got through'),
  };
}
