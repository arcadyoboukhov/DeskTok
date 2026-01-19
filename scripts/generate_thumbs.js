const fs = require('fs').promises;
const path = require('path');
const { spawn } = require('child_process');

// Configure this path to match server.js videosRoot
const videosRoot = path.resolve('C:/Users/ADMIN/Videos/short videos');

const VIDEO_EXT = /\.(mp4|mov|webm|mkv|avi)$/i;

async function walkCategories(root){
  const entries = await fs.readdir(root, { withFileTypes: true });
  return entries.filter(e => e.isDirectory()).map(d => d.name);
}

function spawnFfmpegExtract(videoPath, outPath){
  return new Promise((resolve, reject) => {
    const args = ['-ss','0.5','-i', videoPath, '-frames:v','1','-vf','scale=640:-1','-y', outPath];
    const p = spawn('ffmpeg', args, { stdio: 'ignore' });
    p.on('error', reject);
    p.on('exit', (code) => { if(code === 0) resolve(); else reject(new Error('ffmpeg exit ' + code)); });
  });
}

async function processAll(){
  console.log('Scanning', videosRoot);
  const cats = await walkCategories(videosRoot);
  let total = 0, skipped = 0, created = 0, failed = 0;

  for(const cat of cats){
    const dir = path.join(videosRoot, cat);
    const files = await fs.readdir(dir);
    for(const f of files){
      if(!VIDEO_EXT.test(f)) continue;
      total++;
      const base = f.replace(/\.[^/.]+$/, '');
      const out = path.join(dir, base + '.webp');
      try{
        await fs.access(out);
        skipped++;
        continue;
      }catch(e){ /* missing */ }

      const videoPath = path.join(dir, f);
      try{
        console.log('Generating', out);
        await spawnFfmpegExtract(videoPath, out);
        created++;
      }catch(err){
        console.warn('Failed', f, err.message);
        failed++;
      }
    }
  }

  console.log(`Done. total=${total} created=${created} skipped=${skipped} failed=${failed}`);
}

processAll().catch(err => { console.error(err); process.exit(1); });
