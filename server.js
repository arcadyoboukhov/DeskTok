const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const { spawn } = require('child_process');
const crypto = require('crypto');
const config = require('./config');

/**
 * =============================================================================
 * DESKTOP TIKTOK PLAYER - SERVER
 * =============================================================================
 * 
 * This is the main Express.js server for the Desktop TikTok Player.
 * 
 * Key Responsibilities:
 * 1. Serves static frontend files (HTML, CSS, JS)
 * 2. Exposes video files via /videos/ endpoint
 * 3. Manages user behavior tracking (watch time, likes)
 * 4. Generates personalized video recommendations
 * 5. Maintains persistent state (recent videos, user behavior)
 * 
 * All paths are configured via config.js for cross-platform compatibility.
 */

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;

// Load configuration - handles cross-platform path setup
const { isValid, errors } = config.validate();
if (!isValid) {
  console.error('Configuration Error:');
  errors.forEach(err => console.error(err));
  console.error('\nPlease configure VIDEO_SOURCE_DIR in config.js or set the VIDEO_SOURCE_DIR environment variable.');
  process.exit(1);
}

const videosRoot = config.videoRoot;

// Serve the front-end static files from project root
app.use(express.static(path.join(__dirname)));

// Expose videos under /videos/<category>/<file>
// This allows the frontend to request video files dynamically
app.use('/videos', express.static(videosRoot, { extensions: ['mp4', 'mov', 'webm', 'mkv', 'avi'] }));

async function ensureDir(dir) {
  try { await fs.mkdir(dir, { recursive: true }); } catch (e) { }
}

// Fire-and-forget thumbnail generator using ffmpeg. Logs errors but doesn't block.
// Thumbnails are cached as WebP images for faster loading
async function generateThumbnailIfMissing(category, filename) {
  try {
    const base = filename.replace(/\.[^/.]+$/, '');
    const outDir = path.join(videosRoot, category);
    const outPath = path.join(outDir, base + '.webp');
    try { await fs.access(outPath); return; } catch (e) { /* missing */ }

    await ensureDir(outDir);
    const videoPath = path.join(videosRoot, category, filename);

    const args = ['-ss', '0.5', '-i', videoPath, '-frames:v', '1', '-vf', 'scale=640:-1', '-y', outPath];
    const ff = spawn('ffmpeg', args, { stdio: 'ignore' });
    ff.on('error', (err) => { console.warn('ffmpeg spawn error', err.message); });
    ff.on('exit', (code) => { if (code !== 0) console.warn('ffmpeg exited with code', code, 'for', videoPath); });
  } catch (err) { console.warn('Thumbnail generation failed', category, filename, err && err.message); }
}

// Modify this function to generate a thumbnail for the "next" video before it's used in the display
async function generateNextThumbnailIfNeeded(posts) {
  try {
    for (const post of posts) {
      const filePath = post.videoUrl.replace('/videos/', '');
      const category = filePath.split('/')[0];
      const filename = filePath.split('/')[1];
      await generateThumbnailIfMissing(category, filename);
    }
  } catch (err) {
    console.warn('Failed to generate thumbnail for upcoming video(s)', err && err.message);
  }
}

// global seed for deterministic pseudo-random generation (set once at startup)
const GLOBAL_SEED = crypto.randomBytes(4).readUInt32LE(0);

// user behavior: { "category/file.mp4": { watchTime: seconds, likes: 0/1 } }
let userBehavior = {};
let fileMap = {};
let categories = [];
const RECENT_LIMIT = 50;
const recentQueue = [];
const recentSet = new Set();
const recommender = require('./recommender');

// Persistence paths and helpers
const DATA_DIR = config.dataDir;
const RECENT_PATH = config.getRecentPath();
const BEHAVIOR_PATH = config.getBehaviorPath();

async function ensureDataDir() {
  try { await fs.mkdir(DATA_DIR, { recursive: true }); } catch (e) { }
}

async function saveRecent() {
  try {
    await ensureDataDir();
    await fs.writeFile(RECENT_PATH, JSON.stringify({ queue: recentQueue.slice(-RECENT_LIMIT) }), 'utf8');
  } catch (e) { console.warn('Failed to save recent.json', e && e.message); }
}

async function saveBehavior() {
  try {
    await ensureDataDir();
    await fs.writeFile(BEHAVIOR_PATH, JSON.stringify(userBehavior), 'utf8');
  } catch (e) { console.warn('Failed to save behavior.json', e && e.message); }
}

async function loadPersistent() {
  try {
    await ensureDataDir();
    try {
      const b = await fs.readFile(RECENT_PATH, 'utf8');
      const parsed = JSON.parse(b || '{}');
      const q = Array.isArray(parsed.queue) ? parsed.queue : [];
      recentQueue.length = 0;
      for (const k of q.slice(-RECENT_LIMIT)) { recentQueue.push(k); }
      recentSet.clear();
      for (const k of recentQueue) recentSet.add(k);
    } catch (e) { /* ignore missing/invalid recent file */ }

    try {
      const b2 = await fs.readFile(BEHAVIOR_PATH, 'utf8');
      const parsed2 = JSON.parse(b2 || '{}');
      // replace contents of userBehavior
      Object.keys(userBehavior).forEach(k=>delete userBehavior[k]);
      if (parsed2 && typeof parsed2 === 'object') Object.assign(userBehavior, parsed2);
    } catch (e) { /* ignore missing/invalid behavior file */ }

    console.log('Loaded persistent state: recent=', recentQueue.length, 'behavior=', Object.keys(userBehavior).length);
  } catch (e) {
    console.warn('Failed loading persistent state', e && e.message);
  }
}

// Ensure persisted state is flushed on shutdown
process.on('SIGINT', () => {
  try {
    fsSync.writeFileSync(RECENT_PATH, JSON.stringify({ queue: recentQueue.slice(-RECENT_LIMIT) }), 'utf8');
    fsSync.writeFileSync(BEHAVIOR_PATH, JSON.stringify(userBehavior), 'utf8');
  } catch (e) { /* best-effort */ }
  process.exit(0);
});

// random number generator function
function mulberry32(a) {
  return function () {
    let t = a += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Populate fileMap by scanning the categories. Called periodically to
// pick up new files added to disk.
async function buildCache() {
  try {
    const entries = await fs.readdir(videosRoot, { withFileTypes: true });
    const cats = entries.filter(e => e.isDirectory()).map(d => d.name).sort();

    const map = {};
    for (const cat of cats) {
      try {
        const files = await fs.readdir(path.join(videosRoot, cat));
        const vids = files.filter(f => /\.(mp4|mov|webm|mkv|avi)$/i.test(f)).sort();
        if (vids.length) map[cat] = vids.slice();
      } catch (err) {
        console.warn('Error reading category', cat, err.message);
      }
    }

    fileMap = map;
    categories = Object.keys(fileMap);
    console.log(`Built file map with ${categories.length} categories.`);
    // update recommender index in background
    try { recommender.buildIndex(fileMap).catch(()=>{}); } catch (e) { }
  } catch (err) {
    console.error('Error building videos file map', err && err.message);
    fileMap = {};
    categories = [];
  }
}

// Generate posts for a given range [offset, offset+limit).
function generatePostsRange(offset, limit) {
  const out = [];
  if (!categories || categories.length === 0) return out;

  let attempts = 0;
  const MAX_ATTEMPTS = limit * 10;

  while (out.length < limit && attempts < MAX_ATTEMPTS) {
    attempts++;

    const i = offset + out.length;
    const pairIndex = Math.floor(i / 2);

    const rnd = mulberry32((GLOBAL_SEED + pairIndex + attempts) >>> 0);

    const cat = categories[Math.floor(rnd() * categories.length)];
    const files = fileMap[cat];
    if (!files || files.length === 0) continue;

    const start = Math.floor(rnd() * files.length);
    const idxInPair = i % 2;
    const file = files[(start + idxInPair) % files.length];

    const key = `${cat}/${file}`;
    if (recentSet.has(key)) continue;

    generateThumbnailIfMissing(cat, file);

    const base = file.replace(/\.[^/.]+$/, '') + '.webp';

    out.push({
      videoUrl: `/videos/${encodeURIComponent(cat)}/${encodeURIComponent(file)}`,
      thumbnailUrl: `/videos/${encodeURIComponent(cat)}/${encodeURIComponent(base)}`,
      user: cat,
      caption: file,
      song: ''
    });

    recentQueue.push(key);
    // keep bounded and update recentSet
    while (recentQueue.length > RECENT_LIMIT) {
      const old = recentQueue.shift();
      recentSet.delete(old);
    }
    recentSet.add(key);
    // persist recent queue (best-effort)
    saveRecent().catch(()=>{});
  }

  // Pre-generate thumbnails for upcoming videos (next videos in the queue)
  generateNextThumbnailIfNeeded(out);

  return out;
}

// initial cache build and periodic refresh to avoid scanning on every request
// Load persisted state, then build cache and schedule periodic tasks
loadPersistent().then(() => {
  buildCache();
  setInterval(buildCache, 30 * 1000);
  // periodic flush of in-memory state
  setInterval(() => { saveRecent().catch(()=>{}); saveBehavior().catch(()=>{}); }, 30 * 1000);
});

// API: return paginated posts (infinite generator)
// The endpoint mixes regular posts with personalized recommendations
app.get('/api/posts', (req, res) => {
  const offset = Math.max(0, parseInt(req.query.offset || '0', 10));
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || '50', 10)));

  // Generate base posts from the catalog
  const posts = generatePostsRange(offset, Math.max(0, limit - 4));

  // Get personalized recommendations based on user behavior
  // Recommendations are mixed in to provide adaptive content
  let recs = [];
  try { recs = recommender.recommend(userBehavior, recentSet, 6); } catch (e) { recs = []; }

  // Merge: put recommendations after regular posts
  const merged = posts.concat(recs);
  res.json({ total: Number.MAX_SAFE_INTEGER, posts: merged });
});

// Track user watch/interaction events. body: { key: "Category/file.mp4", watchTime: seconds, action: 'like'|'skip' }
// This data is used for adaptive recommendations and personalization
app.post('/api/track', (req, res) => {
  const { key, watchTime = 0, action } = req.body || {};
  if (!key) return res.status(400).json({ ok: false, error: 'missing key' });

  // Initialize behavior tracking for new videos
  if (!userBehavior[key]) userBehavior[key] = { watchTime: 0, likes: 0 };
  
  // Accumulate watch time
  userBehavior[key].watchTime += Number(watchTime || 0);
  
  // Track likes and skips
  if (action === 'like') userBehavior[key].likes = (userBehavior[key].likes || 0) + 1;
  if (action === 'skip') userBehavior[key].watchTime = Math.max(0, userBehavior[key].watchTime - 1);

  // persist behavior (best-effort, non-blocking)
  saveBehavior().catch(()=>{});

  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));
