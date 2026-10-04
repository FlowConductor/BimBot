const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync, spawn } = require('child_process');
const readline = require('readline');

// ============================================================================
// .ENV LOADER (optional, no dependencies)
// Loads KEY=VALUE pairs from .env next to this file.
// Real environment variables always take precedence over .env values.
// ============================================================================
(function loadEnvFile() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
})();

// ============================================================================
// CONFIGURATION
// ============================================================================
const CONFIG = {
  // Paths
  outputDir: path.join(__dirname, 'output'),
  processedDatesFile: path.join(__dirname, 'processed_dates.json'),

  // External binaries — resolved from PATH by default.
  // If a binary is not on PATH, set FFMPEG_PATH / EDGE_TTS_PATH to its full path.
  ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
  edgeTtsPath: process.env.EDGE_TTS_PATH || 'edge-tts',

  // URLs
  bimBaseUrl: 'https://www.bim.com.tr',
  bimCatalogUrl: 'https://www.bim.com.tr/aktuel-urunler.aspx',

  // YouTube / Google OAuth
  // Place your downloaded client_secret.json from Google Cloud Console here:
  clientSecretPath: path.join(__dirname, 'client_secret.json'),
  tokenCachePath: path.join(__dirname, 'youtube_token.json'),

  // Cloudinary thumbnail config — set CLOUDINARY_CLOUD_NAME / THUMBNAIL_BASE_IMAGE
  // to your own account. If CLOUDINARY_CLOUD_NAME is not set, the custom
  // thumbnail step is skipped and YouTube keeps the auto-generated frame.
  cloudinaryCloudName: process.env.CLOUDINARY_CLOUD_NAME || '',
  thumbnailBaseImage: process.env.THUMBNAIL_BASE_IMAGE || 'AKTÜEL_KATALOG_m4arhq',

  // TTS
  ttsVoice: 'tr-TR-AhmetNeural',

  // Limits
  maxProductsToProcess: 0, // 0 = unlimited
};

const SUBSCRIBE_MESSAGES = [
  'Kanalıma abone olmayı unutmayın lütfen.',
  'Abone olursanız sevinirim.',
  'Beğenip abone olursanız sevinirim.',
  'Yeni aktüel ürünler için abone olmayı unutmayın.',
];
// Abone olma çağrısının videodaki sıklığı (Eskiden 8 üründe birdi, daha az çıkması için 25 yaptık)
const SUBSCRIBE_INTERVAL = 25;

// ============================================================================
// UTILITIES
// ============================================================================
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function fetchHtml(url) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const req = https.get(url, {
      rejectUnauthorized: false,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = new URL(res.headers.location, url).href;
        return fetchHtml(redirectUrl).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
  });
}

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const req = https.get(url, {
      rejectUnauthorized: false,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
        'Referer': 'https://www.bim.com.tr/',
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.destroy();
        fs.unlinkSync(destPath);
        const redirectUrl = new URL(res.headers.location, url).href;
        return downloadFile(redirectUrl, destPath).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.destroy();
        fs.unlinkSync(destPath);
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      res.pipe(file);
      file.on('finish', () => {
        file.close(resolve);
      });
    });
    req.on('error', (err) => {
      file.destroy();
      if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
      reject(err);
    });
  });
}

function runCommand(cmd, args = [], opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: opts.stdio || 'inherit',
      shell: opts.shell || false,
      cwd: opts.cwd || undefined,
      env: { ...process.env, ...opts.env },
    });
    let stdout = '';
    let stderr = '';
    if (child.stdout) child.stdout.on('data', (d) => (stdout += d));
    if (child.stderr) child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`Command failed with code ${code}: ${stderr || stdout}`));
      resolve(stdout);
    });
    child.on('error', reject);
  });
}

function toTitleCase(str) {
  return str.replace(/\S+/g, (txt) => {
    return txt.charAt(0).toLocaleUpperCase('tr-TR') + txt.slice(1).toLocaleLowerCase('tr-TR');
  });
}

function numberToTurkishWords(n) {
  if (n === 0) return 'Sıfır';
  const ones = ['', 'Bir', 'İki', 'Üç', 'Dört', 'Beş', 'Altı', 'Yedi', 'Sekiz', 'Dokuz'];
  const tens = ['', 'On', 'Yirmi', 'Otuz', 'Kırk', 'Elli', 'Altmış', 'Yetmiş', 'Seksen', 'Doksan'];
  const scale = ['', 'Bin', 'Milyon', 'Milyar'];

  let num = n;
  const chunks = [];
  while (num > 0) {
    chunks.push(num % 1000);
    num = Math.floor(num / 1000);
  }

  let result = '';
  for (let i = chunks.length - 1; i >= 0; i--) {
    const chunk = chunks[i];
    if (chunk === 0) continue;
    let chunkStr = '';
    const h = Math.floor(chunk / 100);
    const t = Math.floor((chunk % 100) / 10);
    const o = chunk % 10;
    if (h > 0) chunkStr += (h === 1 ? 'Yüz' : ones[h] + ' Yüz') + ' ';
    if (t > 0) chunkStr += tens[t] + ' ';
    if (o > 0) {
      if (!(i === 1 && chunk === 1)) {
        chunkStr += ones[o] + ' ';
      }
    }
    if (i > 0) chunkStr += scale[i] + ' ';
    result += chunkStr;
  }
  return result.trim();
}

function parseCatalogStartDate(dateText) {
  const months = {
    ocak: 0, şubat: 1, mart: 2, nisan: 3, mayıs: 4, haziran: 5,
    temmuz: 6, ağustos: 7, eylül: 8, ekim: 9, kasım: 10, aralık: 11,
  };

  // "13 - 19 Mayıs 2026"
  const rangeMatch = dateText.match(/^(\d+)\s*-\s*(\d+)\s+([A-Za-zçğıöşüÇĞİÖŞÜ]+)\s+(\d{4})$/);
  if (rangeMatch) {
    const day = parseInt(rangeMatch[1], 10);
    const monthName = rangeMatch[3].toLocaleLowerCase('tr-TR');
    const year = parseInt(rangeMatch[4], 10);
    const month = months[monthName];
    if (month !== undefined) return new Date(year, month, day);
  }

  // "16 Mayıs Salı" veya "16 Mayıs Salı 2026"
  const dayNameMatch = dateText.match(/^(\d+)\s+([A-Za-zçğıöşüÇĞİÖŞÜ]+)\s+[A-Za-zçğıöşüÇĞİÖŞÜ]+(?:\s+(\d{4}))?$/);
  if (dayNameMatch) {
    const day = parseInt(dayNameMatch[1], 10);
    const monthName = dayNameMatch[2].toLocaleLowerCase('tr-TR');
    const year = dayNameMatch[3] ? parseInt(dayNameMatch[3], 10) : new Date().getFullYear();
    const month = months[monthName];
    if (month !== undefined) return new Date(year, month, day);
  }

  // "10 Mayıs 2026"
  const singleMatch = dateText.match(/^(\d+)\s+([A-Za-zçğıöşüÇĞİÖŞÜ]+)\s+(\d{4})$/);
  if (singleMatch) {
    const day = parseInt(singleMatch[1], 10);
    const monthName = singleMatch[2].toLocaleLowerCase('tr-TR');
    const year = parseInt(singleMatch[3], 10);
    const month = months[monthName];
    if (month !== undefined) return new Date(year, month, day);
  }

  return null;
}

function stripTime(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function isPublishDay(dateText, today) {
  // "Son 3 gün" kısıtlaması kaldırıldı: işlenmemiş ilk uygun tarih yayınlanır.
  return true;
}

function generateTags(title) {
  const tags = ['#BİM', '#BimAktüel', '#İndirim', '#Kampanya'];
  const cleanTitle = title.replace(/[^a-zA-Z0-9çğıöşüÇĞİÖŞÜ]/g, '');
  if (cleanTitle.length < 20 && cleanTitle.length > 3) tags.push('#' + cleanTitle);
  return tags.join(' ');
}

function escapeFfmpegText(str) {
  return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/:/g, '\\:');
}

function splitProductName(name, maxLen = 36) {
  if (!name) return { line1: '', line2: '' };
  const cleaned = name.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxLen) return { line1: cleaned, line2: '' };

  const target = Math.min(maxLen, Math.ceil(cleaned.length / 2));
  let splitIdx = cleaned.lastIndexOf(' ', target);
  if (splitIdx <= 0) splitIdx = cleaned.indexOf(' ', target);
  if (splitIdx <= 0) {
    return { line1: cleaned.slice(0, maxLen).trim(), line2: cleaned.slice(maxLen).trim() };
  }
  return {
    line1: cleaned.slice(0, splitIdx).trim(),
    line2: cleaned.slice(splitIdx + 1).trim(),
  };
}

function buildNameTextFilters(name) {
  const { line1, line2 } = splitProductName(name);
  const hasSecond = !!line2;
  const topHeight = hasSecond ? 150 : 130;
  const fontSize = hasSecond ? 50 : 64;
  const line1Y = hasSecond ? 28 : 34;
  const line2Y = 86;
  let filters = `drawbox=y=0:color=black@0.82:width=iw:height=${topHeight}:t=fill,`;
  filters += `drawtext=text='${escapeFfmpegText(line1)}':fontcolor=white:fontsize=${fontSize}:shadowcolor=black@0.9:shadowx=4:shadowy=4:x=(w-text_w)/2:y=${line1Y}`;
  if (hasSecond) {
    filters += `,drawtext=text='${escapeFfmpegText(line2)}':fontcolor=white:fontsize=${fontSize}:shadowcolor=black@0.9:shadowx=4:shadowy=4:x=(w-text_w)/2:y=${line2Y}`;
  }
  return filters;
}

function buildTtsText(name, lira, kurus) {
  let spokenName = toTitleCase(name)
    .replace(/\bkg\b/gi, ' Kilogram ')
    .replace(/\bgr\b/gi, ' Gram ')
    .replace(/\bcm\b/gi, ' Santim ')
    .replace(/\blt\b/gi, ' Litre ')
    .replace(/\bml\b/gi, ' Mililitre ')
    .replace(/\badet\b/gi, ' tane ')
    .replace(/\bV(\d+)/gi, 'Ve $1')
    .replace(/(\d)\.(\d)/g, '$1 nokta $2')
    .replace(/(\d),(\d)/g, '$1 virgül $2')
    .replace(/(\d)\s*L\b/g, '$1 Litre ')
    .replace(/%/g, ' yüzde ')
    .replace(/["']/g, '')
    .trim();

  let spokenPrice = '';
  if (!isNaN(lira) && lira !== '') spokenPrice += `${numberToTurkishWords(parseInt(lira, 10))} Lira`;
  if (kurus && kurus !== '00' && kurus !== '' && !isNaN(kurus)) spokenPrice += ` ${numberToTurkishWords(parseInt(kurus, 10))} Kuruş`;
  spokenPrice = spokenPrice.trim();

  // SSML kullanmıyoruz; kurulu edge-tts sürümü --ssml bayrağını desteklemiyor.
  // Ürün adı ile fiyat arasına doğal bir duraklama için virgül ekleniyor.
  return `${spokenName}, ${spokenPrice}`;
}

// ============================================================================
// GOOGLE AUTH (OAuth2 for YouTube Data API v3)
// ============================================================================
function loadCredentials() {
  if (!fs.existsSync(CONFIG.clientSecretPath)) {
    throw new Error(
      `Google client_secret.json not found at ${CONFIG.clientSecretPath}\n` +
      'Download it from Google Cloud Console > APIs & Services > Credentials > OAuth 2.0 Client IDs.'
    );
  }
  const raw = JSON.parse(fs.readFileSync(CONFIG.clientSecretPath, 'utf8'));
  const web = raw.installed || raw.web;
  return {
    clientId: web.client_id,
    clientSecret: web.client_secret,
    redirectUris: web.redirect_uris,
  };
}

function getAuthUrl(creds) {
  const redirectUri = creds.redirectUris?.[0] || 'urn:ietf:wg:oauth:2.0:oob';
  const scopes = ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube'];
  const params = new URLSearchParams({
    client_id: creds.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopes.join(' '),
    access_type: 'offline',
    prompt: 'consent',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

async function exchangeCode(creds, code) {
  const redirectUri = creds.redirectUris?.[0] || 'urn:ietf:wg:oauth:2.0:oob';
  const postData = new URLSearchParams({
    code,
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'oauth2.googleapis.com',
        port: 443,
        path: '/token',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(postData.toString()),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.error) return reject(new Error(json.error_description || json.error));
            resolve(json);
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    req.write(postData.toString());
    req.end();
  });
}

async function refreshAccessToken(creds, refreshToken) {
  const postData = new URLSearchParams({
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'oauth2.googleapis.com',
        port: 443,
        path: '/token',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(postData.toString()),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.error) return reject(new Error(json.error_description || json.error));
            resolve(json);
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    req.write(postData.toString());
    req.end();
  });
}

async function ensureAccessToken(creds) {
  if (fs.existsSync(CONFIG.tokenCachePath)) {
    const cached = JSON.parse(fs.readFileSync(CONFIG.tokenCachePath, 'utf8'));
    if (cached.refresh_token) {
      const refreshed = await refreshAccessToken(creds, cached.refresh_token);
      cached.access_token = refreshed.access_token;
      cached.expiry = Date.now() + refreshed.expires_in * 1000;
      fs.writeFileSync(CONFIG.tokenCachePath, JSON.stringify(cached, null, 2));
      return cached.access_token;
    }
  }

  const redirectUri = 'http://127.0.0.1:3000';
  console.log('\n=== YouTube OAuth Required ===');
  console.log('Open this URL in your browser and authorize the app:\n');

  const scopes = ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube'];
  const params = new URLSearchParams({
    client_id: creds.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopes.join(' '),
    access_type: 'offline',
    prompt: 'consent',
  });
  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  console.log(authUrl);
  console.log('\nWaiting for authorization at', redirectUri, '...');

  const code = await new Promise((resolve, reject) => {
    const http = require('http');
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:3000`);
      const authCode = url.searchParams.get('code');
      if (authCode) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h1>Authorization successful!</h1><p>You can close this tab.</p>');
        server.close(() => resolve(authCode));
      } else {
        res.writeHead(400);
        res.end('Missing code');
      }
    });
    server.on('error', reject);
    server.listen(3000, '127.0.0.1', () => {
      console.log('Listening on http://127.0.0.1:3000 ...');
    });
    setTimeout(() => {
      server.close();
      reject(new Error('OAuth timeout after 300 seconds'));
    }, 300000);
  });

  const postData = new URLSearchParams({
    code,
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });

  const tokenJson = await new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'oauth2.googleapis.com', port: 443, path: '/token', method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(postData.toString()) }
      },
      (res) => { let data = ''; res.on('data', (c) => data += c); res.on('end', () => { try { const j = JSON.parse(data); if (j.error) reject(new Error(j.error_description || j.error)); else resolve(j); } catch (e) { reject(e); } }); }
    );
    req.on('error', reject);
    req.write(postData.toString());
    req.end();
  });

  tokenJson.expiry = Date.now() + tokenJson.expires_in * 1000;
  fs.writeFileSync(CONFIG.tokenCachePath, JSON.stringify(tokenJson, null, 2));
  console.log('Tokens saved to', CONFIG.tokenCachePath);
  return tokenJson.access_token;
}

// ============================================================================
// YOUTUBE API HELPERS
// ============================================================================
function youtubeApiRequest(accessToken, options, payload = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'www.googleapis.com',
        port: 443,
        path: options.path,
        method: options.method || 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ...(options.headers || {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.error) return reject(new Error(JSON.stringify(json.error)));
            resolve(json);
          } catch (e) {
            resolve(data);
          }
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function uploadVideo(accessToken, videoPath, metadata) {
  const fileSize = fs.statSync(videoPath).size;
  const boundary = '----NodeFormBoundary' + Math.random().toString(36).slice(2);

  // multipart body construction
  const metaJson = JSON.stringify({
    snippet: {
      title: metadata.title,
      description: metadata.description,
      tags: metadata.tags,
      categoryId: metadata.categoryId || '26',
    },
    status: {
      privacyStatus: 'public',
    },
  });

  const preamble = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${metaJson}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: video/mp4\r\n\r\n`,
    'utf8'
  );
  const terminator = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  const videoData = fs.readFileSync(videoPath);

  const totalLength = preamble.length + videoData.length + terminator.length;

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'www.googleapis.com',
        port: 443,
        path: `/upload/youtube/v3/videos?uploadType=multipart&part=snippet,status`,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': `multipart/related; boundary=${boundary}`,
          'Content-Length': totalLength,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.error) return reject(new Error(JSON.stringify(json.error)));
            resolve(json);
          } catch (e) {
            resolve({ raw: data });
          }
        });
      }
    );
    req.on('error', reject);
    req.write(preamble);
    req.write(videoData);
    req.write(terminator);
    req.end();
  });
}

async function uploadThumbnail(accessToken, videoId, imagePath) {
  const imageData = fs.readFileSync(imagePath);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'www.googleapis.com',
        port: 443,
        path: `/upload/youtube/v3/thumbnails/set?videoId=${videoId}&uploadType=media`,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'image/jpeg',
          'Content-Length': imageData.length,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.error) return reject(new Error(JSON.stringify(json.error)));
            resolve(json);
          } catch (e) {
            resolve(data);
          }
        });
      }
    );
    req.on('error', reject);
    req.write(imageData);
    req.end();
  });
}

// ============================================================================
// MAIN WORKFLOW
// ============================================================================
async function main() {
  // Reuse existing output files to avoid reprocessing
  ensureDir(CONFIG.outputDir);

  // -------------------------------------------------------------------------
  // STEP 1: Fetch BİM main catalog page
  // -------------------------------------------------------------------------
  console.log('[1/11] Fetching BİM catalog page...');
  const mainHtml = await fetchHtml(CONFIG.bimCatalogUrl);

  // -------------------------------------------------------------------------
  // STEP 2: Extract dates
  // -------------------------------------------------------------------------
  console.log('[2/11] Extracting date keys...');
  const dates = [];
  const regex = /href="[^"]*Bim_AktuelTarihKey=(\d+)"[^>]*>([\s\S]*?)<\/a>/g;
  let match;
  while ((match = regex.exec(mainHtml)) !== null) {
    const key = match[1];
    let dateText = match[2].trim().replace(/<[^>]*>?/gm, '');
    if (dateText.toLowerCase().includes('mobil') || key === '100') continue;
    const videoSuffix = dateText.includes('-') ? 'Haftanın İndirim Fırsatları' : 'Aktüel Ürünler Kataloğu';
    if (!dates.some((d) => d.key === key)) {
      dates.push({
        key,
        date_text: dateText,
        full_url: `${CONFIG.bimBaseUrl}/Categories/100/aktuel-urunler.aspx?Bim_AktuelTarihKey=${key}`,
        video_suffix: videoSuffix,
      });
    }
  }
  dates.sort((a, b) => parseInt(a.key) - parseInt(b.key));
  if (dates.length === 0) {
    console.log('No dates found. Exiting.');
    return;
  }
  console.log(`Found ${dates.length} date(s).`);

  // -------------------------------------------------------------------------
  // STEP 3: Check processed dates and find today's publish target
  // -------------------------------------------------------------------------
  let processed = [];
  if (fs.existsSync(CONFIG.processedDatesFile)) {
    processed = JSON.parse(fs.readFileSync(CONFIG.processedDatesFile, 'utf8'));
  }

  const today = new Date();
  let targetDate = null;
  let processedChanged = false;

  for (const d of dates) {
    if (processed.includes(d.key)) continue;

    // Auto-skip and mark dates older than today
    const startDate = parseCatalogStartDate(d.date_text);
    if (startDate && stripTime(startDate).getTime() < stripTime(today).getTime()) {
      console.log(`Auto-skipping and marking past date: key=${d.key} | ${d.date_text}`);
      processed.push(d.key);
      processedChanged = true;
      continue;
    }

    if (isPublishDay(d.date_text, today)) {
      targetDate = d;
      break;
    }
  }

  // Save if any past dates were auto-marked
  if (processedChanged) {
    fs.writeFileSync(CONFIG.processedDatesFile, JSON.stringify(processed, null, 2));
  }

  if (!targetDate) {
    console.log('No unprocessed date eligible for publishing today. Exiting.');
    return;
  }
  console.log(`Processing date key=${targetDate.key} | ${targetDate.date_text}`);

  // -------------------------------------------------------------------------
  // STEP 5: Fetch product page for selected date
  // -------------------------------------------------------------------------
  console.log('[5/11] Fetching products page...');
  const productHtml = await fetchHtml(targetDate.full_url);

  // -------------------------------------------------------------------------
  // STEP 6: Parse products
  // -------------------------------------------------------------------------
  console.log('[6/11] Parsing products...');
  let products = [];
  const parts = productHtml.split('<div class="product');
  let validCount = 0;
  const seenTitles = new Set();

  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    const hasPrice = part.match(/class="[^"]*(price|fiyat)/i);
    if (!hasPrice) continue;
    const titleMatch = part.match(/<h2 class="title">([^<]*)<\/h2>/i);
    let title = titleMatch ? titleMatch[1].trim() : null;
    if (!title) continue;

    // De-duplication check
    const titleKey = title.toLowerCase().replace(/\s+/g, '');
    if (seenTitles.has(titleKey)) continue;
    seenTitles.add(titleKey);

    let rawPrice = '';
    const priceMatch = part.match(/class="(?:price|fiyat)[^>]*>([\s\S]*?)<\/div>/i);
    if (priceMatch && priceMatch[1]) rawPrice = priceMatch[1].replace(/<[^>]*>?/gm, '').trim();
    if (rawPrice.endsWith(',')) rawPrice = rawPrice.slice(0, -1);

    let visualPrice = rawPrice;
    // Fiyattaki TL, boşluk ve diğer harfleri temizle; sadece rakam/nokta/virgül bırak
    let cleanPrice = rawPrice.replace(/[^\d.,]/g, '');
    let lira = '', kurus = '00';

    if (cleanPrice.includes('.') && cleanPrice.includes(',')) {
      // 15.000,50 -> nokta binlik, virgül ondalık
      const temp = cleanPrice.replace(/\./g, '');
      const parts = temp.split(',');
      lira = parts[0];
      kurus = parts[1] || '00';
    } else if (cleanPrice.includes(',')) {
      // 118,50 -> virgül ondalık
      const parts = cleanPrice.split(',');
      lira = parts[0];
      kurus = parts[1] || '00';
    } else if (cleanPrice.includes('.')) {
      // Sadece nokta var: 118.50 (ondalık) veya 1.234 (binlik)
      const parts = cleanPrice.split('.');
      const afterDot = parts[1] || '';
      if (afterDot.length <= 2) {
        lira = parts[0];
        kurus = afterDot;
      } else {
        lira = cleanPrice.replace(/\./g, '');
      }
    } else {
      lira = cleanPrice;
    }

    let spokenPriceText = '';
    if (!isNaN(lira) && lira !== '') spokenPriceText += `${numberToTurkishWords(parseInt(lira, 10))} Lira`;
    if (kurus !== '00' && kurus !== '' && !isNaN(kurus)) spokenPriceText += ` ${numberToTurkishWords(parseInt(kurus, 10))} Kuruş`;

    let spokenTitle = toTitleCase(title);
    spokenTitle = spokenTitle
      .replace(/\bkg\b/gi, ' Kilogram ')
      .replace(/\bgr\b/gi, ' Gram ')
      .replace(/\bcm\b/gi, ' Santim ')
      .replace(/\blt\b/gi, ' Litre ')
      .replace(/\bml\b/gi, ' Mililitre ')
      .replace(/\badet\b/gi, ' tane ');
    spokenTitle = spokenTitle.replace(/\bV(\d+)/gi, 'Ve $1');
    // Ondalık nokta/virgülü boşluklu okut ki TTS yutmasın
    spokenTitle = spokenTitle
      .replace(/(\d)\.(\d)/g, '$1 nokta $2')
      .replace(/(\d),(\d)/g, '$1 virgül $2');
    // Tek başına L (litre) birimini de yakala: 1.6 L -> 1.6 Litre
    spokenTitle = spokenTitle.replace(/(\d)\s*L\b/g, '$1 Litre ');

    let ttsText = buildTtsText(title, lira, kurus);
    let autoTags = generateTags(title);
    let description = `${spokenTitle} fiyatı: ${visualPrice} TL! \n${autoTags}`;

    // Küçük resim (fallback)
    const xsrcMatch = part.match(/xsrc="([^"]*)"/i);
    const srcMatch = part.match(/src="([^"]*)"/i);
    let thumbUrl = xsrcMatch && xsrcMatch[1] ? xsrcMatch[1] : srcMatch && srcMatch[1] ? srcMatch[1] : null;
    if (thumbUrl && !thumbUrl.startsWith('http')) {
      if (!thumbUrl.startsWith('/')) thumbUrl = '/' + thumbUrl;
      thumbUrl = CONFIG.bimBaseUrl + thumbUrl;
    }

    // Detay sayfası linki
    let detailUrl = null;
    const detailMatch = part.match(/href="([^"]+)"[^>]*>\s*<div class="image"/i);
    if (detailMatch) {
      detailUrl = detailMatch[1];
      if (!detailUrl.startsWith('http')) {
        if (!detailUrl.startsWith('/')) detailUrl = '/' + detailUrl;
        detailUrl = CONFIG.bimBaseUrl + detailUrl;
      }
    }

    const safeTitle = title.replace(/['":]/g, '');
    const safePrice = visualPrice.replace(/['":]/g, '') + ' TL';

    const prefix = path.join(CONFIG.outputDir, `item_${validCount}`);
    products.push({
      product_name: safeTitle,
      product_price: safePrice,
      tts_text: ttsText,
      video_tags: autoTags,
      video_description: description,
      thumb_url: thumbUrl,
      detail_url: detailUrl,
      product_image: thumbUrl,
      imgPath: `${prefix}_img.jpg`,
      audioPath: `${prefix}_audio.mp3`,
      clipPath: `${prefix}_clip.mp4`,
      index: validCount,
    });

    validCount++;
    if (CONFIG.maxProductsToProcess > 0 && validCount >= CONFIG.maxProductsToProcess) break;
  }

  if (products.length === 0) {
    console.log('No products found. Exiting.');
    return;
  }
  console.log(`Parsed ${products.length} product(s).`);

  // Add welcome intro message
  const introMsg = `Hoş geldiniz! Bugün ${targetDate.date_text} tarihli BİM aktüel ürünlerini inceliyoruz. İyi seyirler.`;
  const introPrefix = path.join(CONFIG.outputDir, 'intro');
  const introItem = {
    product_name: 'BİM Aktüel Kataloğu',
    product_price: targetDate.date_text,
    tts_text: introMsg,
    video_tags: products[0].video_tags,
    video_description: products[0].video_description,
    thumb_url: products[0].thumb_url,
    detail_url: products[0].detail_url,
    product_image: products[0].product_image,
    imgPath: path.join(CONFIG.outputDir, 'intro_img.jpg'),
    audioPath: `${introPrefix}_audio.mp3`,
    clipPath: `${introPrefix}_clip.mp4`,
    index: -2,
    is_intro: true,
  };

  // Ürünlerin arasına "Abone olun" çağrılarını (resim aynı, ses farklı) liste aralarına yerleştiriyoruz
  const expandedProducts = [introItem]; // İlk olarak video başına giriş (intro) mesajını ekliyoruz
  for (let i = 0; i < products.length; i++) {
    expandedProducts.push(products[i]); // Sıradaki asıl ürünü listeye ekliyoruz

    // Eğer ürün sırası SUBSCRIBE_INTERVAL (örneğin 25) değerinin katıysa ve en sonuncu ürün değilsek abone ol çağrısı ekle
    if ((i + 1) % SUBSCRIBE_INTERVAL === 0 && i !== products.length - 1) {
      const prev = products[i]; // Bir önceki ürünün nesnesini alıp görüntü detaylarını kopyalıyoruz
      // Dizideki 4 farklı "abone olun" cümlesinden rastgele bir tane seçiyoruz
      const msg = SUBSCRIBE_MESSAGES[Math.floor(Math.random() * SUBSCRIBE_MESSAGES.length)];
      const prefix = path.join(CONFIG.outputDir, `subscribe_${i}`); // Abone ol sesi ve videosu için dosya adı öneki

      // Abone ol çağrısını yeni bir sanal "ürün" olarak listeye ekliyoruz
      expandedProducts.push({
        product_name: prev.product_name, // Ekranda aynı ürün adı yazacak
        product_price: prev.product_price, // Aynı fiyat yazacak
        tts_text: msg, // Ekran aynıyken yapay zeka bu seçilen abone ol metnini okuyacak
        video_tags: prev.video_tags,
        video_description: prev.video_description,
        thumb_url: prev.thumb_url,
        detail_url: prev.detail_url,
        product_image: prev.product_image,
        imgPath: prev.imgPath, // Aynı ürün resmi kullanılacak
        audioPath: `${prefix}_audio.mp3`, // Fakat oluşturulacak ses dosyası "abone ol" çağrısı olacak
        clipPath: `${prefix}_clip.mp4`, // Sadece abone ol metni için kısa bir video klibi oluşturulacak
        index: -1, // Sistemde sanal bir ürün olduğunu belirtmek için -1
        is_subscribe_call: true, // Bunun bir ürün değil abone çağrısı olduğunu belirten bayrak (flag)
      });
    }
  }
  products = expandedProducts; // İşlem bitince bu yeni listeyi asıl ürün listemizin üzerine yazıyoruz


  // -------------------------------------------------------------------------
  // STEP 7: Loop products -> download image, TTS, clip
  // -------------------------------------------------------------------------
  console.log('[7/11] Generating per-product clips...');
  for (let idx = 0; idx < products.length; idx++) {
    const p = products[idx];
    if (p.is_intro) {
      console.log(`  [${idx + 1}/${products.length}] [Giriş Mesajı]`);
    } else if (p.is_subscribe_call) {
      console.log(`  [${idx + 1}/${products.length}] [Abone Çağrısı]`);
    } else {
      console.log(`  [${idx + 1}/${products.length}] ${p.product_name}`);
    }

    // Try to fetch big image from detail page
    let imageUrl = p.thumb_url;
    if (p.detail_url) {
      try {
        console.log(`    Fetching detail page for big image...`);
        const detailHtml = await fetchHtml(p.detail_url);
        const bigImgMatch = detailHtml.match(/<img[^>]*class=\"img-fluid\"[^>]*src=\"([^\"]+)\"|<img[^>]*src=\"([^\"]+)\"[^>]*class=\"img-fluid\"/i);
        const bigUrl = bigImgMatch ? (bigImgMatch[1] || bigImgMatch[2]) : null;
        if (bigUrl && bigUrl.includes('buyuk')) {
          imageUrl = bigUrl;
          console.log(`    Big image found!`);
        } else {
          console.log(`    No big image, using thumbnail.`);
        }
      } catch (e) {
        console.log(`    Detail page fetch failed, using thumbnail.`);
      }
    }
    p.product_image = imageUrl;

    // Download image
    await downloadFile(imageUrl, p.imgPath);
    await sleep(500);

    // Generate TTS via edge-tts (Python tool)
    // Metni komut satırı yerine dosyadan veriyoruz; özel karakterlerin ayrıştırma hatası yaratmasını önler.
    const ttsTextFile = `${p.audioPath}.txt`;
    fs.writeFileSync(ttsTextFile, p.tts_text, 'utf8');
    try {
      await runCommand(CONFIG.edgeTtsPath, [
        '--file',
        ttsTextFile,
        '--write-media',
        p.audioPath,
        '--voice',
        CONFIG.ttsVoice,
      ]);
    } finally {
      try {
        fs.unlinkSync(ttsTextFile);
      } catch (e) {
        // Geçici dosya zaten yoksa önemseme
      }
    }

    // Build ffmpeg clip — modern template with top/bottom banners
    const nameFilters = buildNameTextFilters(p.product_name);
    const filterComplex =
      '[0:v]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,boxblur=40:20[bg];' +
      '[0:v]scale=1920:1080:flags=lanczos:force_original_aspect_ratio=decrease,hqdn3d=1.5:1.5:6:6,unsharp=5:5:1.0:5:5:0.0[fg];' +
      '[bg][fg]overlay=(W-w)/2:(H-h)/2,' +
      nameFilters + ',' +
      `drawbox=y=ih-190:color=#FFD700@0.95:width=iw:height=190:t=fill,` +
      `drawtext=text='${escapeFfmpegText(p.product_price)}':fontcolor=black:fontsize=100:shadowcolor=white@0.6:shadowx=3:shadowy=3:x=(w-text_w)/2:y=h-145`;

    await runCommand(CONFIG.ffmpegPath, [
      '-y',
      '-loop', '1',
      '-i', p.imgPath,
      '-i', p.audioPath,
      '-filter_complex', filterComplex,
      '-af', 'apad=pad_dur=0.5',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-crf', '18',
      '-tune', 'stillimage',
      '-c:a', 'aac',
      '-b:a', '320k',
      '-shortest',
      '-pix_fmt', 'yuv420p',
      p.clipPath,
    ]);

    await sleep(500);
  }

  // -------------------------------------------------------------------------
  // STEP 8: Build concat list and final video
  // -------------------------------------------------------------------------
  console.log('[8/11] Concatenating clips into final video...');
  const clipsListPath = path.join(CONFIG.outputDir, 'clips_list.txt');
  const clipLines = products.map((p) => `file '${p.clipPath.replace(/'/g, "'\\''")}'`).join('\n');
  fs.writeFileSync(clipsListPath, clipLines + '\n', 'utf8');

  const finalVideoPath = path.join(CONFIG.outputDir, 'final_bim_video_fiyatli.mp4');
  await runCommand(CONFIG.ffmpegPath, [
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', clipsListPath,
    '-c', 'copy',
    finalVideoPath,
  ]);

  // -------------------------------------------------------------------------
  // STEP 9: Prepare metadata
  // -------------------------------------------------------------------------
  console.log('[9/11] Preparing metadata...');
  const todayStr = new Date().toLocaleDateString('tr-TR');
  const maxDescProducts = 40;
  const displayProducts = products.slice(0, maxDescProducts);
  const productList = displayProducts.map((p) => `- ${p.product_name}`).join('\n');
  const productListSuffix = products.length > maxDescProducts ? `\n...ve ${products.length - maxDescProducts} ürün daha!` : '';
  const uniqueTags = new Set();
  uniqueTags.add('BİM');
  uniqueTags.add('Aktüel');
  uniqueTags.add('İndirim');
  uniqueTags.add('Kampanya');
  for (const p of products) {
    const tags = p.video_tags.split(' ');
    for (const t of tags) {
      const cleanTag = t.replace(/[^a-zA-Z0-9çğıöşüÇĞİÖŞÜ]/g, '').trim();
      if (cleanTag.length > 1) uniqueTags.add(cleanTag);
    }
  }
  let finalTagsString = Array.from(uniqueTags).join(',');
  if (finalTagsString.length > 400) {
    finalTagsString = finalTagsString.substring(0, 400);
    finalTagsString = finalTagsString.substring(0, finalTagsString.lastIndexOf(','));
  }
  const descriptionHashtags = Array.from(uniqueTags).map((t) => `#${t}`).join(' ');
  const finalDescription =
    `BİM Aktüel Ürünler Kataloğu (${todayStr})\n\n` +
    `Bu hafta BİM mağazalarına gelecek olan aktüel fırsat ürünlerini derledik. İyi seyirler!\n\n` +
    `📋 Ürün Listesi:\n${productList}${productListSuffix}\n\n` +
    `Daha fazlası için abone olun! 🔔\n\n` +
    `${descriptionHashtags}`;
  const videoTitle = `BİM ${targetDate.date_text} | ${targetDate.video_suffix}`;

  // -------------------------------------------------------------------------
  // STEP 10: Upload to YouTube
  // -------------------------------------------------------------------------
  console.log('[10/11] Authenticating and uploading to YouTube...');
  const creds = loadCredentials();
  const accessToken = await ensureAccessToken(creds);

  console.log('Uploading video...');
  const uploadRes = await uploadVideo(accessToken, finalVideoPath, {
    title: videoTitle,
    description: finalDescription,
    tags: finalTagsString.split(','),
    categoryId: '26',
  });
  const videoId = uploadRes.id;
  console.log('Video uploaded! ID:', videoId);

  // -------------------------------------------------------------------------
  // STEP 11: Thumbnail via Cloudinary + upload to YouTube
  // -------------------------------------------------------------------------
  if (!CONFIG.cloudinaryCloudName) {
    console.warn('[11/11] CLOUDINARY_CLOUD_NAME not set — skipping custom thumbnail.');
  } else {
    console.log('[11/11] Uploading thumbnail...');
    const encodedDate = encodeURIComponent(targetDate.date_text);
    const thumbnailUrl = `https://res.cloudinary.com/${CONFIG.cloudinaryCloudName}/image/upload/w_650,c_fit,l_text:Arial_110_bold:${encodedDate},co_white,g_east,x_50/${CONFIG.thumbnailBaseImage}.jpg`;
    const thumbnailPath = path.join(CONFIG.outputDir, 'thumbnail.jpg');
    await downloadFile(thumbnailUrl, thumbnailPath);

    // Wait a bit for YouTube to process
    console.log('Waiting 10s for YouTube processing...');
    await sleep(10000);

    await uploadThumbnail(accessToken, videoId, thumbnailPath);
    console.log('Thumbnail uploaded!');
  }

  // Mark as processed only after successful upload
  processed.push(targetDate.key);
  fs.writeFileSync(CONFIG.processedDatesFile, JSON.stringify(processed, null, 2));

  // -------------------------------------------------------------------------
  // DONE
  // -------------------------------------------------------------------------
  console.log('\n✅ Workflow complete!');
  console.log(`Video URL: https://www.youtube.com/watch?v=${videoId}`);
}

// ============================================================================
// ENTRYPOINT
// ============================================================================
main().catch((err) => {
  console.error('Workflow failed:', err.message);
  process.exit(1);
});
