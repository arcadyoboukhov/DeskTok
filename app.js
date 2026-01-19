const feed = document.getElementById('feed');

let offset = 0;
const PAGE = 30;
let total = 0;
let loading = false;
let audioEnabled = false;

// Global audio enable button (single user gesture to allow autoplay with sound)
function createGlobalAudioButton(){
  const btn = document.createElement('button');
  btn.id = 'enable-audio';
  btn.textContent = 'Enable Audio';
  btn.style.position = 'fixed';
  btn.style.right = '12px';
  btn.style.top = '12px';
  btn.style.zIndex = 9999;
  btn.style.padding = '8px 12px';
  btn.style.background = '#111';
  btn.style.color = '#fff';
  btn.style.border = 'none';
  btn.style.borderRadius = '6px';
  btn.style.cursor = 'pointer';
  btn.addEventListener('click', async ()=>{
    try{
      // create and persist AudioContext to unlock audio
      if(!window.__globalAudioCtx && (window.AudioContext || window.webkitAudioContext)){
        const AC = window.AudioContext || window.webkitAudioContext;
        window.__globalAudioCtx = new AC();
        try{ await window.__globalAudioCtx.resume(); }catch(e){}
      } else if(window.__globalAudioCtx){
        try{ await window.__globalAudioCtx.resume(); }catch(e){}
      }

      audioEnabled = true;
      btn.style.display = 'none';

      // unmute and try to play any currently attached videos
      document.querySelectorAll('video').forEach(v=>{
        try{ v.muted = false; v.play().catch(()=>{}); }catch(e){}
      });

      // small delay to allow videos attached very shortly after to unmute/play
      setTimeout(()=>{
        document.querySelectorAll('video').forEach(v=>{ try{ v.muted = false; }catch(e){} });
      }, 200);
    }catch(e){ console.warn('Enable audio failed', e); }
  });
  document.body.appendChild(btn);
}

function makeMeta(p){
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.innerHTML = `<div class="user">${p.user}</div><div class="caption">${p.caption}</div><div class="music">♪ ${p.song || ''}</div>`;
  return meta;
}

// generate a thumbnail dataURL for a video source by drawing a frame to canvas
async function getVideoThumbnail(src, width = 480){
  return new Promise((resolve, reject) => {
    try{
      const v = document.createElement('video');
      v.crossOrigin = 'anonymous';
      v.preload = 'metadata';
      v.muted = true;
      v.src = src;

      const cleanup = () => { try{ v.src = ''; v.remove(); }catch(e){} };

      const onError = ()=>{ cleanup(); reject(new Error('thumbnail load error')); };
      v.addEventListener('error', onError, { once: true });

      v.addEventListener('loadeddata', async () => {
        // try to seek a little into the video to avoid black frames at 0
        const seekTo = Math.min(0.1, (v.duration || 0) * 0.1 || 0.1);
        const doSeek = () => {
          const canvas = document.createElement('canvas');
          const ratio = v.videoWidth ? (v.videoHeight ? v.videoWidth / v.videoHeight : 16/9) : 16/9;
          canvas.width = width;
          canvas.height = Math.round(width / ratio);
          try{
            const ctx = canvas.getContext('2d');
            ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
            const data = canvas.toDataURL('image/jpeg', 0.7);
            cleanup();
            resolve(data);
          }catch(e){
            cleanup();
            reject(e);
          }
        };

        // some browsers require waiting for seek to complete
        try{
          v.currentTime = seekTo;
          v.addEventListener('seeked', doSeek, { once: true });
          // fallback if seeked doesn't fire quickly
          setTimeout(() => { if(!v.paused) doSeek(); }, 800);
        }catch(e){ doSeek(); }
      }, { once: true });
    }catch(err){ reject(err); }
  });
}

function createPlaceholder(p){
  const section = document.createElement('section');
  section.className = 'post';
  section.dataset.videoUrl = p.videoUrl;
  if(p.thumbnailUrl) section.dataset.thumb = p.thumbnailUrl;
  section.dataset.user = p.user;
  section.dataset.caption = p.caption;
  section.dataset.song = p.song || '';

  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.appendChild(makeMeta(p));

  const actions = document.createElement('div');
  actions.className = 'actions';
  const likeWrap = document.createElement('div');
  likeWrap.style.textAlign = 'center';
  const likeBtn = document.createElement('button');
  likeBtn.className = 'action';
  likeBtn.textContent = '♥';
  const likeCount = document.createElement('div');
  likeCount.className = 'like-count';
  likeCount.textContent = '0';
  likeWrap.appendChild(likeBtn);
  likeWrap.appendChild(likeCount);

  const commentBtn = document.createElement('button');
  commentBtn.className = 'action';
  commentBtn.textContent = '💬';
  const shareBtn = document.createElement('button');
  shareBtn.className = 'action';
  shareBtn.textContent = '⤴';

  actions.appendChild(likeWrap);
  actions.appendChild(commentBtn);
  actions.appendChild(shareBtn);

  const unmuteBtn = document.createElement('button');
  unmuteBtn.className = 'unmute';
  unmuteBtn.textContent = '🔊';
  unmuteBtn.title = 'Unmute';
  unmuteBtn.style.display = 'none';

  overlay.appendChild(actions);
  overlay.appendChild(unmuteBtn);

  section.appendChild(overlay);

  // basic interactions
  let liked = false;
  likeBtn.addEventListener('click', ()=>{
    liked = !liked;
    likeBtn.classList.toggle('liked', liked);
    likeCount.textContent = liked ? '1' : '0';
    // report like to server
    try{ fetch('/api/track', { method: 'POST', headers: { 'Content-Type':'application/json' }, body: JSON.stringify({ key: section.dataset.user + '/' + section.dataset.caption, action: liked ? 'like' : undefined, watchTime: 0 }) }); }catch(e){}
  });

  // tap toggles play/pause on the created video element (if present)
  section.addEventListener('click', (e)=>{
    if(e.target.tagName.toLowerCase() === 'button') return;
    const v = section.querySelector('video');
    if(!v) return;
    if(v.paused) v.play(); else v.pause();
  });

  // dbl to like
  section.addEventListener('dblclick', ()=> likeBtn.click());

  return section;
}

// play with retry to handle transient autoplay failures
async function playWithRetry(v, tries = 3){
  for(let i=0;i<tries;i++){
    try{
      await v.play();
      return true;
    }catch(e){
      await new Promise(r=>setTimeout(r, 300 * (i+1)));
    }
  }
  return false;
}

function attachVideoToSection(section){
  if(section._hasVideo) return;
  section._hasVideo = true;

  const src = section.dataset.videoUrl;

  // create thumbnail img first to avoid black screen
  const thumbImg = document.createElement('img');
  thumbImg.className = 'thumb';
  thumbImg.style.width = '100%';
  thumbImg.style.display = 'block';
  thumbImg.style.objectFit = 'cover';
  thumbImg.style.transition = 'opacity 300ms ease';
  thumbImg.style.opacity = '1';
  section.insertBefore(thumbImg, section.firstChild);

  // generate thumbnail asynchronously; ignore errors
  if(section.dataset.thumb){
    thumbImg.src = section.dataset.thumb;
    thumbImg.onerror = ()=>{ thumbImg.style.background = '#111'; };
  } else {
    getVideoThumbnail(src, 640).then(data => { thumbImg.src = data; }).catch(()=>{ thumbImg.style.background = '#111'; });
  }

  const vid = document.createElement('video');
  vid.setAttribute('playsinline','');
  vid.setAttribute('loop','');
  vid.preload = 'metadata';
  // start muted unless user explicitly enabled audio
  vid.muted = !audioEnabled;
  vid.src = src;
  vid.style.width = '100%';
  vid.style.display = 'block';
  vid.style.objectFit = 'cover';
  vid.style.transition = 'opacity 300ms ease';
  vid.style.opacity = '0';

  vid.addEventListener('error', ()=>{
    // try a cache-busting reload if playback fails
    vid.src = src + (src.includes('?') ? '&' : '?') + 'cb=' + Date.now();
  });

  vid.addEventListener('stalled', ()=>{ /* allow IntersectionObserver to retry via playWithRetry */ });

  // show unmute when user interacts with the section (if audio not globally enabled)
  const unmute = section.querySelector('.unmute');
  if(!audioEnabled){
    unmute.style.display = 'block';
    unmute.addEventListener('click', (e)=>{
      e.stopPropagation();
      // a user gesture — safe to unmute
      vid.muted = !vid.muted;
      unmute.textContent = vid.muted ? '🔇' : '🔊';
      playWithRetry(vid, 2);
    });
  } else {
    // hide per-section unmute when global audio allowed
    unmute.style.display = 'none';
  }

  // insert video at top of section (above thumbnail)
  section.insertBefore(vid, thumbImg);

  // Watch time tracking for adaptive recommendations
  section._watchAccum = section._watchAccum || 0;
  let lastTime = 0;
  const sendAccum = () => {
    const key = section.dataset.user + '/' + section.dataset.caption;
    const toSend = Math.floor(section._watchAccum);
    if(toSend > 0){
      try{ fetch('/api/track',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ key, watchTime: toSend }) }); }catch(e){}
      section._watchAccum = 0;
    }
  };

  vid.addEventListener('timeupdate', ()=>{
    try{
      const t = vid.currentTime || 0;
      if(lastTime && t > lastTime){
        section._watchAccum += (t - lastTime);
      }
      lastTime = t;
      // send periodically when accumulated > 5s
      if(section._watchAccum >= 5){ sendAccum(); }
    }catch(e){}
  });

  vid.addEventListener('pause', ()=>{ sendAccum(); });
  vid.addEventListener('ended', ()=>{ sendAccum(); });

  // when the video can play, crossfade it in and fade out the thumbnail
  const onCanPlay = async () => {
    try{
      await playWithRetry(vid, 2);
    }catch(e){}
    // fade in video
    requestAnimationFrame(()=>{ vid.style.opacity = '1'; });
    // fade out thumbnail
    thumbImg.style.opacity = '0';
    setTimeout(()=>{ try{ thumbImg.remove(); }catch(e){} }, 350);
  };

  vid.addEventListener('canplay', onCanPlay, { once: true });
  vid.addEventListener('playing', onCanPlay, { once: true });

  // ensure we try to play as soon as possible
  playWithRetry(vid, 2).catch(()=>{});

  // pause when leaving viewport handled by observer
}

function detachVideoFromSection(section){
  const v = section.querySelector('video');
  if(v){
    try{ v.pause(); }catch(e){}
    // fade out for smooth transition then remove
    v.style.opacity = '0';
    setTimeout(()=>{ try{ v.remove(); }catch(e){} }, 350);
    // send any remaining watch time when detaching
    try{
      const key = section.dataset.user + '/' + section.dataset.caption;
      const toSend = Math.floor(section._watchAccum || 0);
      if(toSend > 0){ fetch('/api/track',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ key, watchTime: toSend }) }); }
      section._watchAccum = 0;
    }catch(e){}
  }
  section._hasVideo = false;
  const unmute = section.querySelector('.unmute');
  if(unmute) unmute.style.display = 'none';
}

// Observer: when a placeholder intersects, attach video; when leaves, detach
const viewOptions = { threshold: 0.6 };
const viewObserver = new IntersectionObserver((entries)=>{
  entries.forEach(entry=>{
    const sec = entry.target;
    if(entry.isIntersecting){
      attachVideoToSection(sec);
      const v = sec.querySelector('video');
      if(v) playWithRetry(v, 2);
    } else {
      // keep a small buffer: detach only if very far (not intersecting)
      detachVideoFromSection(sec);
    }
  });
}, viewOptions);

// sentinel for loading more pages
const sentinel = document.createElement('div');
sentinel.id = 'sentinel';
feed.appendChild(sentinel);
const sentinelObserver = new IntersectionObserver((entries)=>{
  entries.forEach(e=>{ if(e.isIntersecting) loadMore(); });
}, {root: null, threshold: 0});
sentinelObserver.observe(sentinel);

// create global audio enable control
createGlobalAudioButton();

async function loadMore(){
  if(loading) return; if(total && offset >= total) return;
  loading = true;
  try{
    const res = await fetch(`/api/posts?offset=${offset}&limit=${PAGE}`);
    const data = await res.json();
    if(!data || !Array.isArray(data.posts)){
      if(Array.isArray(data)) data.posts = data; else data.posts = [];
    }
    total = data.total || (data.posts || []).length + offset;
    const posts = data.posts || data;
    if(posts.length === 0 && offset === 0){
      feed.innerHTML = '<div style="padding:20px;color:#ddd">No videos found. Please configure VIDEO_SOURCE_DIR to point to your categorized videos folder. See README.md for setup instructions.</div>';
      return;
    }

    posts.forEach(p=>{
      const ph = createPlaceholder(p);
      feed.insertBefore(ph, sentinel);
      viewObserver.observe(ph);
    });

    offset += posts.length;
  }catch(err){
    console.error('Failed to load posts', err);
  } finally { loading = false; }
}

// kick off first page
loadMore();

