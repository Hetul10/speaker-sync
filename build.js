import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { httpsOrigin } from './origin.js';

const relay = httpsOrigin(process.env.RELAY_ORIGIN, 'RELAY_ORIGIN');
const source = new URL('./public/', import.meta.url);
const output = new URL('./dist/', import.meta.url);
const html = await readFile(new URL('index.html', source), 'utf8');

await mkdir(output, { recursive: true });
await cp(source, output, { recursive: true });
const relayAttribute = relay.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
await writeFile(new URL('index.html', output), html.replace('</head>', () =>
  '  <meta name="speaker-sync-relay" content="' + relayAttribute + '">\n</head>'));
