export type TTSStatus = 'idle'|'speaking';
export type TTSFailure = 'key'|'quota'|'other'|null;

// Gemini TTS first (raw PCM 24kHz 16-bit mono base64, played with WebAudio).
// Free-tier TTS quotas are tiny, so on failure we fall back to the browser's
// own speech synthesis — she always has *some* voice.
const TTS_MODELS = ['gemini-2.5-flash-preview-tts', 'gemini-2.5-pro-preview-tts'];

export const AI_VOICES: { name: string; desc: string }[] = [
  { name: 'Sulafat', desc: 'Warm' },
  { name: 'Leda', desc: 'Youthful' },
  { name: 'Aoede', desc: 'Breezy' },
  { name: 'Puck', desc: 'Upbeat' },
  { name: 'Kore', desc: 'Firm' },
  { name: 'Fenrir', desc: 'Excitable' },
  { name: 'Charon', desc: 'Informative' },
  { name: 'Zephyr', desc: 'Bright' },
];

export class SaphiraVoice {
  voice = 'Sulafat';
  rate = 1.0;
  kokoroEnabled = false;
  kokoroVoice = 'af_heart';
  private kokoroCancel = 0;
  private kokoroSources: AudioBufferSourceNode[] = [];
  private ctx: AudioContext | null = null;
  private src: AudioBufferSourceNode | null = null;
  private seq = 0;
  private muted = false;
  private getKey: () => string;
  private onStatus: (s:TTSStatus)=>void;
  private failure: TTSFailure = null;
  constructor(statusCb: (s:TTSStatus)=>void, getKey: () => string){
    this.onStatus=statusCb; this.getKey=getKey;
    // warm both engines eagerly so first speak pays no init cost
    try{ window.speechSynthesis?.getVoices(); }catch{}
    try{ this.ensureCtx(); }catch{}
    // any tap anywhere primes the AudioContext for the next reply
    try{
      const warm=()=> this.unlock();
      window.addEventListener('pointerdown', warm, {passive:true});
      // iOS 12 never fires pointer events — touch gestures are the unlock there
      window.addEventListener('touchstart', warm, {passive:true});
      window.addEventListener('touchend', warm);
      window.addEventListener('keydown', warm);
    }catch{}
  }

  get speaking(){ return !!this.src; }
  get lastFailure(): TTSFailure { return this.failure; }

  setAiVoice(name:string){ this.voice=name; }
  setRate(r:number){ this.rate=r; }
  setKokoroEnabled(on:boolean){ this.kokoroEnabled=on; }
  setKokoroVoice(v:string){ this.kokoroVoice=v||'af_heart'; }
  // settings sound toggle — cuts in-flight speech and silences future speaks
  setMuted(m:boolean){ this.muted=m; if(m) this.stop(); }

  // call from a user gesture so the AudioContext is allowed to start
  unlock(){
    const ctx=this.ensureCtx();
    if(ctx && ctx.state==='suspended') ctx.resume().catch(()=>{});
  }
  private ensureCtx(){
    if(!this.ctx){
      // ponytail: iOS 12 locks to 44100 — request 24000 but fall back to device default
      try{ this.ctx = new AudioContext({ sampleRate: 24000 } as any); }catch{ try{ this.ctx = new (window as any).webkitAudioContext(); }catch{ this.ctx=null; } }
      // if ctx was created at 44100, decode will resample — handle in decodePCM
      if(this.ctx && (this.ctx.sampleRate!==24000 && (this.ctx as any).sampleRate!==44100)){
        try{ this.ctx.close(); }catch{}
        try{ this.ctx = new AudioContext(); }catch{ this.ctx=null; }
      }
    }
    return this.ctx;
  }

  stop(){
    this.seq++;
    this.kokoroCancel++;
    for(const s of this.kokoroSources){ try{ s.onended=null; s.stop(); }catch{} try{ s.disconnect(); }catch{} }
    this.kokoroSources=[];
    const s=this.src; this.src=null;
    if(s){ try{ s.onended=null; s.stop(); }catch{} try{ s.disconnect(); }catch{} }
    try{ window.speechSynthesis?.cancel(); }catch{}
    this.onStatus('idle');
  }

  async speak(text: string): Promise<boolean>{
    const my=++this.seq;
    const clean=(text||'').trim();
    if(!clean) return true;
    if(this.muted){ this.onStatus('idle'); return true; } // sound off — reply stays text-only
    this.failure=null;
    if(this.kokoroEnabled && window.saphiraDesktop){
      const ctx=this.ensureCtx();
      if(!ctx){ this.failure='other'; return false; }
      return await this.speakKokoro(clean, my, ctx);
    }
    const key=this.getKey().trim();
    if(!key){ this.failure='key'; return false; }
    const ctx=this.ensureCtx();
    if(!ctx){ this.failure='other'; return false; }
    // resume immediately — don't await it (fire-and-forget) so TTS fetch starts in parallel
    try{ if(ctx.state==='suspended') ctx.resume().catch(()=>{}); }catch{}
    // signal "speaking" right away so the avatar zooms while the PCM is still fetching
    this.onStatus('speaking');

    // chunk long replies so first audio arrives sooner (40 words ≈ 200 chars → 2 chunks)
    const chunks = this.chunk(clean);
    let b64: string | null = null;
    let rate = 24000;
    // try Gemini TTS for the first chunk only — if it fails, whole reply falls back to local voice
    // (chunking keeps first fetch short; sequential play stitches the rest)
    const first = chunks[0];
    for(const model of TTS_MODELS){
      try{ const r=await this.fetchTTS(model, key, first); b64=r.b64; rate=r.rate; break; }
      catch(e:any){
        const msg=String(e.message||e);
        if(msg.includes('404') || msg.includes('NOT_FOUND')) continue; // try next model
        if(msg.includes('429') || msg.includes('quota') || msg.includes('RESOURCE_EXHAUSTED')) this.failure='quota';
        else if(msg.includes('400') || msg.includes('403') || msg.includes('API_KEY') || msg.includes('PERMISSION_DENIED')) this.failure='key';
        else this.failure='other';
        break; // don't hammer the second model on quota/key errors
      }
    }
    if(my!==this.seq){ this.onStatus('idle'); return false; }
    if(!b64){
      // no Gemini audio — local voice for the whole reply
      this.onStatus('idle');
      const ok=await this.speakLocal(clean, my);
      return ok;
    }
    try{
      const buf=this.decodePCM(ctx, b64, rate);
      if(buf.length===0) throw new Error('empty');
      // if single chunk, just play it
      if(chunks.length===1) return await this.playBuffer(ctx, buf, my);
      // multi-chunk: play first chunk immediately, fetch remaining chunks in parallel
      const rest = chunks.slice(1);
      const fetches = rest.map(c=> this.fetchTTS(TTS_MODELS[0], key, c).catch(()=>null));
      const okFirst = await this.playBuffer(ctx, buf, my);
      if(!okFirst || my!==this.seq) return okFirst;
      for(let i=0;i<fetches.length;i++){
        const r=await fetches[i];
        if(my!==this.seq) return false;
        if(!r?.b64) continue;
        try{
          const b=this.decodePCM(ctx, r.b64, r.rate);
          if(b.length>0) await this.playBuffer(ctx, b, my);
        }catch{}
        if(my!==this.seq) return false;
      }
      return true;
    }catch{
      if(this.failure===null) this.failure='other';
      this.onStatus('idle');
    }
    // Gemini decode/play failed — browser voice instead
    const ok=await this.speakLocal(clean, my);
    return ok;
  }
  // desktop: local Kokoro streamed as Int16 PCM chunks from the main process
  private speakKokoro(text: string, my: number, ctx: AudioContext): Promise<boolean>{
    return new Promise((resolve)=>{
      const cancel = ++this.kokoroCancel;
      const reqId = my;
      const voice = this.kokoroVoice;
      const rate = this.rate;
      let scheduledUntil = 0;
      let chunkSeen = false;
      let finished = false;
      const finish=(ok:boolean)=>{
        if(finished) return; finished=true;
        off();
        if(my===this.seq){ this.src=null; this.onStatus('idle'); }
        resolve(ok);
      };
      const off = window.saphiraDesktop!.onTtsChunk(({reqId:rid, pcm, rate:srate, last})=>{
        if(rid!==reqId || cancel!==this.kokoroCancel || finished) return;
        chunkSeen=true;
        try{
          const buf=ctx.createBuffer(1, pcm.length, srate);
          const ch=buf.getChannelData(0);
          for(let i=0;i<pcm.length;i++) ch[i]=pcm[i]/32768;
          const src=ctx.createBufferSource();
          src.buffer=buf;
          const pr=Math.max(0.7,Math.min(1.3,rate));
          src.playbackRate.value=pr;
          const at=Math.max(ctx.currentTime+0.03, scheduledUntil);
          src.connect(ctx.destination);
          src.onended=()=>{
            const i=this.kokoroSources.indexOf(src); if(i>=0) this.kokoroSources.splice(i,1);
            if(last && this.kokoroSources.filter(s=>s===src).length===0 && scheduledUntil<=at+0.1) finish(true);
          };
          src.start(at);
          this.kokoroSources.push(src);
          scheduledUntil=at+buf.duration/pr+0.02;
          if(last) window.setTimeout(()=>{ if(!finished && this.kokoroSources.length===0) finish(true); }, Math.ceil(buf.duration/pr*1000)+400);
        }catch{}
      });
      // no audio ever came back (e.g. voice files missing) — treat as spoken
      // so the conversation still works, she just lip-syncs silently
      window.setTimeout(()=>{ if(!finished && !chunkSeen) finish(true); }, 4000);
      window.setTimeout(()=>{ if(!finished) finish(true); }, 30000+text.length*400);
      this.onStatus('speaking');
      void window.saphiraDesktop!.ttsSynthesize(reqId, text, {voice, rate}).then((res)=>{
        if(res && res.ok===false && !finished){ this.failure='other'; finish(false); }
      }).catch(()=>{ if(!finished && !chunkSeen){ this.failure='other'; finish(false); } });
    });
  }

  private chunk(text: string): string[]{
    if(text.length<=120) return [text];
    // split on sentence boundaries, keep delimiters, pack into ~100-char chunks
    const parts=text.split(/([.!?]+\s+)/);
    const out:string[]=[]; let cur='';
    for(const p of parts){
      if(!p.trim()) continue;
      if((cur + p).length>110 && cur){ out.push(cur.trim()); cur=p; }
      else cur+=p;
    }
    if(cur.trim()) out.push(cur.trim());
    return out.length?out.slice(0,3):[text];
  }

  private playBuffer(ctx: AudioContext, buf: AudioBuffer, my: number): Promise<boolean>{
    return new Promise((resolve)=>{
      let done=false;
      const finish=(ok:boolean)=>{ if(done) return; done=true; if(my===this.seq){ this.src=null; this.onStatus('idle'); } resolve(ok); };
      const src=ctx.createBufferSource();
      src.buffer=buf;
      src.playbackRate.value=Math.max(0.7, Math.min(1.3, this.rate));
      this.src=src; this.onStatus('speaking');
      src.onended=()=>{ try{src.disconnect();}catch{} finish(true); };
      src.connect(ctx.destination);
      try{ src.start(); }
      catch{ finish(false); return; }
      // safety net — long enough to never cut real speech
      setTimeout(()=>{ if(!done){ try{src.stop();}catch{} finish(true); } }, (buf.duration/Math.max(0.7,this.rate))*1000+8000);
    });
  }

  private speakLocal(text: string, my: number): Promise<boolean>{
    const ss=window.speechSynthesis;
    if(!ss) return Promise.resolve(false);
    return new Promise((resolve)=>{
      let done=false;
      const finish=(ok:boolean)=>{ if(done) return; done=true; if(my===this.seq){ this.src=null; this.onStatus('idle'); } resolve(ok); };
      try{
        const u=new SpeechSynthesisUtterance(text.slice(0,400));
        u.rate=Math.max(0.7, Math.min(1.3, this.rate));
        u.lang='en-US';
        const v=this.pickLocalVoice();
        if(v) u.voice=v;
        u.onend=()=>finish(true);
        u.onerror=()=>finish(false);
        this.onStatus('speaking');
        try{ ss.resume(); }catch{}
        ss.speak(u);
        // some engines never fire onend/onerror (no voices installed)
        setTimeout(()=>{ if(!done){ try{ ss.cancel(); }catch{} finish(false); } }, Math.min(40000, 3000+text.length*100));
      }catch{ finish(false); }
    });
  }

  private pickLocalVoice(): SpeechSynthesisVoice | null {
    try{
      const vs=window.speechSynthesis?.getVoices() || [];
      if(!vs.length) return null;
      const en=vs.filter(v=>/^en([-_]|$)/i.test(v.lang));
      const pool=en.length?en:vs;
      return pool.find(v=>/female|samantha|zira|aria|jenny|serena|google us english/i.test(v.name)) || pool[0];
    }catch{ return null; }
  }

  private async fetchTTS(model: string, key: string, text: string): Promise<{b64:string, rate:number}>{
    const url=`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    const res=await fetch(url, {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents:[{ parts:[{ text }] }],
        generationConfig:{
          responseModalities:['AUDIO'],
          speechConfig:{ voiceConfig:{ prebuiltVoiceConfig:{ voiceName:this.voice } } },
        },
      }),
    });
    if(!res.ok){
      const t=await res.text().catch(()=>'');
      throw new Error(`${res.status} ${t.slice(0,200)}`);
    }
    const data=await res.json();
    const part=data.candidates?.[0]?.content?.parts?.[0]?.inlineData;
    if(!part?.data) throw new Error('no-audio');
    const m=/rate=(\d+)/.exec(part.mimeType||'');
    return { b64: part.data, rate: m ? parseInt(m[1]) : 24000 };
  }

  private decodePCM(ctx: AudioContext, b64: string, rate: number): AudioBuffer{
    const bin=atob(b64);
    const bytes=new Uint8Array(bin.length);
    for(let i=0;i<bin.length;i++) bytes[i]=bin.charCodeAt(i);
    const n=Math.floor(bytes.length/2);
    // ponytail: if ctx is 44100 (iOS 12) but PCM is 24000, create at source rate then let WebAudio resample on play
    const useRate = rate || 24000;
    let buf: AudioBuffer;
    try{ buf=ctx.createBuffer(1, n, useRate); }catch{ buf=ctx.createBuffer(1, n, ctx.sampleRate); }
    const ch=buf.getChannelData(0);
    const view=new DataView(bytes.buffer);
    for(let i=0;i<n;i++) ch[i]=view.getInt16(i*2, true)/32768;
    return buf;
  }
}
