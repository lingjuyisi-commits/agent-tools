const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const zlib = require('zlib');
const tar = require('tar');
const { pipeline } = require('stream/promises');
const { Readable, PassThrough } = require('stream');

const pkg = require('../../package.json');

const DIST_DIR = path.join(__dirname, '..', '..', 'dist');
const CLI_TGZ = path.join(DIST_DIR, 'agent-tools-cli.tgz');
const CACHE_DIR = path.join(os.homedir(), '.agent-tools-server', 'cache');

async function clientRoutes(fastify, opts) {
  const publicUrl = opts?.config?.server?.publicUrl;
  const db = opts?.db;
  // --- GET /api/v1/client/version ---
  fastify.get('/api/v1/client/version', async () => {
    return { version: pkg.version };
  });

  // --- GET /api/v1/client/download ---
  fastify.get('/api/v1/client/download', async (request, reply) => {
    if (!fs.existsSync(CLI_TGZ)) {
      return reply.status(404).send({
        error: '客户端安装包不可用（开发环境）',
        hint: '此功能需要通过 CI 打包的正式 server 版本',
      });
    }

    const baseUrl = publicUrl || resolveBaseUrl(request);
    const version = pkg.version;
    const cachePath = getCachePath(version, baseUrl);

    try {
      // Check file cache
      if (!fs.existsSync(cachePath)) {
        const buf = await buildCustomTgz(baseUrl);
        fs.mkdirSync(CACHE_DIR, { recursive: true });
        fs.writeFileSync(cachePath, buf);
      }

      const stat = fs.statSync(cachePath);

      // Record the download — one event per HTTP request. We log at response
      // start (not after completion) because fastify streams the reply and we
      // don't easily get a "fully sent" callback; in practice a started
      // download is a good enough proxy. Errors are swallowed.
      if (db) {
        try {
          const ip = firstVal(request.headers['x-forwarded-for']) || request.ip || '';
          const ua = (request.headers['user-agent'] || '').slice(0, 200);
          const now = new Date().toISOString();
          const eventId = crypto
            .createHash('sha1')
            .update(`${now}|${ip}|${ua}|${version}`)
            .digest('hex');
          db('events').insert({
            event_id: eventId,
            agent: 'agent-tools-cli',
            agent_version: version,
            username: '',
            hostname: '',
            platform: '',
            session_id: `download_${now}`,
            conversation_turn: 0,
            event_type: 'download',
            event_time: now,
            received_time: now,
            extra: JSON.stringify({ version, ip, user_agent: ua }),
          }).onConflict('event_id').ignore().catch(() => {});
        } catch {}
      }

      reply
        .header('Content-Type', 'application/gzip')
        .header('Content-Disposition', 'attachment; filename="agent-tools-cli.tgz"')
        .header('Content-Length', stat.size);
      return fs.createReadStream(cachePath);
    } catch (err) {
      request.log.error(err, 'Failed to build customized CLI tgz');
      return reply.status(500).send({ error: '生成客户端安装包失败', detail: err.message });
    }
  });
}

// ===== Resolve base URL from request =====

function resolveBaseUrl(request) {
  const headers = request.headers;

  // 1. X-Original-URL — extract base before /api/v1/
  const originalUrl = headers['x-original-url'];
  if (originalUrl) {
    const idx = originalUrl.indexOf('/api/v1/');
    if (idx > 0) return originalUrl.slice(0, idx);
  }

  // 2. X-Forwarded-* combination
  const fwdProto = firstVal(headers['x-forwarded-proto'])
                || firstVal(headers['x-forwarded-scheme']);
  const fwdHost  = firstVal(headers['x-forwarded-host'])
                || firstVal(headers['x-original-host']);
  if (fwdHost) {
    const proto  = fwdProto || request.protocol || 'http';
    const prefix = headers['x-forwarded-prefix'] || '';
    return buildUrl(proto, fwdHost, headers['x-forwarded-port'], prefix);
  }

  // 3. Forwarded (RFC 7239)
  const fwd = parseForwarded(headers['forwarded']);
  if (fwd && fwd.host) {
    return buildUrl(fwd.proto || request.protocol || 'http', fwd.host);
  }

  // 4. Direct connection fallback
  const proto = request.protocol || 'http';
  const host  = request.hostname;
  const port  = String(request.socket?.localPort || '');
  return buildUrl(proto, host, port);
}

function firstVal(header) {
  if (!header) return null;
  return header.split(',')[0].trim();
}

function buildUrl(proto, host, port, prefix) {
  let hostPort = host;
  if (port && !host.includes(':')) {
    const isDefault = (proto === 'https' && port === '443')
                   || (proto === 'http' && port === '80');
    if (!isDefault) hostPort = `${host}:${port}`;
  }
  const pfx = (prefix || '').replace(/\/+$/, '');
  return `${proto}://${hostPort}${pfx}`;
}

function parseForwarded(header) {
  if (!header) return null;
  const result = {};
  // Take first entry (first proxy hop = client)
  const first = header.split(',')[0].trim();
  for (const part of first.split(';')) {
    const [key, val] = part.trim().split('=');
    if (key && val) {
      const k = key.toLowerCase();
      const v = val.replace(/^"|"$/g, '');
      if (k === 'host') result.host = v;
      if (k === 'proto') result.proto = v;
    }
  }
  return result;
}

// ===== Cache =====

function getCachePath(version, baseUrl) {
  const hash = crypto.createHash('md5').update(baseUrl).digest('hex').slice(0, 12);
  return path.join(CACHE_DIR, `cli-${version}-${hash}.tgz`);
}

// ===== Build customized tgz =====

async function buildCustomTgz(baseUrl) {
  // 1. Read original tgz
  const origBuf = fs.readFileSync(CLI_TGZ);

  // 2. Extract to temp dir
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tools-repack-'));
  try {
    await tar.extract({ file: CLI_TGZ, cwd: tmpDir });

    // 3. Modify default-config.json
    const configPath = path.join(tmpDir, 'package', 'default-config.json');
    if (fs.existsSync(configPath)) {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      cfg.server = cfg.server || {};
      cfg.server.url = baseUrl;
      fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf-8');
    }

    // 4. Repack to tgz
    const entries = fs.readdirSync(tmpDir);
    const chunks = [];
    const passthrough = new PassThrough();
    passthrough.on('data', chunk => chunks.push(chunk));

    await tar.create(
      { gzip: true, cwd: tmpDir, portable: true },
      entries,
    ).pipe(passthrough);

    // Wait for stream to finish
    await new Promise((resolve, reject) => {
      passthrough.on('end', resolve);
      passthrough.on('error', reject);
    });

    return Buffer.concat(chunks);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

module.exports = clientRoutes;
