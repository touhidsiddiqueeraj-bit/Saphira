export type SpeechEvents = {
  onWake: (transcript:string)=>void;
  onUtterance: (text:string)=>void;
  onPartial: (text:string, listening:boolean, wakeArmed:boolean)=>void;
  onError: (msg:string)=>void;
  // service repeatedly failing (blocked network / denied mic) — stop retrying
  onFatal: (kind:'network'|'mic'|'unsupported')=>void;
};

const FATAL = new Set(['network','service-not-allowed','not-allowed','audio-capture','language-not-supported']);

export class WakeListener {
  private rec: any = null;
  private running = false;
  private wakeArmed = true;
  private silenceTimer: number | null = null;
  private oneShotTimer: number | null = null;
  private finals = '';
  private wakeWord = 'hey saphira';
  private enabled = false;
  private forceListen = false; // tap-to-talk session while enabled==false
  private consecErr = 0;
  private cooldownUntil = 0;
  private events: SpeechEvents;
  constructor(events: SpeechEvents){ this.events=events; }

  get isSupported(){
    const has = !!(window as any).SpeechRecognition || !!(window as any).webkitSpeechRecognition;
    if(!has) return false;
    try{
      const ua=navigator.userAgent||'';
      if(/iPad|iPhone|iPod/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua)){
        // iPadOS 14.5+ ships a real Siri-backed recognizer; older iOS either
        // lacks the API entirely or only a dead stub — gate on OS version
        const m=/OS (\d+)[._](\d+)/.exec(ua);
        if(m && (Number(m[1]) < 14 || (Number(m[1])===14 && Number(m[2])<5))) return false;
      }
    }catch{}
    return has;
  }
  get isListening(){ return this.running; }
  setWakeWord(s:string){ this.wakeWord = (s||'hey saphira').toLowerCase().trim(); }
  setEnabled(on:boolean){ this.enabled=on; if(on){ this.consecErr=0; this.cooldownUntil=0; this.start(); } else this.stop(); }

  // tap-to-talk: capture one utterance, no wake word needed
  listenOnce(){
    this.forceListen = true;
    this.wakeArmed = false;
    this.finals = '';
    this.consecErr = 0;
    this.cooldownUntil = 0;
    this.start();
    if(this.oneShotTimer) window.clearTimeout(this.oneShotTimer);
    this.oneShotTimer = window.setTimeout(()=>{ this.endOneShot(); }, 10000);
  }
  private endOneShot(){
    this.forceListen = false;
    this.wakeArmed = true;
    this.finals = '';
    if(!this.enabled) this.stop();
    else this.events.onPartial('', this.running, true);
  }

  start(){
    if(!this.enabled && !this.forceListen) return;
    if(this.running) return;
    if(!this.isSupported){
      this.events.onFatal('unsupported');
      return;
    }
    const SR: any = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    try{ if(this.rec){ try{this.rec.abort();}catch{} } }catch{}
    this.rec = new SR();
    this.rec.continuous = true;
    this.rec.interimResults = true;
    this.rec.lang = 'en-US';
    this.rec.onstart = ()=>{ this.running=true; this.events.onPartial('', true, this.wakeArmed); };
    this.rec.onend = ()=>{
      this.running=false;
      this.rec=null;
      if(!this.enabled && !this.forceListen){ this.events.onPartial('', false, this.wakeArmed); return; }
      if(this.consecErr>=3) return; // fatal already reported, stay stopped
      const wait=Math.max(400, this.cooldownUntil-Date.now());
      setTimeout(()=>{ try{ this.start(); }catch{} }, wait);
    };
    this.rec.onerror = (e:any)=>{
      const msg = e.error || 'speech error';
      if(msg==='no-speech' || msg==='aborted') return;
      if(FATAL.has(msg)){
        this.consecErr++;
        // exponential backoff so a dead service doesn't spin
        this.cooldownUntil = Date.now()+Math.min(8000, 600*Math.pow(2, this.consecErr));
        if(this.consecErr>=3){
          this.events.onFatal(msg==='network'||msg==='service-not-allowed' ? 'network' : 'mic');
        } else {
          this.events.onError(msg==='network' ? 'Speech unreachable — retrying…' : 'Mic: '+msg);
        }
        return;
      }
      this.events.onError('Mic: '+msg);
    };
    this.rec.onresult = (e:any)=>{
      this.consecErr=0; // any result = service alive
      let interim='';
      for(let i=e.resultIndex;i<e.results.length;i++){
        const r=e.results[i];
        if(r.isFinal) this.finals += r[0].transcript + ' ';
        else interim += r[0].transcript + ' ';
      }
      if(this.wakeArmed){
        const combined=(this.finals+interim).trim();
        const lw=this.wakeWord.toLowerCase();
        if(lw && combined.toLowerCase().includes(lw)){
          const idx=combined.toLowerCase().lastIndexOf(lw);
          this.finals=combined.slice(idx+this.wakeWord.length).trim()+' ';
          if(this.finals.trim()==='') this.finals='';
          this.events.onWake(combined);
          this.wakeArmed=false;
          this.events.onPartial(this.finals.trim(), true, false);
          this.resetSilenceTimer();
        } else {
          this.events.onPartial(combined, true, true);
        }
      } else {
        const display=(this.finals+interim).trim();
        this.events.onPartial(display, true, false);
        if(display.length>0) this.resetSilenceTimer();
      }
    };
    try{ this.rec.start(); }catch{ this.running=false; this.rec=null; }
  }

  private resetSilenceTimer(){
    if(this.silenceTimer) window.clearTimeout(this.silenceTimer);
    this.silenceTimer = window.setTimeout(()=>{
      const text=(this.finals||'').trim();
      this.finals='';
      if(text.length>1) this.events.onUtterance(text);
      this.wakeArmed=true;
      if(this.forceListen){ this.endOneShot(); return; }
      this.events.onPartial('', this.running, true);
    }, 1200);
  }

  stop(){
    this.wakeArmed=true;
    this.finals='';
    this.forceListen=false;
    this.consecErr=0;
    this.cooldownUntil=0;
    if(this.oneShotTimer){ clearTimeout(this.oneShotTimer); this.oneShotTimer=null; }
    if(this.silenceTimer){ clearTimeout(this.silenceTimer); this.silenceTimer=null; }
    try{ if(this.rec) this.rec.stop(); }catch{}
    this.rec=null;
    this.running=false;
  }
}
