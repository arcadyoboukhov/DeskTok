const { exec } = require('child_process');
const crypto = require('crypto');

// Simple recommender with lightweight, deterministic feature extraction
// - Text features from filename (hashed bag-of-words)
// - Deterministic pseudo-random audio/visual features (fallback)
// - KMeans implemented minimally for clustering

function hashToSeed(s) {
  const h = crypto.createHash('md5').update(s).digest();
  return h.readUInt32LE(0);
}

function mulberry32(a) {
  return function () {
    let t = a += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function tokenize(name) {
  return name.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
}

function textVector(name, size = 64) {
  const vec = new Array(size).fill(0);
  const toks = tokenize(name);
  for (const t of toks) {
    const seed = hashToSeed(t);
    const rnd = mulberry32(seed)();
    const idx = Math.floor(rnd * size);
    vec[idx] += 1;
  }
  return vec;
}

function deterministicRandomVector(key, len = 16) {
  const seed = hashToSeed(key);
  const rnd = mulberry32(seed);
  const out = [];
  for (let i = 0; i < len; i++) out.push(rnd());
  return out;
}

function concat(a, b, c) {
  return a.concat(b).concat(c);
}

// Minimal kmeans (Euclidean) - not optimized, but small datasets are fine
function kmeans(data, k = 8, maxIter = 40) {
  if (!data.length) return { labels: [], centroids: [] };
  const dim = data[0].length;
  const rnd = mulberry32(123456);
  const centroids = [];
  const used = new Set();
  while (centroids.length < Math.min(k, data.length)) {
    const idx = Math.floor(rnd() * data.length);
    if (used.has(idx)) continue;
    used.add(idx);
    centroids.push(data[idx].slice());
  }

  let labels = new Array(data.length).fill(0);
  for (let it = 0; it < maxIter; it++) {
    let changed = 0;
    for (let i = 0; i < data.length; i++) {
      let best = 0, bestd = Infinity;
      for (let c = 0; c < centroids.length; c++) {
        let d = 0;
        const ci = centroids[c], vi = data[i];
        for (let j = 0; j < dim; j++) {
          const diff = (vi[j] || 0) - (ci[j] || 0);
          d += diff * diff;
        }
        if (d < bestd) { best = c; bestd = d; }
      }
      if (labels[i] !== best) { labels[i] = best; changed++; }
    }
    if (changed === 0) break;

    // recompute centroids
    const counts = new Array(centroids.length).fill(0);
    for (let c = 0; c < centroids.length; c++) centroids[c] = new Array(dim).fill(0);
    for (let i = 0; i < data.length; i++) {
      const c = labels[i]; counts[c]++;
      for (let j = 0; j < dim; j++) centroids[c][j] += (data[i][j] || 0);
    }
    for (let c = 0; c < centroids.length; c++) {
      if (counts[c] === 0) continue;
      for (let j = 0; j < dim; j++) centroids[c][j] /= counts[c];
    }
  }

  return { labels, centroids };
}

class Recommender {
  constructor() {
    this.index = []; // list of { key, category, file, feature }
    this.keyToIndex = {};
    this.labels = [];
    this.centroids = [];
  }

  // Build index from fileMap { category: [files] }
  async buildIndex(fileMap) {
    const idx = [];
    for (const cat of Object.keys(fileMap)) {
      for (const file of fileMap[cat]) {
        const key = `${cat}/${file}`;
        const t = textVector(file, 64);
        const a = deterministicRandomVector(key + ':a', 8);
        const v = deterministicRandomVector(key + ':v', 8);
        const feature = concat(t, a, v);
        // normalize feature
        const norm = Math.sqrt(feature.reduce((s,x)=>s + (x||0)*(x||0), 0)) || 1.0;
        for (let i=0;i<feature.length;i++) feature[i] = (feature[i]||0)/norm;
        idx.push({ key, category: cat, file, feature });
      }
    }
    this.index = idx;
    this.keyToIndex = {};
    this.index.forEach((it, i) => { this.keyToIndex[it.key] = i; });

    const data = this.index.map(i => i.feature);
    const k = Math.max(2, Math.min(12, Math.floor(Math.sqrt(Math.max(1, data.length)))));
    const { labels, centroids } = kmeans(data, k);
    this.labels = labels;
    this.centroids = centroids;
  }

  // Recommend videos given userBehavior { key: { watchTime, likes? } }
  recommend(userBehavior = {}, recentSet = new Set(), limit = 12) {
    // Build a user profile vector from watched/liked items
    const idx = this.index;
    const dim = idx.length ? idx[0].feature.length : 0;
    const userKeys = Object.keys(userBehavior || {}).filter(k => this.keyToIndex[k] !== undefined);

    // helper cosine
    function dot(a,b){ let s=0; for(let i=0;i<a.length;i++) s += (a[i]||0)*(b[i]||0); return s; }
    function cosSim(a,b){ const da = Math.sqrt(a.reduce((s,x)=>s+(x||0)*(x||0),0))||1; const db = Math.sqrt(b.reduce((s,x)=>s+(x||0)*(x||0),0))||1; return dot(a,b)/(da*db); }

    const scored = [];

    if (userKeys.length) {
      // user profile = weighted sum of features of items with weights = watchTime + 3*likes
      const profile = new Array(dim).fill(0);
      let totalWeight = 0;
      for (const k of userKeys) {
        const meta = userBehavior[k] || {};
        const weight = (Number(meta.watchTime||0)) + (Number(meta.likes||0) * 3);
        const i = this.keyToIndex[k];
        if (i === undefined) continue;
        const feat = idx[i].feature;
        for (let j=0;j<dim;j++) profile[j] += (feat[j]||0) * weight;
        totalWeight += weight;
      }
      if (totalWeight <= 0) totalWeight = 1;
      for (let j=0;j<dim;j++) profile[j] /= totalWeight;

      // score every candidate by cosine similarity to profile
      for (let i=0;i<idx.length;i++){
        const key = idx[i].key;
        if (recentSet.has(key)) continue;
        const sim = cosSim(profile, idx[i].feature);
        scored.push({i, key, sim, item: idx[i]});
      }

      // apply simple MMR for diversity
      const lambda = 0.65;
      const selected = [];
      const selectedKeys = new Set();
      scored.sort((a,b)=>b.sim - a.sim);
      while (selected.length < limit && scored.length){
        // candidate with highest MMR score
        let bestIdx = -1, bestScore = -Infinity;
        for (let p=0;p<scored.length;p++){
          const cand = scored[p];
          if (selectedKeys.has(cand.key)) continue;
          // compute max similarity to already selected
          let maxSim = 0;
          for (const s of selected){ maxSim = Math.max(maxSim, cosSim(idx[cand.i].feature, idx[s.i].feature)); }
          const mmr = lambda * cand.sim - (1-lambda) * maxSim;
          if (mmr > bestScore){ bestScore = mmr; bestIdx = p; }
        }
        if (bestIdx === -1) break;
        const take = scored.splice(bestIdx,1)[0];
        selected.push(take); selectedKeys.add(take.key);
      }

      const recs = selected.map(s=>s.item).slice(0,limit);
      return recs.map(it=>({
        videoUrl: `/videos/${encodeURIComponent(it.category)}/${encodeURIComponent(it.file)}`,
        thumbnailUrl: `/videos/${encodeURIComponent(it.category)}/${encodeURIComponent(it.file.replace(/\.[^/.]+$/, '') + '.webp')}`,
        user: it.category,
        caption: it.file,
        song: ''
      }));
    }

    // Fallback: global popularity by category sizes
    const counts = {};
    for (const it of this.index) counts[it.category] = (counts[it.category]||0)+1;
    const sortedCats = Object.keys(counts).sort((a,b)=>counts[b]-counts[a]);
    const out = [];
    for (const cat of sortedCats){
      for (const it of this.index){
        if (it.category !== cat) continue;
        if (recentSet.has(it.key)) continue;
        out.push(it);
        if (out.length>=limit) break;
      }
      if (out.length>=limit) break;
    }
    return out.slice(0,limit).map(it=>({
      videoUrl: `/videos/${encodeURIComponent(it.category)}/${encodeURIComponent(it.file)}`,
      thumbnailUrl: `/videos/${encodeURIComponent(it.category)}/${encodeURIComponent(it.file.replace(/\.[^/.]+$/, '') + '.webp')}`,
      user: it.category,
      caption: it.file,
      song: ''
    }));
  }
}

module.exports = new Recommender();
